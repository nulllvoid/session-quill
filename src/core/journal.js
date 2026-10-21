import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, renameAtomic } from '../lib/atomic-fs.js';
import { nowIso } from '../lib/time.js';
import { TrackerError } from '../lib/errors.js';

const NEWLINE = 0x0a;

function readRange(fd, start, length) {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, start + got);
    if (n === 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

// The line that ends exactly at byteOffset (its newline is the byte before the offset), or null.
function lineEndingAt(fd, byteOffset) {
  let span = Math.min(byteOffset, 64 * 1024);
  for (;;) {
    const buf = readRange(fd, byteOffset - span, span);
    if (buf.length !== span || buf[span - 1] !== NEWLINE) return null;
    const start = buf.lastIndexOf(NEWLINE, span - 2);
    if (start >= 0) return buf.subarray(start + 1, span - 1);
    if (span === byteOffset) return buf.subarray(0, span - 1);
    span = Math.min(byteOffset, span * 4);
  }
}

// Whether a state checkpoint's resume point (ADR 0030) still describes this journal: the file is at
// least byteOffset long and the line ending there is the event with lastEventId and sequence. A
// truncated, rewritten or recovered journal fails this and is replayed in full. Read-only.
export function checkResumePoint(file, { byteOffset, sequence, lastEventId }) {
  if (!Number.isInteger(byteOffset) || byteOffset < 1 || !Number.isInteger(sequence) || sequence < 1) return { ok: false, reason: 'malformed resume point' };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'the journal is missing' : `the journal is unreadable (${err.code ?? err.message})` };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < byteOffset) return { ok: false, reason: `the journal is shorter than the checkpoint offset (${size} < ${byteOffset} bytes)` };
    const line = lineEndingAt(fd, byteOffset);
    if (!line) return { ok: false, reason: 'the checkpoint offset is not at the end of a journal line (journal truncated or edited)' };
    let ev = null;
    try { ev = JSON.parse(line.toString('utf8')); } catch { /* reported below */ }
    if (!ev || ev.event_id !== lastEventId || ev.sequence !== sequence) {
      return { ok: false, reason: 'the event at the checkpoint offset is not its last event (journal truncated or edited)' };
    }
    return { ok: true, size };
  } finally {
    fs.closeSync(fd);
  }
}

// Append-only JSONL journal. The worker assigns sequences, appends, fsyncs, and only then
// acknowledges ingestion (TRD §Durability 3). A torn final line is quarantined; corruption in
// the middle stops replay and must be repaired explicitly (TRD §Durability 6).
export class Journal {
  constructor(file, { clock } = {}) {
    this.file = file;
    this.clock = clock;
    this.fd = null;
    this.reset();
  }

  reset() {
    this.lastSequence = 0;
    this.corrupt = false;
    this.eventIds = new Set();
    this.sourceIds = new Set();
    this.byteLength = 0;
    this.lastEventId = null;
  }

  // Checks lines that follow the current position. Returns the index of a torn final line (it does
  // not parse and the text had no final newline), -1 when every line is good; a line that does not
  // parse elsewhere, or is out of sequence, marks the journal corrupt.
  scan(lines, { lastMayBeTorn }) {
    const lastIdx = lines.length - 1;
    for (let i = 0; i < lines.length; i += 1) {
      let ev;
      try {
        ev = JSON.parse(lines[i]);
      } catch {
        if (i === lastIdx && lastMayBeTorn) return i;
        this.corrupt = true;
        return -1;
      }
      if (!Number.isInteger(ev.sequence) || ev.sequence !== this.lastSequence + 1) {
        this.corrupt = true;
        return -1;
      }
      this.lastSequence = ev.sequence;
      this.lastEventId = ev.event_id;
      this.eventIds.add(ev.event_id);
      this.sourceIds.add(ev.source_identity);
    }
    return -1;
  }

