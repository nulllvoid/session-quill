// Shell tokenizer for the run guard's prod classifier (spec §4.2). Pure: no fs, no processes.
// It lexes bash, PowerShell and cmd well enough to find every command a line would run, then
// unwraps wrappers (`sh -c`, `powershell -EncodedCommand`, `cmd /c`, `& exe`, `env`, `xargs`, …)
// so each command is classified on its own. Anything it cannot follow is marked unparseable;
// it never guesses that an opaque command is harmless.

export const MAX_COMMAND = 100_000;
const MAX_NEST = 48;
const MAX_DEPTH = 10;

class ShellParseError extends Error {}

// Word kinds: 'lit' plain text; 'dyn' contains an expansion whose value is unknown; 'group' is
// only a nested command group ($(…), (…), {…}) whose commands were lexed separately.
function newSeg(dialect) {
  return { dialect, argv: [], kinds: [], quoted: [], assign: [], redirects: [], stdin: null, stdinDyn: false, piped: false, call: false, nested: false, env: {}, unparseable: null, pending: null };
}

const PS_SINGLE = new Set(["'", '‘', '’', '‚', '‛']);
const PS_DOUBLE = new Set(['"', '“', '”', '„']);
const PS_DASH = new Set(['–', '—', '―']);
const isPsSpace = (c) => c !== '\n' && c !== '\r' && /\s/.test(c);

class Lexer {
  constructor(src, dialect, nest = 0) {
    this.s = src;
    this.n = src.length;
    this.i = 0;
    this.d = dialect;
    this.out = [];
    this.nest = nest;
    this.heredocs = [];
  }

  fail(msg) { throw new ShellParseError(msg); }

  run() {
    this.list(null);
    return this.out;
  }

  sub(src, dialect = this.d) {
    const lx = new Lexer(src, dialect, this.nest + 1);
    if (lx.nest > MAX_NEST) this.fail('nesting too deep');
    for (const seg of lx.run()) { seg.nested = true; this.out.push(seg); }
  }

