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
// PowerShell words also keep where their unquoted `=` signs are (eqs) and where quoted text starts
// (qs), so an assignment statement can be split into its target and the pipeline it runs.
function newSeg(dialect) {
  return { dialect, argv: [], kinds: [], quoted: [], assign: [], eqs: [], qs: [], redirects: [], stdin: null, stdinDyn: false, piped: false, call: false, nested: false, env: {}, unparseable: null, pending: null };
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
    const start = () => { if (!w) w = { text: '', lit: false, dyn: false, group: false, quoted: false, qpos: -1, split: false, unq: '' }; return w; };
    // Quoted text after a bare comma is the next array element, so the comma no longer trails.
    const quote = () => { start(); if (w.qpos < 0) w.qpos = w.text.length; w.quoted = true; w.commaAt = undefined; (w.qs ??= []).push(w.text.length); };
    // PowerShell: the current word ends in a bare (unquoted, unescaped) comma.
    const afterComma = () => !!w && w.commaAt !== undefined && w.commaAt === w.text.length;
    const flush = () => {
      if (!w) return;
      // bash brace expansion ({a,b}, {1..3}) turns one word into several
      if (!ps && !cmd && w.unq && hasBraceExpansion(w.unq)) { w.split = true; w.dyn = true; }
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
        for (const t of s.slice(this.i, j).split(/\s+/).filter(Boolean)) { seg.argv.push(t); seg.kinds.push('lit'); seg.quoted.push(false); seg.assign.push(false); seg.eqs.push(null); seg.qs.push(null); }
        this.i = j;
        return;
      }
      seg.trailComma = word.commaAt !== undefined && word.commaAt === word.text.length;
      seg.argv.push(word.text);
      seg.kinds.push(kind);
      seg.quoted.push(word.qpos === 0);
      seg.eqs.push(word.eqs ?? null);
      seg.qs.push(word.qs ?? null);
      const eq = word.text.indexOf('=');
      seg.assign.push(eq > 0 && (word.qpos < 0 || eq < word.qpos) && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?$/.test(word.text.slice(0, eq)));
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
      // PowerShell rejects a redirect after a trailing comma; never let it continue onto the next line
      seg.trailComma = false;
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
      if (nx && /[0-9@*#?$!-]/.test(nx)) { if (nx === '@' || nx === '*') w.split = true; w.text += s.slice(this.i, this.i + 2); w.dyn = true; this.i += 2; return; }
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
      // PowerShell continues an array onto the next line after a trailing comma
      // (only a bare comma: a quoted 'a,' or escaped a`, ends the statement as usual)
      if (c === '\n' && ps && (w ? !seg.pending && afterComma() : seg.trailComma)) { this.i += 1; continue; }
      if (c === '\n') {
        end(false);
        this.i += 1;
        if (this.heredocs.length) this.readHeredocs();
        continue;
      }
      if (c === '\r') { this.i += 1; continue; }

      if (ps) {
        if (isPsSpace(c)) { flush(); this.i += 1; continue; }
        // a comment starts a token, and a bare comma ends one (`x,#c` continues the array)
        if (c === '#' && (!w || afterComma())) { while (this.i < this.n && s[this.i] !== '\n') this.i += 1; continue; }
        if (c === '<' && s[this.i + 1] === '#' && (!w || afterComma())) {
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
        const hereString = c === '@' && (s[this.i + 1] === "'" || s[this.i + 1] === '"') && /^\r?\n/.test(s.slice(this.i + 2, this.i + 4));
        if (PS_SINGLE.has(c) || PS_DOUBLE.has(c) || hereString) {
          // A token (or array element) that starts with a quote ends at the closing quote:
          // `& 'kubectl'delete` runs kubectl with the argument delete. Member access or an
          // index right after it ('a'.Length) computes a value instead.
          const head = !w || afterComma();
          if (hereString) psHereString(s[this.i + 1]);
          else if (PS_SINGLE.has(c)) psSquote();
          else psDquote();
          if (head) {
            const nx = s[this.i];
            if (nx === '.' || nx === '[') w.dyn = true;
            else if (nx !== ',' && nx !== undefined) flush();
          }
          continue;
        }
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
        if (c === '=') (w.eqs ??= []).push(w.text.length);
        w.text += c;
        if (c === ',') w.commaAt = w.text.length;
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
        if (c === '!' && /^![A-Za-z_][\w]*!/.test(s.slice(this.i, this.i + 256))) {
          const m = /^![A-Za-z_][\w]*!/.exec(s.slice(this.i, this.i + 256));
          start();
          w.text += m[0];
          w.dyn = true;
          this.i += m[0].length;
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
            if (s[j] === '\\' && j + 1 < this.n) { const [ch, len] = ansiEscape(s, j + 1); text += ch; j += 1 + len; continue; }
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
        // `?(…)`, `*(…)`, `+(…)`, `@(…)` and `!(…)` inside a word are extglob patterns when
        // extglob is on, not subshells: their matches cannot be known here
        if (w !== null && /[?*+@!]$/.test(w.text)) this.fail('extglob pattern');
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
      w.unq += c;
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

// True when a closed brace group (at any nesting depth) holds `,` or `..`: bash expands it.
// One linear pass with a stack of per-group flags.
export function hasBraceExpansion(text) {
  const s = String(text);
  const stack = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '{') stack.push(false);
    else if (c === '}') { if (stack.length && stack.pop()) return true; }
    else if (stack.length && (c === ',' || (c === '.' && s[i + 1] === '.'))) stack[stack.length - 1] = true;
  }
  return false;
}

function psEscape(c) {
  return { n: '\n', t: '\t', r: '\r', 0: '\0', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b' }[c] ?? c;
}

// Decodes one $'…' escape starting after the backslash; returns [text, consumed length].
function ansiEscape(s, i) {
  const c = s[i];
  const simple = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '?': '?', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' }[c];
  if (simple !== undefined) return [simple, 1];
  let m;
  if (c === 'x' && (m = /^[0-9A-Fa-f]{1,2}/.exec(s.slice(i + 1, i + 3)))) return [String.fromCodePoint(parseInt(m[0], 16)), 1 + m[0].length];
  if (c === 'u' && (m = /^[0-9A-Fa-f]{1,4}/.exec(s.slice(i + 1, i + 5)))) return [String.fromCodePoint(parseInt(m[0], 16)), 1 + m[0].length];
  if (c === 'U' && (m = /^[0-9A-Fa-f]{1,8}/.exec(s.slice(i + 1, i + 9)))) { const cp = parseInt(m[0], 16); return [cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd', 1 + m[0].length]; }
  if ((m = /^[0-7]{1,3}/.exec(s.slice(i, i + 3)))) return [String.fromCodePoint(parseInt(m[0], 8) & 0xff), m[0].length];
  if (c === 'c' && i + 1 < s.length) return [String.fromCharCode(s.charCodeAt(i + 1) & 0x1f), 2];
  return [`\\${c}`, 1];
}

function lex(src, dialect, nest = 0) {
  return new Lexer(src, dialect, nest).run();
}

// Normalised program name: basename, lower case, Windows shim extensions removed.
export function binName(word) {
  if (typeof word !== 'string') return '';
  return word.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

// $ExecutionContext.InvokeProvider.Item.Set('env:…') sets variables and writes items like Set-Item
const PS_DANGER_RE = /(\.|::)(?:invokeprovider\b|(invoke\w*|newscriptblock|upload\w*|download\w*|send\w*|start|execute\w*|post\w*|put\w*|delete\w*|write\w*|append\w*|open\w*|connect\w*|getresponse\w*|run\w*|create\w*|exec\w*|copy\w*|move\w*|replacefile|setenvironmentvariable)\s*\()/i;
const BASH_KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'fish', 'busybox']);
const POWERSHELLS = new Set(['powershell', 'pwsh', 'powershell_ise']);
// Wrappers that run the rest of the line. Every option they accept is listed: an unknown option
// could take a value and shift where the real program starts, so it is unparseable.
const set = (x) => new Set(x.split(' ').filter(Boolean));
const PASS = {
  nohup: [set(''), set('')],
  exec: [set('-a'), set('-c -l')],
  builtin: [set(''), set('')],
  unbuffer: [set(''), set('-p')],
  chronic: [set(''), set('-e -v')],
  noglob: [set(''), set('')],
  stdbuf: [set('-i -o -e --input --output --error'), set('')],
  caffeinate: [set('-t -w'), set('-d -i -m -s -u')],
  nice: [set('-n --adjustment'), set('')],
  ionice: [set('-c -n -p -P -u --class --classdata --pid --pgid --uid'), set('-t --ignore')],
  doas: [set('-u -C'), set('-n -s -L')],
  sudo: [set('-u -g -C -p -h -U -r -t -D -R -T --user --group --close-from --prompt --host --other-user --role --type --chdir --chroot --command-timeout'),
    set('-E -H -n -k -K -b -A -S -P -B -N --preserve-env --set-home --non-interactive --reset-timestamp --remove-timestamp --background --askpass --stdin --preserve-groups --bell --no-update')],
  time: [set('-f -o --format --output'), set('-p -v -a -q --portability --verbose --append --quiet')],
  command: [set(''), set('-p')],
  sshpass: [set('-p -f -d -P'), set('-e -v')],
  winpty: [set(''), set('')],
  strace: [set('-e -o -p -s -u -E -P -a -b -I -O -S -X'), set('-f -F -c -C -d -D -h -i -k -q -r -t -T -v -V -w -x -y -z -Z -n')],
  ltrace: [set('-e -o -p -s -u -a -n -l -x -L'), set('-f -c -C -i -r -S -t -T -b -D -h -V -w')],
  setsid: [set(''), set('-c -f -w --ctty --fork --wait')],
  call: [set(''), set('')],
  coproc: [set(''), set('')],
};
const PASSTHROUGH = new Set(Object.keys(PASS));
const XARGS_VALUE = new Set(['-I', '-i', '-n', '-P', '-d', '-L', '-l', '-E', '-e', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace', '--max-lines', '--eof', '--max-chars']);
const PS_VALUE_PARAMS = ['executionpolicy', 'windowstyle', 'version', 'psconsolefile', 'configurationname', 'inputformat', 'outputformat', 'workingdirectory', 'custompipename', 'settingsfile', 'encodedarguments'];

// Index of the first non-option argument from `from`, or -1 on an option the wrapper does not take.
function skipOptions(a, from, values, flags, extra = null) {
  let j = from;
  while (j < a.length && a[j].startsWith('-') && a[j] !== '-') {
    const t = a[j];
    if (t === '--') return j + 1;
    if (extra && extra.test(t)) { j += 1; continue; }
    if (values.has(t)) { j += 2; continue; }
    const eq = t.indexOf('=');
    if (t.startsWith('--') && eq > 0 && (values.has(t.slice(0, eq)) || flags.has(t.slice(0, eq)))) { j += 1; continue; }
    if (flags.has(t)) { j += 1; continue; }
    if (!t.startsWith('--') && t.length > 2) {
      // combined short flags, or a short value option with its value attached (-n10, -oL)
      if (values.has(t.slice(0, 2))) { j += 1; continue; }
      if ([...t.slice(1)].every((c) => flags.has(`-${c}`))) { j += 1; continue; }
    }
    return -1;
  }
  return j;
}

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

// Drive-qualified variable references in PowerShell text. ${env:X} and $env:X name environment
// variables; $function:f and $alias:a define commands; ${C:\path} and $c:name read or write a
// file's content; scopes ($global:x, $using:x) are plain variables; any other provider item
// (${HKCU:\…}, a custom drive) is not followed. A `${` without its `}` (a PowerShell parse error)
// and a backtick inside `${…}` (an escape PowerShell removes: ${env:A`B} is $env:AB) come back as
// kind 'bad'. One left-to-right pass: each `${` is closed by the next `}` or ends the scan.
const PS_SCOPES = new Set(['global', 'script', 'local', 'private', 'using', 'workflow', 'variable']);
const PS_DRIVE_REF_RE = /\$([A-Za-z0-9_?^]+):(?!:)([A-Za-z0-9_?^]*)/y;

function psRefs(text) {
  const s = String(text);
  const out = [];
  let i = 0;
  while ((i = s.indexOf('$', i)) >= 0) {
    let qual;
    let rest;
    let ref;
    if (s[i + 1] === '{') {
      const end = s.indexOf('}', i + 2);
      if (end < 0) { out.push({ kind: 'bad', text: '${ without a closing }' }); return out; }
      const inner = s.slice(i + 2, end);
      i = end + 1;
      if (inner.includes('`')) { out.push({ kind: 'bad', text: 'escaped character in a ${…} variable name' }); continue; }
      const c = /^([^:\\/]*):(?!:)[\\/]?(.*)$/s.exec(inner);
      if (!c) { if (inner.includes(':')) out.push({ kind: 'provider', text: inner }); continue; }
      [, qual, rest] = c;
      ref = inner;
    } else {
      PS_DRIVE_REF_RE.lastIndex = i;
      const m = PS_DRIVE_REF_RE.exec(s);
      if (!m) { i += 1; continue; }
      i = PS_DRIVE_REF_RE.lastIndex;
      [, qual, rest] = m;
      ref = `${m[1]}:${m[2]}`;
    }
    const ql = qual.toLowerCase();
    if (ql === 'env') out.push({ kind: 'env', name: rest });
    else if (ql === 'function' || ql === 'alias') out.push({ kind: 'define', text: ref });
    else if (PS_SCOPES.has(ql)) continue;
    else if (/^[a-z]$/.test(ql)) out.push({ kind: 'file', path: ref });
    else if (rest !== '') out.push({ kind: 'provider', text: ref });
  }
  return out;
}

const PS_ASSIGN_OP = /^[+\-*/%]?=$/;

// The first assignment operator of a PowerShell statement that starts with a target ($x = …,
// [string]$x=…, $a, $b = …): { lhs: target texts, op, at: index of the first word after it,
// head: the text after an attached `=` (or null) }, or null when there is none.
function psSplitAssignment(a, k, q, eqs, qss) {
  for (let j = 0; j < a.length; j += 1) {
    if (PS_ASSIGN_OP.test(a[j]) && k[j] === 'lit' && !q[j]) return { lhs: a.slice(0, j), op: a[j], at: j + 1, head: null };
    const e = eqs[j];
    if (!e || !e.length) continue;
    const pos = e[0];
    const compound = pos > 0 && /[+\-*/%]/.test(a[j][pos - 1]);
    const lhsText = a[j].slice(0, compound ? pos - 1 : pos);
    const rhsText = a[j].slice(pos + 1);
    const head = rhsText === '' ? null : {
      text: rhsText,
      kind: /[$…]/.test(rhsText) ? 'dyn' : 'lit',
      quoted: (qss[j] ?? []).includes(pos + 1),
      eqs: e.slice(1).map((x) => x - pos - 1),
      qs: (qss[j] ?? []).filter((x) => x > pos).map((x) => x - pos - 1),
    };
    return { lhs: [...a.slice(0, j), ...(lhsText ? [lhsText] : [])], op: compound ? `${a[j][pos - 1]}=` : '=', at: j + 1, head };
  }
  return null;
}

// Expands one lexed segment into the commands it would actually run.
function expand(seg, depth, out) {
  if (seg.unparseable) { out.push(seg); return; }
  if (depth > MAX_DEPTH) { out.push({ ...seg, unparseable: 'wrappers nested too deeply' }); return; }
  const a = seg.argv.slice();
  const k = seg.kinds.slice();
  const q = seg.quoted.slice();
  const as = (seg.assign ?? []).slice();
  const eqs = seg.eqs?.length === a.length ? seg.eqs.slice() : a.map(() => null);
  const qss = seg.qs?.length === a.length ? seg.qs.slice() : a.map(() => null);
  const env = { ...seg.env };
  let call = seg.call;
  const shift = (n = 1) => { a.splice(0, n); k.splice(0, n); q.splice(0, n); as.splice(0, n); eqs.splice(0, n); qss.splice(0, n); };
  const bad = (reason) => out.push({ ...seg, argv: a.slice(), kinds: k.slice(), quoted: q.slice(), env, unparseable: reason });
  const ps = seg.dialect === 'powershell';
  // PowerShell file content read or written through ${C:\path} variable notation
  // (each segment is expanded once; the lists are filled before any copy of it is pushed)
  const addPs = (key, p) => { (seg[key] ??= []).push(p); };
  // Before handing over to a nested script, keep what this segment itself does: its redirects,
  // the environment it passes on (checked as if exported) and any PowerShell file access.
  const redirectsOnly = () => { if (seg.redirects.length || seg.psWrites?.length || seg.psReads?.length || Object.keys(env).length) out.push({ ...seg, argv: [], kinds: [], quoted: [], stdin: null, env }); };
  // A wrapper's script runs in a child process: a `cd` inside it ends with it. The classifier
  // keeps the current directory on a stack between the `cwdMark` push and pop segments; `dir`
  // (a working-directory option) is where the child starts. `eval`, `source` and
  // Invoke-Expression run in this shell (`inProcess`), so a `cd` in them lasts.
  const script = (text, dialect, { inProcess = false, dir = null } = {}) => {
    redirectsOnly();
    let segs;
    try { segs = lex(text, dialect); } catch (e) {
      if (e instanceof ShellParseError) { out.push({ ...newSeg(dialect), unparseable: e.message }); return; }
      throw e;
    }
    if (!inProcess) out.push({ ...newSeg(dialect), cwdMark: 'push' });
    if (!inProcess && dir) out.push({ ...newSeg(dialect), cwdMark: 'cd', chdir: dir });
    for (const s2 of segs) expand(s2, depth + 1, out);
    if (!inProcess) out.push({ ...newSeg(dialect), cwdMark: 'pop' });
  };
  // `env -C dir cmd` / `sudo -D dir cmd`: the command (and any script it wraps) runs in `dir`;
  // its redirects are opened by the calling shell, before the change.
  const inDir = (dir) => {
    if (seg.redirects.length || seg.psWrites?.length || seg.psReads?.length) out.push({ ...seg, argv: [], kinds: [], quoted: [], stdin: null, env });
    out.push({ ...newSeg(seg.dialect), cwdMark: 'push' }, { ...newSeg(seg.dialect), cwdMark: 'cd', chdir: dir });
    expand({ ...seg, argv: a.slice(), kinds: k.slice(), quoted: q.slice(), assign: as.slice(), eqs: eqs.slice(), qs: qss.slice(), env, call, redirects: [], psWrites: undefined, psReads: undefined }, depth + 1, out);
    out.push({ ...newSeg(seg.dialect), cwdMark: 'pop' });
  };
  if (ps) {
    for (let x = 0; x < a.length; x += 1) {
      if (k[x] === 'split' && /^@\w/.test(a[x])) { bad('splatted parameters are not visible'); return; }
      if (PS_DANGER_RE.test(a[x]) && !/^\[(system\.)?console\]::/i.test(a[x])) { bad('.NET method call that can run code, send data or write files'); return; }
      if (k[x] === 'lit') continue;
      for (const ref of psRefs(a[x])) {
        if (ref.kind === 'file') addPs('psReads', ref.path);
        else if (ref.kind === 'bad') { bad(`PowerShell variable reference: ${ref.text}`); return; }
        else if (ref.kind === 'provider') { bad(`PowerShell provider item ${ref.text.slice(0, 60)} is not followed`); return; }
      }
    }
  }
  // Records the targets of a PowerShell assignment; returns a reason when one cannot be followed.
  const psTargets = (lhs, op, rhs) => {
    const refs = lhs.flatMap((t) => psRefs(t));
    for (const ref of refs) {
      if (ref.kind === 'bad') return `PowerShell variable reference: ${ref.text}`;
      if (ref.kind === 'define') return 'assignment defines a PowerShell function or alias';
      if (ref.kind === 'provider') return `assignment to PowerShell provider item ${ref.text.slice(0, 60)}`;
      if (ref.kind === 'file') addPs('psWrites', ref.path);
    }
    const envRefs = refs.filter((ref) => ref.kind === 'env');
    // a literal value only for `$env:X = 'text'`; a command's output or an expression is unknown
    const single = envRefs.length === 1 && lhs.length === 1 && op === '=' && /^\$(\{env:[^}]*\}|env:[A-Za-z0-9_?^]*)$/i.test(lhs[0]);
    const value = single && rhs && rhs.count === 1 && rhs.kind === 'lit' && (rhs.quoted || /^\d+$/.test(rhs.text)) ? rhs.text : null;
    for (const ref of envRefs) env[ref.name] = value;
    return null;
  };

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
      // return/throw/exit take a pipeline: `return kubectl delete …` runs kubectl
      if (k[0] === 'lit' && !q[0] && a.length > 1 && /^(return|throw|exit)$/i.test(w0)) { shift(); continue; }
      // foreach ($x in <pipeline>): the loop variable is assigned and the collection may be a command
      if (/^[$[]/.test(w0) && a.length >= 2 && /^in$/i.test(a[1]) && k[1] === 'lit' && !q[1]) {
        const why = psTargets([w0], 'foreach', null);
        if (why) { bad(why); return; }
        shift(2);
        continue;
      }
      // assignment: the targets are recorded and the right-hand side is a pipeline of its own
      // ($x = kubectl delete …, $x=kubectl …, $a, $b = …, $x = $y = …)
      if (/^[$[]/.test(w0)) {
        const asg = psSplitAssignment(a, k, q, eqs, qss);
        if (asg) {
          const count = a.length - asg.at + (asg.head ? 1 : 0);
          const first = asg.head ?? (asg.at < a.length ? { text: a[asg.at], kind: k[asg.at], quoted: q[asg.at] } : null);
          const why = psTargets(asg.lhs, asg.op, first ? { ...first, count } : null);
          if (why) { bad(why); return; }
          shift(asg.at);
          if (asg.head) {
            a.unshift(asg.head.text); k.unshift(asg.head.kind); q.unshift(asg.head.quoted); as.unshift(false);
            eqs.unshift(asg.head.eqs.length ? asg.head.eqs : null); qss.unshift(asg.head.qs.length ? asg.head.qs : null);
          }
          continue;
        }
      }
      if (q[0] || /^[$@(]/.test(w0) || k[0] === 'group' || /^(\d[\d.]*|\.\d[\d.]*)$/.test(w0)) {
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

    // cmd/c and Git Bash's cmd //c
    const glued = /^((?:.*[\\/])?cmd(?:\.exe)?)(\/\/?[ckr])$/i.exec(w0);
    if (glued) { a.splice(0, 1, glued[1], glued[2]); k.splice(0, 1, 'lit', 'lit'); q.splice(0, 1, false, false); as.splice(0, 1, false, false); eqs.splice(0, 1, null, null); qss.splice(0, 1, null, null); continue; }
    const name = binName(w0);
    const rest = () => a.slice(1);

    if (PASSTHROUGH.has(name)) {
      if (name === 'command' && /^-[vV]$/.test(a[1] ?? '')) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env }); return; }
      if (name === 'sudo' && a.slice(1).some((t) => /^-(i|s|l|e|v|V|-login|-shell|-list|-edit|-validate|-version)$/.test(t)) && !a.slice(1).some((t) => !t.startsWith('-'))) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env }); return; }
      const j = skipOptions(a, 1, PASS[name][0], PASS[name][1], name === 'nice' ? /^-\d+$/ : null);
      if (j < 0) { bad(`unknown option for ${name}`); return; }
      if (j >= a.length) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env }); return; }
      // sudo -D/--chdir runs the command in another directory; --chroot changes what paths mean
      let dir = null;
      if (name === 'sudo') {
        for (let x = 1; x < j; x += 1) {
          const t = a[x];
          if (/^(-R|--chroot)(=|$)|^-R./.test(t)) { bad('sudo --chroot changes the root directory'); return; }
          if (t === '-D' || t === '--chdir') { dir = { v: a[x + 1], kind: k[x + 1] ?? 'lit' }; x += 1; continue; }
          if (t.startsWith('--chdir=')) dir = { v: t.slice(8), kind: k[x] };
          else if (/^-D./.test(t)) dir = { v: t.slice(2), kind: k[x] };
          else if (PASS.sudo[0].has(t)) x += 1;
        }
      }
      shift(j);
      if (dir) { inDir(dir); return; }
      continue;
    }
    if (name === 'chroot') {
      const j = skipOptions(a, 1, set('--userspec --groups'), set('--skip-chdir'));
      if (j < 0) { bad('unknown option for chroot'); return; }
      if (j + 1 >= a.length) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env }); return; }
      shift(j + 1);
      continue;
    }
    if (name === 'flock') {
      let j = skipOptions(a, 1, set('-w -E --timeout --conflict-exit-code'), set('-s -x -n -u -o -e -F --shared --exclusive --nonblock --unlock --close --no-fork --verbose'));
      if (j < 0) { bad('unknown option for flock'); return; }
      j += 1; // lock file or directory
      if (a[j] === '-c' || a[j] === '--command') { if (k[j + 1] !== 'lit') { bad('flock -c with a dynamic command'); return; } script(a[j + 1] ?? '', 'bash'); return; }
      if (j >= a.length) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env }); return; }
      shift(j);
      continue;
    }
    if (name === 'source' || (name === '.' && !ps)) {
      if ((a[1] === '/dev/stdin' || a[1] === '/proc/self/fd/0' || a[1] === '-') && a.length >= 2) {
        if (seg.stdin !== null) { if (seg.stdinDyn) { bad('sourced input contains expansions'); return; } script(seg.stdin, 'bash', { inProcess: true }); return; }
        bad('sourced input is not visible');
        return;
      }
    }
    if (name === 'timeout') {
      let j = skipOptions(a, 1, set('-s -k --signal --kill-after'), set('-v -f -p --verbose --foreground --preserve-status'));
      if (j < 0) { bad('unknown option for timeout'); return; }
      j += 1; // duration
      if (j >= a.length) { out.push({ ...seg, argv: a, kinds: k, quoted: q, env }); return; }
      shift(j);
      continue;
    }
    if (name === 'env') {
      let j = 1;
      let dir = null;
      while (j < a.length) {
        const t = a[j];
        if (t === '--') { j += 1; break; }
        if (t === '-C' || t === '--chdir') { dir = { v: a[j + 1], kind: k[j + 1] ?? 'lit' }; j += 2; continue; }
        if (t.startsWith('--chdir=')) { dir = { v: t.slice(8), kind: k[j] }; j += 1; continue; }
        if ((t === '-S' || t === '--split-string' || t.startsWith('--split-string=')) && dir) { bad('env -C with -S'); return; }
        if (t === '-u' || t === '--unset') { j += 2; continue; }
        if (t === '-S' || t === '--split-string') { const str = a[j + 1]; if (k[j + 1] !== 'lit') { bad('env -S with a dynamic string'); return; } script(str ?? '', 'bash'); return; }
        if (t.startsWith('--split-string=')) { if (k[j] !== 'lit') { bad('env -S with a dynamic string'); return; } script(t.slice(15), 'bash'); return; }
        if (/^--unset=/.test(t)) { j += 1; continue; }
        if (/^-[i0v]+$/.test(t) || ['--ignore-environment', '--null', '--debug', '-'].includes(t)) { j += 1; continue; }
        if (t.startsWith('-')) { bad(`unknown option for env: ${t}`); return; }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { const eq = t.indexOf('='); env[t.slice(0, eq)] = k[j] === 'lit' ? t.slice(eq + 1) : null; j += 1; continue; }
        break;
      }
      if (j >= a.length) { out.push({ ...seg, argv: [], kinds: [], quoted: [], env }); return; }
      shift(j);
      if (dir) { inDir(dir); return; }
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
        if (/^--[a-z-]+=/.test(t) && XARGS_VALUE.has(t.slice(0, t.indexOf('=')))) { j += 1; continue; }
        if (/^-[nPdLlEesa]./.test(t)) { j += 1; continue; }
        if (/^-[0rtpx]+$/.test(t) || ['--null', '--no-run-if-empty', '--verbose', '--interactive', '--exit', '--open-tty', '-o', '--show-limits'].includes(t)) { j += 1; continue; }
        bad(`unknown option for xargs: ${t}`);
        return;
      }
      if (j >= a.length) { a.splice(0, a.length, 'echo'); k.splice(0, k.length, 'lit'); q.splice(0, q.length, false); as.splice(0, as.length, false); eqs.splice(0, eqs.length, null); qss.splice(0, qss.length, null); continue; }
      shift(j);
      for (let x = 0; x < a.length; x += 1) if (repl && a[x].includes(repl)) k[x] = 'dyn';
      if (!repl) { a.push('{xargs}'); k.push('dyn'); q.push(false); as.push(false); eqs.push(null); qss.push(null); }
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
      if (/^(\.{1,2}([\\/]|$)|[\\/]|[A-Za-z]:[\\/]|file:|git\+|https?:|ssh:)/i.test(a[0])) { bad('npx runs a package from a path or URL'); return; }
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
      let wd = null;
      while (j < a.length) {
        const t = a[j];
        if (!(t.startsWith('-') || t.startsWith('/')) || t === '-') break;
        const p = t.slice(1).toLowerCase().replace(/:.*$/, '');
        // the working directory the child starts in (R17.2)
        if (p === 'wd' || (p.length >= 2 && 'workingdirectory'.startsWith(p))) { wd = { v: a[j + 1], kind: k[j + 1] ?? 'lit' }; j += 2; continue; }
        if (p === 'e' || p === 'ec' || (p.length >= 2 && 'encodedcommand'.startsWith(p))) {
          const text = decodePsBase64(a[j + 1]);
          if (text === null) { bad('encoded command does not decode'); return; }
          script(text, 'powershell', { dir: wd });
          return;
        }
        if (p.length >= 1 && 'command'.startsWith(p)) {
          const parts = a.slice(j + 1);
          if (!parts.length || parts[0] === '-') {
            if (seg.stdin !== null && !seg.stdinDyn) { script(seg.stdin, 'powershell', { dir: wd }); return; }
            bad('PowerShell reads its command from input');
            return;
          }
          if (k.slice(j + 1).some((x) => x !== 'lit')) { bad('PowerShell -Command with a dynamic command'); return; }
          script(parts.join(' '), 'powershell', { dir: wd });
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
        script(a.slice(j).join(' '), 'powershell', { dir: wd });
        return;
      }
      if (seg.stdin !== null && !seg.stdinDyn) { script(seg.stdin, 'powershell', { dir: wd }); return; }
      if (seg.piped) { bad('input is piped into PowerShell'); return; }
      out.push({ ...seg, argv: a, kinds: k, quoted: q, env });
      return;
    }
    if (name === 'cmd') {
      let j = 1;
      let run = false;
      while (j < a.length && a[j].startsWith('/')) {
        const sw = a[j].toLowerCase().replace(/^\/\//, '/');
        j += 1;
        if (sw === '/c' || sw === '/k' || sw === '/r') { run = true; break; }
        if (/^\/[ck]./.test(sw)) { a.splice(j, 0, a[j - 1].slice(2)); k.splice(j, 0, 'lit'); q.splice(j, 0, false); as.splice(j, 0, false); eqs.splice(j, 0, null); qss.splice(j, 0, null); run = true; break; }
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
      if (a[1] === '--') shift(1);
      if (a.length === 1) { out.push({ ...seg, argv: [], kinds: [], quoted: [], env }); return; }
      if (k.slice(1).some((x) => x !== 'lit')) { bad('eval of a dynamic string'); return; }
      script(rest().join(' '), 'bash', { inProcess: true });
      return;
    }
    if (ps && (name === 'invoke-expression' || name === 'iex')) {
      const from = a.length > 1 && /^-c/i.test(a[1]) ? 2 : 1;
      const args = a.slice(from);
      const kinds = k.slice(from);
      if (!args.length) { bad(seg.piped ? 'input is piped into Invoke-Expression' : 'Invoke-Expression without a string'); return; }
      if (kinds.some((x) => x !== 'lit')) { bad('Invoke-Expression of a dynamic string'); return; }
      script(args.join(' '), 'powershell', { inProcess: true });
      return;
    }
    if (ps && (name === 'start-process' || name === 'saps' || name === 'start')) {
      let file = null;
      let fileKind = 'lit';
      let wd = null;
      let argList = [];
      let argKinds = [];
      const pos = [];
      for (let j = 1; j < a.length; j += 1) {
        const t = a[j];
        if (t.startsWith('-')) {
          const p = t.slice(1).toLowerCase();
          if ('filepath'.startsWith(p) || p === 'path') { file = a[j + 1]; fileKind = k[j + 1]; j += 1; continue; }
          if ('argumentlist'.startsWith(p) || p === 'args') { argList = a[j + 1] === undefined ? [] : [a[j + 1]]; argKinds = [k[j + 1]]; j += 1; continue; }
          if (p.length >= 2 && 'verb'.startsWith(p) && /^runas/i.test(a[j + 1] ?? '')) { bad('Start-Process -Verb RunAs elevates'); return; }
          if (p.length >= 2 && 'credential'.startsWith(p)) { bad('Start-Process as another user'); return; }
          if (p.length >= 2 && 'workingdirectory'.startsWith(p)) { wd = { v: a[j + 1], kind: k[j + 1] ?? 'lit' }; j += 1; continue; }
          if (['workingdirectory', 'verb', 'windowstyle', 'redirectstandardoutput', 'redirectstandardinput', 'redirectstandarderror'].some((v) => p.length >= 2 && v.startsWith(p))) { j += 1; continue; }
          continue;
        }
        pos.push(j);
      }
      if (file === null && pos.length) { file = a[pos[0]]; fileKind = k[pos[0]]; if (pos.length > 1 && !argList.length) { argList = pos.slice(1).map((x) => a[x]); argKinds = pos.slice(1).map((x) => k[x]); } }
      if (file === null) { bad('Start-Process without a program'); return; }
      if (fileKind !== 'lit' || argKinds.some((x) => x !== 'lit')) { bad('Start-Process with a dynamic program or arguments'); return; }
      const inner = [file, ...argList.flatMap((x) => x.split(/[,\s]+/)).filter(Boolean)].map(quoteForBash).join(' ');
      script(inner, 'bash', { dir: wd });
      return;
    }
    if (!ps && seg.dialect === 'cmd' && name === 'start') {
      let j = 1;
      let dir = null; // start /D dir: the program starts there (R17.2)
      while (j < a.length && (a[j].startsWith('/') || (j === 1 && q[j]))) {
        if (a[j].toLowerCase() === '/d') dir = { v: a[j + 1], kind: k[j + 1] ?? 'lit' };
        else if (/^\/d./i.test(a[j]) && !q[j]) dir = { v: a[j].slice(2), kind: k[j] };
        j += a[j].toLowerCase() === '/d' ? 2 : 1;
      }
      if (j >= a.length) { out.push({ ...seg, argv: [], kinds: [], quoted: [], env }); return; }
      shift(j);
      if (dir) { inDir(dir); return; }
      continue;
    }
    if (name === 'wsl') {
      let j = 1;
      let dir = null; // wsl --cd dir: the command starts there (R17.2)
      while (j < a.length && a[j].startsWith('-')) {
        const t = a[j];
        if (t === '--' || t === '-e' || t === '--exec') { j += 1; break; }
        if (t === '--cd') dir = { v: a[j + 1], kind: k[j + 1] ?? 'lit' };
        if (t === '-d' || t === '--distribution' || t === '-u' || t === '--user' || t === '--cd') { j += 2; continue; }
        j += 1;
      }
      if (j >= a.length) { out.push({ ...seg, argv: [], kinds: [], quoted: [], env }); return; }
      shift(j);
      if (dir) { inDir(dir); return; }
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