  // resume ({ byteOffset, sequence, lastEventId, eventIds, sourceIds }, from a state checkpoint)
  // reads and checks only the lines after byteOffset. When the resume point no longer matches, or a
  // line after it is torn or out of sequence, the whole journal is read as without it (which
  // quarantines a torn tail or reports corruption) and resume_ignored says why.
  open({ resume = null } = {}) {
    ensureDir(path.dirname(this.file));
    let resumeIgnored = null;
    if (resume) {
      const r = this.openResumed(resume);
      if (r.resumed) {
        this.fd = fs.openSync(this.file, 'a');
        return { lastSequence: this.lastSequence, quarantined: false, corrupt: false, resumed: true, tail_events: r.tailEvents };
      }
      resumeIgnored = r.reason;
      this.reset();
    }
    let quarantined = false;
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (text.length) {
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const torn = this.scan(lines, { lastMayBeTorn: !text.endsWith('\n') });
      let goodText = text;
      if (torn >= 0) {
        quarantined = true;
        goodText = lines.slice(0, torn).join('\n') + (torn > 0 ? '\n' : '');
        this.quarantineTail(goodText, lines[torn]);
      }
      this.byteLength = Buffer.byteLength(goodText);
    }
    this.fd = fs.openSync(this.file, 'a');
    const info = { lastSequence: this.lastSequence, quarantined, corrupt: this.corrupt };
    return resume ? { ...info, resumed: false, resume_ignored: resumeIgnored } : info;
  }

  openResumed({ byteOffset, sequence, lastEventId, eventIds = [], sourceIds = [] }) {
    const check = checkResumePoint(this.file, { byteOffset, sequence, lastEventId });
    if (!check.ok) return { resumed: false, reason: check.reason };
    const fd = fs.openSync(this.file, 'r');
    let text;
    try {
      text = readRange(fd, byteOffset, check.size - byteOffset).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    this.lastSequence = sequence;
    this.lastEventId = lastEventId;
    this.eventIds = new Set(eventIds);
    this.sourceIds = new Set(sourceIds);
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const torn = this.scan(lines, { lastMayBeTorn: text.length > 0 && !text.endsWith('\n') });
    if (torn >= 0 || this.corrupt) return { resumed: false, reason: 'a line after the checkpoint is torn or out of sequence' };
    this.byteLength = check.size;
    return { resumed: true, tailEvents: lines.length };
  }

  // Where a state checkpoint taken now would resume: the last sequence, the byte offset just past
  // its line and its event id.
  position() {
    return { sequence: this.lastSequence, byteOffset: this.byteLength, lastEventId: this.lastEventId };
  }

  quarantineTail(goodText, tornLine) {
    const stamp = (this.clock ? nowIso(this.clock) : nowIso()).replace(/[:]/g, '-');
    const qfile = `${this.file}.quarantine-${stamp}`;
    fs.writeFileSync(qfile, tornLine);
    const tmp = `${this.file}.rewrite.tmp`;
    fs.writeFileSync(tmp, goodText);
    renameAtomic(tmp, this.file);
  }

  append(ev) {
    if (this.corrupt) throw new TrackerError('journal-corrupt', 'journal has mid-log corruption; recovery required before new events can be journaled');
    if (this.fd === null) throw new TrackerError('journal-closed', 'journal is not open');
    const sequence = this.lastSequence + 1;
    const record = { ...ev, sequence, ingested_at: this.clock ? nowIso(this.clock) : nowIso() };
    const line = JSON.stringify(record) + '\n';
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
    this.lastSequence = sequence;
    this.byteLength += Buffer.byteLength(line);
    this.lastEventId = record.event_id;
    this.eventIds.add(record.event_id);
    this.sourceIds.add(record.source_identity);
    return record;
  }

  hasEvent(eventId) {
    return this.eventIds.has(eventId);
  }

  hasSource(sourceIdentity) {
    return this.sourceIds.has(sourceIdentity);
  }

  // Every event, or (fromByte, a checkpoint's byte offset) only those after it. Stops before a line
  // that does not parse, such as one the worker is still writing.
  * read({ fromByte = 0 } = {}) {
    let text;
    try {
      if (fromByte > 0) {
        const fd = fs.openSync(this.file, 'r');
        try {
          text = readRange(fd, fromByte, Math.max(0, fs.fstatSync(fd).size - fromByte)).toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      } else {
        text = fs.readFileSync(this.file, 'utf8');
      }
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      yield ev;
    }
  }

  * readTail(fromSequenceExclusive) {
    for (const ev of this.read()) {
      if (ev.sequence > fromSequenceExclusive) yield ev;
    }
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