  // Lexes a command list until `stop` (')' or '}') or the end of input.
  list(stop) {
    this.nest += 1;
    if (this.nest > MAX_NEST) this.fail('nesting too deep');
    const s = this.s;
    const ps = this.d === 'powershell';
    const cmd = this.d === 'cmd';
    let seg = newSeg(this.d);
    if (this.nest > 1) seg.nested = true;
    let w = null;
    const start = () => { if (!w) w = { text: '', lit: false, dyn: false, group: false, quoted: false, qpos: -1, split: false }; return w; };
    const quote = () => { start(); if (w.qpos < 0) w.qpos = w.text.length; w.quoted = true; };
    const flush = () => {
      if (!w) return;
      const kind = w.split ? 'split' : w.dyn || (w.group && w.lit) ? 'dyn' : w.group ? 'group' : 'lit';
      const word = w;
      w = null;
      if (seg.pending) {
        const op = seg.pending;
        seg.pending = null;
        if (op === '<<' || op === '<<-') {
          this.heredocs.push({ seg, delim: word.text, strip: op === '<<-', quoted: word.quoted });
          seg.stdin = '';
        } else if (op === '<<<') {
          seg.stdin = word.text;
          seg.stdinDyn = kind !== 'lit';
        } else seg.redirects.push({ op, target: word.text, kind });
        return;
      }
      if (ps && kind === 'lit' && !word.quoted && word.text === '--%') {
        // Stop-parsing token: the rest of the line is passed verbatim.
        let j = s.indexOf('\n', this.i);
        if (j < 0) j = this.n;
        for (const t of s.slice(this.i, j).split(/\s+/).filter(Boolean)) { seg.argv.push(t); seg.kinds.push('lit'); seg.quoted.push(false); seg.assign.push(false); }
        this.i = j;
        return;
      }
      seg.argv.push(word.text);
      seg.kinds.push(kind);
      seg.quoted.push(word.qpos === 0);
      const eq = word.text.indexOf('=');
      seg.assign.push(eq > 0 && (word.qpos < 0 || eq < word.qpos) && /^[A-Za-z_][A-Za-z0-9_]*\+?$/.test(word.text.slice(0, eq)));
    };
    const end = (piped) => {
      flush();
      if (seg.pending) this.fail('redirect without a target');
      if (seg.argv.length || seg.redirects.length || seg.stdin !== null || seg.call) this.out.push(seg);
      seg = newSeg(this.d);
      if (this.nest > 1) seg.nested = true;
      seg.piped = piped;
    };
    const group = (open, close, label) => {
      start();
      this.i += open;
      this.list(close);
      w.group = true;
      w.text += label;
    };
    const redirect = (c) => {
      let fd = '';
      if (w && !w.quoted && !w.dyn && !w.group && (/^\d+$/.test(w.text) || (ps && w.text === '*'))) { fd = w.text; w = null; } else flush();
      let op;
      if (c === '<') {
        if (!ps && !cmd && s.startsWith('<<<', this.i)) op = '<<<';
        else if (!ps && !cmd && s.startsWith('<<-', this.i)) op = '<<-';
        else if (!ps && !cmd && s.startsWith('<<', this.i)) op = '<<';
        else if (s.startsWith('<&', this.i)) op = '<&';
        else if (s.startsWith('<>', this.i)) op = '<>';
        else op = '<';
      } else if (s.startsWith('>>', this.i)) op = '>>';
      else if (s.startsWith('>&', this.i)) op = '>&';
      else if (s.startsWith('>|', this.i)) op = '>|';
      else op = '>';
      this.i += op.length;
      if (op === '>&' || op === '<&') {
        // fd duplication (2>&1, >&2) is not a file
        const m = /^(\d+|-)/.exec(s.slice(this.i, this.i + 8));
        if (m) { this.i += m[0].length; seg.redirects.push({ op: fd + op, target: `&${m[0]}`, kind: 'lit' }); return; }
      }
      if (ps && s[this.i] === '&' && /\d/.test(s[this.i + 1] ?? '')) {
        seg.redirects.push({ op: fd + op, target: `&${s[this.i + 1]}`, kind: 'lit' });
        this.i += 2;
        return;
      }
      seg.pending = fd + op;
    };

    // --- bash helpers
    const bashDollar = (unq = false) => {
      const nx = s[this.i + 1];
      if (nx === '(') { group(2, ')', '$(…)'); if (unq) w.split = true; return; }
      start();
      if (unq && nx && /[A-Za-z_{0-9@*#?$!-]/.test(nx)) w.split = true;
      if (nx === '{') {
        const j = s.indexOf('}', this.i);
        if (j < 0) this.fail('unterminated ${');
        const inner = s.slice(this.i + 2, j);
        if (/\$\(|`/.test(inner)) this.expansions(inner);
        w.text += s.slice(this.i, j + 1);
        w.dyn = true;
        this.i = j + 1;
        return;
      }
      if (nx && /[A-Za-z_]/.test(nx)) {
        let j = this.i + 1;
        while (j < this.n && /[A-Za-z0-9_]/.test(s[j])) j += 1;
        w.text += s.slice(this.i, j);
        w.dyn = true;
        this.i = j;
        return;
      }
      if (nx && /[0-9@*#?$!-]/.test(nx)) { w.text += s.slice(this.i, this.i + 2); w.dyn = true; this.i += 2; return; }
      w.text += '$';
      w.lit = true;
      this.i += 1;
    };
    const backtick = (unq = false) => {
      let j = this.i + 1;
      while (j < this.n && s[j] !== '`') j += s[j] === '\\' ? 2 : 1;
      if (j >= this.n) this.fail('unterminated backtick');
      this.sub(s.slice(this.i + 1, j).replace(/\\`/g, '`'), 'bash');
      start();
      w.group = true;
      if (unq) w.split = true;
      w.text += '`…`';
      this.i = j + 1;
    };
    const bashDquote = () => {
      quote();
      w.lit = true;
      this.i += 1;
      while (this.i < this.n) {
        const c = s[this.i];
        if (c === '"') { this.i += 1; return; }
        if (c === '\\' && '$`"\\\n'.includes(s[this.i + 1] ?? '')) {
          if (s[this.i + 1] !== '\n') w.text += s[this.i + 1];
          this.i += 2;
          continue;
        }
        if (c === '$') {
          const nx = s[this.i + 1];
          if (nx === '(' || nx === '{' || (nx && /[A-Za-z_0-9@*#?$!-]/.test(nx))) { bashDollar(); continue; }
        }
        if (c === '`') { backtick(); continue; }
        w.text += c;
        this.i += 1;
      }
      this.fail('unterminated double quote');
    };

    // --- PowerShell helpers
    const psDollar = (unq = false) => {
      const nx = s[this.i + 1];
      if (nx === '(') { group(2, ')', '$(…)'); if (unq) w.split = true; return; }
      start();
      if (unq && nx && /[A-Za-z_{?^$]/.test(nx)) w.split = true;
      if (nx === '{') {
        const j = s.indexOf('}', this.i);
        if (j < 0) this.fail('unterminated ${');
        w.text += s.slice(this.i, j + 1);
        w.dyn = true;
        this.i = j + 1;
        return;
      }
      if (nx && /[A-Za-z_?^$]/.test(nx)) {
        let j = this.i + 1;
        while (j < this.n && /[A-Za-z0-9_:?^$]/.test(s[j])) {
          if (s[j] === ':' && s[j + 1] === ':') break;
          j += 1;
        }
        w.text += s.slice(this.i, j);
        w.dyn = true;
        this.i = j;
        return;
      }
      w.text += '$';
      w.lit = true;
      this.i += 1;
    };
    const psDquote = () => {
      quote();
      w.lit = true;
      this.i += 1;
      while (this.i < this.n) {
        const c = s[this.i];
        if (PS_DOUBLE.has(c)) {
          if (PS_DOUBLE.has(s[this.i + 1] ?? '')) { w.text += '"'; this.i += 2; continue; }
          this.i += 1;
          return;
        }
        if (c === '`') { w.text += psEscape(s[this.i + 1] ?? ''); this.i += 2; continue; }
        if (c === '$') {
          const nx = s[this.i + 1];
          if (nx === '(' || nx === '{' || (nx && /[A-Za-z_?^$]/.test(nx))) { psDollar(); continue; }
        }
        w.text += c;
        this.i += 1;
      }
      this.fail('unterminated double quote');
    };
    const psSquote = () => {
      quote();
      w.lit = true;
      this.i += 1;
      while (this.i < this.n) {
        const c = s[this.i];
        if (PS_SINGLE.has(c)) {
          if (PS_SINGLE.has(s[this.i + 1] ?? '')) { w.text += "'"; this.i += 2; continue; }
          this.i += 1;
          return;
        }
        w.text += c;
        this.i += 1;
      }
      this.fail('unterminated single quote');
    };
    const psHereString = (q) => {
      const close = `\n${q}@`;
      const j = s.indexOf(close, this.i + 2);
      if (j < 0) this.fail('unterminated here-string');
      const body = s.slice(this.i + 3, j).replace(/\r$/, '');
      quote();
      w.lit = true;
      w.text += body;
      if (q === '"' && /\$/.test(body)) { w.dyn = true; if (/\$\(/.test(body)) this.expansions(body); }
      this.i = j + close.length;
    };

    while (this.i < this.n) {
      const c = s[this.i];
      if (stop && c === stop) {
        end(false);
        this.i += 1;
        this.nest -= 1;
        return;
      }
      if (c === '\n') {
        end(false);
        this.i += 1;
        if (this.heredocs.length) this.readHeredocs();
        continue;
      }
      if (c === '\r') { this.i += 1; continue; }

      if (ps) {
        if (isPsSpace(c)) { flush(); this.i += 1; continue; }
        if (c === '#' && !w) { while (this.i < this.n && s[this.i] !== '\n') this.i += 1; continue; }
        if (c === '<' && s[this.i + 1] === '#' && !w) {
          const j = s.indexOf('#>', this.i + 2);
          if (j < 0) this.fail('unterminated block comment');
          this.i = j + 2;
          continue;
        }
        if (c === '`') {
          if (s[this.i + 1] === '\n' || (s[this.i + 1] === '\r' && s[this.i + 2] === '\n')) { this.i += s[this.i + 1] === '\r' ? 3 : 2; continue; }
          start();
          w.text += psEscape(s[this.i + 1] ?? '');
          w.lit = true;
          this.i += 2;
          continue;
        }
        if (PS_SINGLE.has(c)) { psSquote(); continue; }
        if (PS_DOUBLE.has(c)) { psDquote(); continue; }
        if (c === '@' && (s[this.i + 1] === "'" || s[this.i + 1] === '"') && /^\r?\n/.test(s.slice(this.i + 2, this.i + 4))) { psHereString(s[this.i + 1]); continue; }
        if (c === '@' && s[this.i + 1] === '(') { group(2, ')', '@(…)'); continue; }
        if (c === '@' && s[this.i + 1] === '{') { group(2, '}', '@{…}'); continue; }
        if (c === '$') { psDollar(true); continue; }
        if (c === '@' && /[A-Za-z_]/.test(s[this.i + 1] ?? '') && !w) {
          // splatting: parameters come from a variable
          let j = this.i + 1;
          while (j < this.n && /\w/.test(s[j])) j += 1;
          start();
          w.text += s.slice(this.i, j);
          w.dyn = true;
          w.split = true;
          this.i = j;
          continue;
        }
        if (c === '(') { group(1, ')', '(…)'); continue; }
        if (c === '{') { group(1, '}', '{…}'); continue; }
        if (c === ')' || c === '}') this.fail(`unbalanced ${c}`);
        if (c === ';') { end(false); this.i += 1; continue; }
        if (c === '|') {
          if (s[this.i + 1] === '|') { end(false); this.i += 2; continue; }
          end(true);
          this.i += 1;
          continue;
        }
        if (c === '&') {
          if (s[this.i + 1] === '&') { end(false); this.i += 2; continue; }
          if (!w && seg.argv.length === 0 && !seg.call) { seg.call = true; this.i += 1; continue; }
          end(false);
          this.i += 1;
          continue;
        }
        if (c === '>' || c === '<') { redirect(c); continue; }
        if (PS_DASH.has(c) && !w) { start(); w.text += '-'; w.lit = true; this.i += 1; continue; }
        start();
        w.text += c;
        w.lit = true;
        this.i += 1;
        continue;
      }

      if (cmd) {
        if (c === ' ' || c === '\t') { flush(); this.i += 1; continue; }
        if (c === '^') {
          if (s[this.i + 1] === '\n') { this.i += 2; continue; }
          start();
          w.text += s[this.i + 1] ?? '';
          w.lit = true;
          this.i += 2;
          continue;
        }
        if (c === '"') {
          const j = s.indexOf('"', this.i + 1);
          if (j < 0) this.fail('unterminated double quote');
          quote();
          const inner = s.slice(this.i + 1, j);
          w.text += inner;
          w.lit = true;
          if (/%[A-Za-z_][\w]*%|![A-Za-z_][\w]*!/.test(inner)) w.dyn = true;
          this.i = j + 1;
          continue;
        }
        if (c === '%') {
          const m = /^%(~[a-z]*\d|[A-Za-z_][\w]*%)/.exec(s.slice(this.i, this.i + 256));
          start();
          if (m) { w.text += m[0]; w.dyn = true; this.i += m[0].length; continue; }
          w.text += c;
          w.lit = true;
          this.i += 1;
          continue;
        }
        if (c === '(' && !w) { group(1, ')', '(…)'); continue; }
        if (c === '&') {
          end(false);
          this.i += s[this.i + 1] === '&' ? 2 : 1;
          continue;
        }
        if (c === '|') {
          if (s[this.i + 1] === '|') { end(false); this.i += 2; continue; }
          end(true);
          this.i += 1;
          continue;
        }
        if (c === '>' || c === '<') { redirect(c); continue; }
        start();
        w.text += c;
        w.lit = true;
        this.i += 1;
        continue;
      }

      // bash
      if (c === ' ' || c === '\t') { flush(); this.i += 1; continue; }
      if (c === '#' && !w) { while (this.i < this.n && s[this.i] !== '\n') this.i += 1; continue; }
      if (c === '\\') {
        if (s[this.i + 1] === '\n') { this.i += 2; continue; }
        if (s[this.i + 1] === '\r' && s[this.i + 2] === '\n') { this.i += 3; continue; }
        quote();
        w.text += this.i + 1 < this.n ? s[this.i + 1] : '\\';
        w.lit = true;
        this.i += 2;
        continue;
      }
      if (c === "'") {
        const j = s.indexOf("'", this.i + 1);
        if (j < 0) this.fail('unterminated single quote');
        quote();
        w.text += s.slice(this.i + 1, j);
        w.lit = true;
        this.i = j + 1;
        continue;
      }
      if (c === '"') { bashDquote(); continue; }
      if (c === '`') { backtick(true); continue; }
      if (c === '$') {
        if (s[this.i + 1] === "'") {
          let j = this.i + 2;
          let text = '';
          while (j < this.n && s[j] !== "'") {
            if (s[j] === '\\' && j + 1 < this.n) { text += ansiEscape(s[j + 1]); j += 2; continue; }
            text += s[j];
            j += 1;
          }
          if (j >= this.n) this.fail("unterminated $'");
          quote();
          w.text += text;
          w.lit = true;
          this.i = j + 1;
          continue;
        }
        if (s[this.i + 1] === '"') { this.i += 1; bashDquote(); continue; }
        bashDollar(true);
        continue;
      }
      if (c === '(') {
        // subshell: its commands are lexed as their own segments; `name()` starts a function
        // definition, so the body that follows is a segment of its own
        const hadWords = seg.argv.length > 0 || w !== null;
        flush();
        this.i += 1;
        this.list(')');
        if (hadWords) end(false);
        continue;
      }
      if (c === ')') this.fail('unbalanced )');
      if (c === ';') {
        end(false);
        this.i += 1;
        if (s[this.i] === ';' || s[this.i] === '&') this.i += 1;
        continue;
      }
      if (c === '&') {
        if (s[this.i + 1] === '&') { end(false); this.i += 2; continue; }
        if (s[this.i + 1] === '>') {
          flush();
          const op = s[this.i + 2] === '>' ? '&>>' : '&>';
          this.i += op.length;
          seg.pending = op;
          continue;
        }
        end(false);
        this.i += 1;
        continue;
      }
      if (c === '|') {
        if (s[this.i + 1] === '|') { end(false); this.i += 2; continue; }
        end(true);
        this.i += s[this.i + 1] === '&' ? 2 : 1;
        continue;
      }
      if ((c === '<' || c === '>') && s[this.i + 1] === '(') {
        group(2, ')', `${c}(…)`);
        continue;
      }
      if (c === '<' || c === '>') { redirect(c); continue; }
      start();
      w.text += c;
      w.lit = true;
      this.i += 1;
    }
    if (stop) this.fail(`unterminated group (missing ${stop})`);
    end(false);
    if (this.heredocs.length) this.readHeredocs();
    this.nest -= 1;
  }

  readHeredocs() {
    const s = this.s;
    for (const h of this.heredocs) {
      let body = '';
      while (this.i < this.n) {
        let j = s.indexOf('\n', this.i);
        const last = j < 0;
        if (last) j = this.n;
        const line = s.slice(this.i, j).replace(/\r$/, '');
        this.i = last ? this.n : j + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        body += `${line}\n`;
      }
      h.seg.stdin = body;
      if (!h.quoted && /\$|`/.test(body)) {
        h.seg.stdinDyn = true;
        if (/\$\(|`/.test(body)) this.expansions(body);
      }
    }
    this.heredocs = [];
  }

  // Command substitutions inside text that is otherwise data (heredoc bodies, ${…}).
  expansions(text) {
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (c === '\\') { i += 1; continue; }
      if (c === '$' && text[i + 1] === '(') {
        const lx = new Lexer(text, this.d === 'powershell' ? 'powershell' : 'bash', this.nest + 1);
        lx.i = i + 2;
        lx.list(')');
        for (const seg of lx.out) { seg.nested = true; this.out.push(seg); }
        i = lx.i - 1;
        continue;
      }
      if (c === '`' && this.d !== 'powershell') {
        let j = i + 1;
        while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1;
        if (j >= text.length) this.fail('unterminated backtick');
        this.sub(text.slice(i + 1, j), 'bash');
        i = j;
      }
    }
  }
}

function psEscape(c) {
  return { n: '\n', t: '\t', r: '\r', 0: '\0', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b' }[c] ?? c;
}

function ansiEscape(c) {
  return { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' }[c] ?? `\\${c}`;
}

function lex(src, dialect, nest = 0) {
  return new Lexer(src, dialect, nest).run();
}

// Normalised program name: basename, lower case, Windows shim extensions removed.
export function binName(word) {
  if (typeof word !== 'string') return '';
  return word.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

const PS_DANGER_RE = /(\.|::)(invoke\w*|newscriptblock|upload\w*|download\w*|send\w*|start|execute\w*|post\w*|put\w*|delete\w*|write\w*|append\w*|open\w*|connect\w*|getresponse\w*|run\w*|create\w*|exec\w*|copy\w*|move\w*|replacefile)\s*\(/i;
const BASH_KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'fish', 'busybox']);
const POWERSHELLS = new Set(['powershell', 'pwsh', 'powershell_ise']);
const PASSTHROUGH = new Set(['nohup', 'exec', 'builtin', 'unbuffer', 'chronic', 'noglob', 'stdbuf', 'caffeinate', 'nice', 'ionice', 'doas', 'sudo', 'time', 'command', 'sshpass', 'winpty', 'strace', 'ltrace']);
const PASS_VALUE_OPTS = {
  sudo: new Set(['-u', '-g', '-C', '-p', '-h', '-U', '-r', '-t', '-D', '-R', '-T']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '--class', '--classdata']),
  stdbuf: new Set(['-i', '-o', '-e']),
  sshpass: new Set(['-p', '-f', '-d', '-P']),
  strace: new Set(['-e', '-o', '-p', '-s', '-u', '-E']),
  ltrace: new Set(['-e', '-o', '-p', '-s', '-u']),
  time: new Set(['-f', '-o', '--format', '--output']),
};
const XARGS_VALUE = new Set(['-I', '-i', '-n', '-P', '-d', '-L', '-l', '-E', '-e', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace', '--max-lines', '--eof', '--max-chars']);
const PS_VALUE_PARAMS = ['executionpolicy', 'windowstyle', 'version', 'psconsolefile', 'configurationname', 'inputformat', 'outputformat', 'workingdirectory', 'custompipename', 'settingsfile', 'encodedarguments'];

function looksBase64(v) {
  return typeof v === 'string' && v.length > 0 && v.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
}

function decodePsBase64(v) {
  if (!looksBase64(v)) return null;
  const buf = Buffer.from(v, 'base64');
  if (buf.length % 2 !== 0) return null;
  const text = buf.toString('utf16le');
  if (/[\u0000�]/.test(text)) return null;
  return text;
}

// Expands one lexed segment into the commands it would actually run.
function expand(seg, depth, out) {
  if (seg.unparseable) { out.push(seg); return; }
  if (depth > MAX_DEPTH) { out.push({ ...seg, unparseable: 'wrappers nested too deeply' }); return; }
  const a = seg.argv.slice();
  const k = seg.kinds.slice();
  const q = seg.quoted.slice();
  const as = (seg.assign ?? []).slice();
  const env = { ...seg.env };
  let call = seg.call;
  const shift = (n = 1) => { a.splice(0, n); k.splice(0, n); q.splice(0, n); as.splice(0, n); };
  const bad = (reason) => out.push({ ...seg, argv: a.slice(), kinds: k.slice(), quoted: q.slice(), env, unparseable: reason });
  const redirectsOnly = () => { if (seg.redirects.length) out.push({ ...seg, argv: [], kinds: [], quoted: [], stdin: null }); };
  const script = (text, dialect) => {
    redirectsOnly();
    let segs;
    try { segs = lex(text, dialect); } catch (e) {
      if (e instanceof ShellParseError) { out.push({ ...newSeg(dialect), unparseable: e.message }); return; }
      throw e;
    }
    for (const s2 of segs) expand(s2, depth + 1, out);
  };
  const ps = seg.dialect === 'powershell';
  if (ps) {
    for (let x = 0; x < a.length; x += 1) {
      if (k[x] === 'split' && /^@\w/.test(a[x])) { bad('splatted parameters are not visible'); return; }
      if (PS_DANGER_RE.test(a[x]) && !/^\[(system\.)?console\]::/i.test(a[x])) { bad('.NET method call that can run code, send data or write files'); return; }
    }
  }

  for (let guard = 0; guard < 64; guard += 1) {
    if (!a.length) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env }); return; }
    const w0 = a[0];
    // group words and keywords that only structure the line
    if (!ps && k[0] === 'lit' && !q[0] && BASH_KEYWORDS.has(w0)) { shift(); continue; }
    if (!ps && k[0] === 'lit' && !q[0] && w0 === 'function' && a.length > 1) { shift(2); continue; }
    if (!ps && !call && k[0] !== 'group' && as[0]) {
      const eq = w0.indexOf('=');
      env[w0.slice(0, eq).replace(/\+$/, '')] = k[0] === 'lit' ? w0.slice(eq + 1) : null;
      shift();
      continue;
    }
    if (ps && !call) {
      if (/^\$[\w:{}]+\s*[+\-*/]?=/.test(w0)) {
        const m = /^\$(?:env:)?([\w]+)=(.*)$/i.exec(w0);
        if (m && /^\$env:/i.test(w0)) env[m[1]] = m[2];
        shift();
        continue;
      }
      if (w0.startsWith('$') && a.length > 1 && /^[+\-*/]?=$/.test(a[1])) { shift(2); continue; }
      if (q[0] || w0.startsWith('$') || k[0] === 'group' || /^[\d.]+$/.test(w0) || w0.startsWith('@')) {
        // an expression, not a command; nested groups were lexed separately
        out.push({ ...seg, argv: [], kinds: [], quoted: [], env });
        return;
      }
      if (w0.startsWith('[')) {
        if (/(file|directory|path)\]::(write|append|delete|move|copy|create|replace|open|setattributes)/i.test(a.join(' '))) { bad('.NET file API call; its target is not tracked'); return; }
        out.push({ ...seg, argv: [], kinds: [], quoted: [], env });
        return;
      }
    }
    if ((w0 === '.' || w0 === '&') && k[0] === 'lit' && !q[0] && a.length > 1) {
      if (ps) { call = true; shift(); continue; }
      if (w0 === '.') { a[0] = 'source'; }
    }
    if (call && k[0] === 'group' && a[0] === '{…}') { out.push({ ...seg, argv: [], kinds: [], quoted: [], env }); return; }
    if (k[0] !== 'lit') { bad('the program name is not a literal'); return; }

    const name = binName(w0);
    const rest = () => a.slice(1);

    if (PASSTHROUGH.has(name)) {
      if (name === 'command' && /^-[vV]$/.test(a[1] ?? '')) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env }); return; }
      const vals = PASS_VALUE_OPTS[name] ?? new Set();
      let j = 1;
      while (j < a.length && a[j].startsWith('-') && a[j] !== '-') {
        if (a[j] === '--') { j += 1; break; }
        if (vals.has(a[j])) j += 1;
        j += 1;
      }
      if (name === 'nice' && /^-\d+$/.test(a[1] ?? '')) j = Math.max(j, 2);
      if (j >= a.length) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env }); return; }
      shift(j);
      continue;
    }
    if (name === 'timeout') {
      let j = 1;
      while (j < a.length && a[j].startsWith('-')) { if (a[j] === '-s' || a[j] === '-k' || a[j] === '--signal' || a[j] === '--kill-after') j += 1; j += 1; }
      j += 1; // duration
      if (j >= a.length) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env }); return; }
      shift(j);
      continue;
    }
    if (name === 'env') {
      let j = 1;
      while (j < a.length) {
        const t = a[j];
        if (t === '--') { j += 1; break; }
        if (t === '-u' || t === '--unset' || t === '-C' || t === '--chdir') { j += 2; continue; }
        if (t === '-S' || t === '--split-string') { const str = a[j + 1]; if (k[j + 1] !== 'lit') { bad('env -S with a dynamic string'); return; } script(str ?? '', 'bash'); return; }
        if (t.startsWith('-')) { j += 1; continue; }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { const eq = t.indexOf('='); env[t.slice(0, eq)] = k[j] === 'lit' ? t.slice(eq + 1) : null; j += 1; continue; }
        break;
      }
      if (j >= a.length) { out.push({ ...seg, argv: [], kinds: [], quoted: [], env }); return; }
      shift(j);
      continue;
    }
    if (name === 'xargs') {
      let j = 1;
      let repl = null;
      while (j < a.length && a[j].startsWith('-')) {
        const t = a[j];
        if (t === '--') { j += 1; break; }
        if (t === '-I' || t === '--replace') { repl = a[j + 1]; j += 2; continue; }
        if (t.startsWith('-I') && t.length > 2) { repl = t.slice(2); j += 1; continue; }
        if (t.startsWith('--replace=')) { repl = t.slice(10); j += 1; continue; }
        if (XARGS_VALUE.has(t)) { j += 2; continue; }
        j += 1;
      }
      if (j >= a.length) { a.splice(0, a.length, 'echo'); k.splice(0, k.length, 'lit'); q.splice(0, q.length, false); continue; }
      shift(j);
      for (let x = 0; x < a.length; x += 1) if (repl && a[x].includes(repl)) k[x] = 'dyn';
      if (!repl) { a.push('{xargs}'); k.push('dyn'); q.push(false); }
      seg = { ...seg, piped: false };
      continue;
    }
    if (name === 'watch') {
      let j = 1;
      while (j < a.length && a[j].startsWith('-')) { if (a[j] === '-n' || a[j] === '--interval' || a[j] === '-q' || a[j] === '--equexit') j += 1; j += 1; }
      if (j >= a.length) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env }); return; }
      if (k.slice(j).some((x) => x !== 'lit')) { bad('watch with a dynamic command'); return; }
      script(a.slice(j).join(' '), 'bash');
      return;
    }
    if (name === 'npx' || name === 'pnpx' || name === 'bunx' || name === 'uvx' || (name === 'npm' && (a[1] === 'exec' || a[1] === 'x')) || ((name === 'pnpm' || name === 'yarn') && (a[1] === 'dlx' || a[1] === 'exec')) || (name === 'pipx' && a[1] === 'run')) {
      let j = (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'pipx') ? 2 : 1;
      while (j < a.length && a[j].startsWith('-')) {
        const t = a[j];
        if (t === '--') { j += 1; break; }
        if (t === '-c' || t === '--call') { if (k[j + 1] !== 'lit') { bad('npx -c with a dynamic command'); return; } script(a[j + 1] ?? '', 'bash'); return; }
        if (t === '-p' || t === '--package' || t === '--from' || t === '-w' || t === '--workspace') { j += 2; continue; }
        j += 1;
      }
      if (j >= a.length) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env }); return; }
      shift(j);
      // npx package specs: session-quill@1.2 → session-quill
      a[0] = a[0].replace(/^(@?[^@]+)@.*$/, '$1');
      continue;
    }
    if (SHELLS.has(name)) {
      if (name === 'busybox') { if (a.length > 1 && SHELLS.has(binName(a[1]))) { shift(); continue; } out.push({ ...seg, argv: a, kinds: k, quoted: q, env }); return; }
      let j = 1;
      let cflag = false;
      let stdinFlag = false;
      while (j < a.length) {
        const t = a[j];
        if (t === '--' || t === '-') { j += 1; break; }
        if (/^-o$|^-O$|^\+O$|^--rcfile$|^--init-file$/.test(t)) { j += 2; continue; }
        if (/^[-+][a-zA-Z]+$/.test(t)) { if (t.startsWith('-') && t.includes('c')) cflag = true; if (t.startsWith('-') && t.includes('s')) stdinFlag = true; j += 1; continue; }
        if (t.startsWith('--')) { if (t === '--command') cflag = true; j += 1; continue; }
        break;
      }
      if (cflag) {
        if (j >= a.length) { bad('shell -c without a command'); return; }
        if (k[j] !== 'lit') { bad('shell -c with a dynamic command'); return; }
        script(a[j], 'bash');
        return;
      }
      if (j < a.length && !stdinFlag) {
        out.push({ ...seg, argv: a, kinds: k, quoted: q, env, script: a[j], scriptKind: k[j], scriptArgs: a.slice(j + 1) });
        return;
      }
      if (seg.stdin !== null) {
        if (seg.stdinDyn) { bad('shell input contains expansions'); return; }
        script(seg.stdin, 'bash');
        return;
      }
      if (seg.piped) { bad('input is piped into a shell'); return; }
      const inFile = seg.redirects.find((r) => r.op === '<');
      if (inFile) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env, script: inFile.target, scriptKind: inFile.kind, scriptArgs: [] }); return; }
      out.push({ ...seg, argv: a, kinds: k, quoted: q, env });
      return;
    }
    if (POWERSHELLS.has(name)) {
      let j = 1;
      while (j < a.length) {
        const t = a[j];
        if (!(t.startsWith('-') || t.startsWith('/')) || t === '-') break;
        const p = t.slice(1).toLowerCase().replace(/:.*$/, '');
        if (p === 'e' || p === 'ec' || (p.length >= 2 && 'encodedcommand'.startsWith(p))) {
          const text = decodePsBase64(a[j + 1]);
          if (text === null) { bad('encoded command does not decode'); return; }
          script(text, 'powershell');
          return;
        }
        if (p.length >= 1 && 'command'.startsWith(p)) {
          const parts = a.slice(j + 1);
          if (!parts.length || parts[0] === '-') {
            if (seg.stdin !== null && !seg.stdinDyn) { script(seg.stdin, 'powershell'); return; }
            bad('PowerShell reads its command from input');
            return;
          }
          if (k.slice(j + 1).some((x) => x !== 'lit')) { bad('PowerShell -Command with a dynamic command'); return; }
          script(parts.join(' '), 'powershell');
          return;
        }
        if (p.length >= 1 && 'file'.startsWith(p)) {
          out.push({ ...seg, argv: a, kinds: k, quoted: q, env, script: a[j + 1], scriptKind: k[j + 1] ?? 'dyn', scriptArgs: a.slice(j + 2) });
          return;
        }
        if (PS_VALUE_PARAMS.some((v) => p.length >= 2 && v.startsWith(p)) || p === 'ep' || p === 'ex' || p === 'w' || p === 'wd' || p === 'v') { j += 2; continue; }
        j += 1;
      }
      if (j < a.length) {
        if (name === 'pwsh' && /\.ps1$/i.test(a[j])) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env, script: a[j], scriptKind: k[j], scriptArgs: a.slice(j + 1) }); return; }
        if (k.slice(j).some((x) => x !== 'lit')) { bad('PowerShell command is dynamic'); return; }
        script(a.slice(j).join(' '), 'powershell');
        return;
      }
      if (seg.stdin !== null && !seg.stdinDyn) { script(seg.stdin, 'powershell'); return; }
      if (seg.piped) { bad('input is piped into PowerShell'); return; }
      out.push({ ...seg, argv: a, kinds: k, quoted: q, env });
      return;
    }
    if (name === 'cmd') {
      let j = 1;
      let run = false;
      while (j < a.length && a[j].startsWith('/')) {
        const sw = a[j].toLowerCase();
        j += 1;
        if (sw === '/c' || sw === '/k' || sw === '/r') { run = true; break; }
        if (/^\/[ck]./.test(sw)) { a.splice(j, 0, a[j - 1].slice(2)); k.splice(j, 0, 'lit'); q.splice(j, 0, false); run = true; break; }
      }
      if (run) {
        if (j >= a.length) { out.push({ ...seg, argv: [], kinds: [], quoted: [], env }); return; }
        if (k.slice(j).some((x) => x === 'group' || x === 'split' || (seg.dialect !== 'cmd' && x !== 'lit'))) { bad('cmd /c with a dynamic command'); return; }
        script(a.slice(j).join(' '), 'cmd');
        return;
      }
      if (seg.piped) { bad('input is piped into cmd'); return; }
      out.push({ ...seg, argv: a, kinds: k, quoted: q, env });
      return;
    }
    if (name === 'eval') {
      if (a.length === 1) { out.push({ ...seg, argv: [], kinds: [], quoted: [], env }); return; }
      if (k.slice(1).some((x) => x !== 'lit')) { bad('eval of a dynamic string'); return; }
      script(rest().join(' '), 'bash');
      return;
    }
    if (ps && (name === 'invoke-expression' || name === 'iex')) {
      const from = a.length > 1 && /^-c/i.test(a[1]) ? 2 : 1;
      const args = a.slice(from);
      const kinds = k.slice(from);
      if (!args.length) { bad(seg.piped ? 'input is piped into Invoke-Expression' : 'Invoke-Expression without a string'); return; }
      if (kinds.some((x) => x !== 'lit')) { bad('Invoke-Expression of a dynamic string'); return; }
      script(args.join(' '), 'powershell');
      return;
    }
    if (ps && (name === 'start-process' || name === 'saps' || name === 'start')) {
      let file = null;
      let fileKind = 'lit';
      let argList = [];
      let argKinds = [];
      const pos = [];
      for (let j = 1; j < a.length; j += 1) {
        const t = a[j];
        if (t.startsWith('-')) {
          const p = t.slice(1).toLowerCase();
          if ('filepath'.startsWith(p) || p === 'path') { file = a[j + 1]; fileKind = k[j + 1]; j += 1; continue; }
          if ('argumentlist'.startsWith(p) || p === 'args') { argList = a[j + 1] === undefined ? [] : [a[j + 1]]; argKinds = [k[j + 1]]; j += 1; continue; }
          if (['workingdirectory', 'verb', 'windowstyle', 'redirectstandardoutput', 'redirectstandardinput', 'redirectstandarderror', 'credential'].some((v) => p.length >= 2 && v.startsWith(p))) { j += 1; continue; }
          continue;
        }
        pos.push(j);
      }
      if (file === null && pos.length) { file = a[pos[0]]; fileKind = k[pos[0]]; if (pos.length > 1 && !argList.length) { argList = pos.slice(1).map((x) => a[x]); argKinds = pos.slice(1).map((x) => k[x]); } }
      if (file === null) { bad('Start-Process without a program'); return; }
      if (fileKind !== 'lit' || argKinds.some((x) => x !== 'lit')) { bad('Start-Process with a dynamic program or arguments'); return; }
      const inner = [file, ...argList.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean)].map(quoteForBash).join(' ');
      script(inner, 'bash');
      return;
    }
    if (!ps && seg.dialect === 'cmd' && name === 'start') {
      let j = 1;
      while (j < a.length && (a[j].startsWith('/') || (j === 1 && q[j]))) j += a[j].toLowerCase() === '/d' ? 2 : 1;
      if (j >= a.length) { out.push({ ...seg, argv: [], kinds: [], quoted: [], env }); return; }
      shift(j);
      continue;
    }
    if (name === 'wsl') {
      let j = 1;
      while (j < a.length && a[j].startsWith('-')) {
        const t = a[j];
        if (t === '--' || t === '-e' || t === '--exec') { j += 1; break; }
        if (t === '-d' || t === '--distribution' || t === '-u' || t === '--user' || t === '--cd') { j += 2; continue; }
        j += 1;
      }
      if (j >= a.length) { out.push({ ...seg, argv: [], kinds: [], quoted: [], env }); return; }
      shift(j);
      continue;
    }
    if (name === 'find') {
      for (let j = 1; j < a.length; j += 1) {
        if (/^-(exec|execdir|ok|okdir)$/.test(a[j])) {
          let e = j + 1;
          while (e < a.length && a[e] !== ';' && a[e] !== '+') e += 1;
          const argv = a.slice(j + 1, e);
          const kinds = k.slice(j + 1, e).map((x, i) => (argv[i].includes('{}') ? 'dyn' : x));
          if (argv.length) expand({ ...newSeg(seg.dialect), argv, kinds, quoted: q.slice(j + 1, e), nested: seg.nested }, depth + 1, out);
          j = e;
        }
      }
      out.push({ ...seg, argv: a, kinds: k, quoted: q, env });
      return;
    }
    out.push({ ...seg, argv: a, kinds: k, quoted: q, env, call });
    return;
  }
  bad('too many wrappers');
}

