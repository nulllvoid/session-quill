import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, renameAtomic } from '../lib/atomic-fs.js';
import { nowIso } from '../lib/time.js';
import { TrackerError } from '../lib/errors.js';

// Append-only JSONL journal. The worker assigns sequences, appends, fsyncs, and only then
// acknowledges ingestion (TRD §Durability 3). A torn final line is quarantined; corruption in
// the middle stops replay and must be repaired explicitly (TRD §Durability 6).
export class Journal {
  constructor(file, { clock } = {}) {
    this.file = file;
    this.clock = clock;
    this.fd = null;
    this.lastSequence = 0;
    this.corrupt = false;
    this.eventIds = new Set();
    this.sourceIds = new Set();
  }

  open() {
    ensureDir(path.dirname(this.file));
    let quarantined = false;
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (text.length) {
      const endsWithNewline = text.endsWith('\n');
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const lastIdx = lines.length - 1;
      for (let i = 0; i < lines.length; i += 1) {
        let ev;
        try {
          ev = JSON.parse(lines[i]);
        } catch {
          if (i === lastIdx && !endsWithNewline) {
            quarantined = true;
            this.quarantineTail(lines.slice(0, i).join('\n') + (i > 0 ? '\n' : ''), lines[i]);
            break;
          }
          this.corrupt = true;
          break;
        }
        if (!Number.isInteger(ev.sequence) || ev.sequence !== this.lastSequence + 1) {
          this.corrupt = true;
          break;
        }
        this.lastSequence = ev.sequence;
        this.eventIds.add(ev.event_id);
        this.sourceIds.add(ev.source_identity);
      }
    }
    this.fd = fs.openSync(this.file, 'a');
    return { lastSequence: this.lastSequence, quarantined, corrupt: this.corrupt };
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
    fs.writeSync(this.fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(this.fd);
    this.lastSequence = sequence;
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

  * read() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
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