function quoteForBash(t) {
  return /^[A-Za-z0-9_./:=@%+,\\-]+$/.test(t) ? t.replace(/\\/g, '\\\\') : `'${t.replace(/'/g, "'\\''")}'`;
}

// Internal: lexes and unwraps; { segments } or { error }.
export function parseShell(command, shell = 'bash', nest = 0) {
  const dialect = shell === 'powershell' ? 'powershell' : shell === 'cmd' ? 'cmd' : 'bash';
  if (typeof command !== 'string') return { error: 'command is not a string' };
  if (command.length > MAX_COMMAND) return { error: 'command too long to classify' };
  let segs;
  try { segs = lex(command, dialect, nest); } catch (e) {
    if (e instanceof ShellParseError || e instanceof RangeError) return { error: e.message };
    throw e;
  }
  const out = [];
  try { for (const seg of segs) expand(seg, 0, out); } catch (e) {
    if (e instanceof RangeError) return { error: 'nesting too deep' };
    throw e;
  }
  return { segments: out };
}

// Segments (argv lists) after unwrapping; null when the command cannot be parsed or a part of
// it is unparseable.
export function tokenize(command, shell = 'bash') {
  const r = parseShell(command, shell);
  if (r.error || r.segments.some((s) => s.unparseable)) return null;
  return r.segments.filter((s) => s.argv.length).map((s) => s.argv.slice());
}
