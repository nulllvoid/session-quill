// The instruction-like filter for memory (ruling R29). It is defence in depth: memory is also fenced
// as data when a run receives it (Task 14). A learning or Run note text that reads as an instruction
// to an agent rather than a fact is held for the owner; a false positive only costs one approval,
// so the list is deliberately broad.
//
// Text is normalised before matching (scanForms, below): NFKC and an NFKD form with combining marks
// removed, invisible code points stripped, whitespace collapsed, lower case, and copies with Cyrillic
// and Greek look-alikes mapped to Latin. Every quantifier is bounded, so matching stays linear in the
// input, which callers cap at a few KB per field.

// Cyrillic and Greek letters that render like Latin ones (lower case; text is lower-cased first).
const CONFUSABLES = new Map(Object.entries({
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'l', ɡ: 'g',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y', ϲ: 'c', ϳ: 'j', ω: 'w',
}));

// Invisible code points: format characters and every default-ignorable code point (combining
// grapheme joiner, variation selectors U+FE00-FE0F and U+E0100-E01EF, Mongolian free variation
// selectors, Hangul fillers U+115F, U+1160, U+3164, U+FFA0, soft hyphen, word joiner, ...). The
// fillers are listed explicitly as well, in case an engine's property tables are older.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}͏ᅟᅠ᠋-᠏ㅤ︀-️ﾠ\u{E0100}-\u{E01EF}]+/gu;
const MARKS = /\p{M}+/gu;
/** The text without its invisible code points (format characters, zero-width and bidi controls, ...): the filter's own removal, shared with memory delivery. */
export const stripInvisible = (text) => String(text ?? '').replace(INVISIBLE, '');
const squash = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const toLatin = (s) => { let out = ''; for (const ch of s) out += CONFUSABLES.get(ch) ?? ch; return out; };

/**
 * The normalised forms a text is matched in:
 *   folded     NFKC, invisible code points removed, whitespace collapsed, lower case
 *   latin      folded with Cyrillic and Greek look-alikes mapped to Latin
 *   bare       NFKD with every combining mark (\p{M}) and invisible code point removed, then NFKC
 *              (so "iǵnore", "i̵gnore" and "git́" read as the plain words)
 *   bareLatin  bare with look-alikes mapped
 *   compact    bareLatin without any whitespace (the "ignore previous instructions" family only)
 */
export function scanForms(text) {
  const s = String(text ?? '');
  const folded = squash(stripInvisible(s.normalize('NFKC')));
  const bare = squash(stripInvisible(s.normalize('NFKD')).replace(MARKS, '').normalize('NFKC'));
  const bareLatin = toLatin(bare);
  return { folded, latin: toLatin(folded), bare, bareLatin, compact: bareLatin.replace(/\s+/g, '') };
}

const VERBS_IGNORE = '(?:ignore|disregard|forget|override|bypass|skip|abandon|drop)';
const TARGETS_IGNORE = '(?:instructions?|directions?|directives?|rules?|prompts?|guidelines?|guidance|constraints?|polic(?:y|ies)|system prompt|the above|everything (?:above|before|else)|all (?:of )?(?:this|that|the above)|what (?:you were|i) (?:told|said))';

// name: what the pattern catches; re: tried on each normalised form; compact: tried on the
// whitespace-free form only (none of the other patterns are).
export const INSTRUCTION_PATTERNS = [
  { name: 'ignore-instructions', re: new RegExp(`\\b${VERBS_IGNORE}\\b[^\\n]{0,40}?\\b${TARGETS_IGNORE}\\b`) },
  { name: 'ignore-above', re: /\b(?:ignore|disregard|forget)\b (?:the |all |any |everything )?(?:above|previous|prior|earlier|preceding|before)\b|\bdisregard\b/ },
  { name: 'ignore-compact', compact: true, re: /(?:ignore|disregard|forget)(?:all|the|any|your)?(?:previous|prior|above|earlier|preceding)(?:instructions?|directions?|rules?|prompts?)/ },
  { name: 'role-switch', re: /\byou are now\b|\bfrom now on\b|\byour (?:new |real |actual |only )?(?:task|job|goal|instructions?|role|purpose) (?:is|are)\b|\bnew instructions?\b|\bact as (?:a|an|the)\b|\bpretend (?:to be|you)\b|\bact like\b/ },
  { name: 'role-marker', re: /(?:^|[\n.;!?]\s?)(?:system|assistant|developer|human)\s?:|<\|?\s?(?:im_start|im_end|system|endoftext)\s?\|?>|<\/?(?:system|instructions?|assistant)>|(?:^|\s)#{1,6}\s?(?:instructions?|system|new task)\b|\[\/?(?:inst|system)\]/ },
  { name: 'addresses-agent', re: /\b(?:you|claude|the (?:assistant|agent|model|ai)|assistants?|agents?|the run)\s(?:must|should|shall|need to|have to|will now|are (?:now )?(?:required|allowed|permitted|authori[sz]ed|expected|supposed|instructed|told) to)\b|\b(?:agents?|runs?) (?:are|is) (?:expected|required|supposed|instructed|told|allowed) to\b/ },
  { name: 'widen-permissions', re: /\b(?:grant|give|widen|expand|escalate|elevate|enable|allow|request)\b[^\n.]{0,40}\b(?:permissions?|scopes?|full access|privileges?|sudo|admin rights|root access)\b|\b(?:set|switch|change|make|run|use)\b[^\n.]{0,30}\b(?:full|autonomous|unrestricted|elevated|admin) access\b|\bquill_handoff_\w{1,40}\s?=|\bapprove (?:all |the |any |every )?(?:critical|pending|scope|proposal)/ },
  { name: 'skip-permission-prompts', re: /--dangerously-skip-permissions|\bbypasspermissions\b|--permission-mode\s?bypass|\bdangerously\b/ },
  { name: 'disable-checks', re: /\b(?:disable|skip|bypass|turn off|switch off|comment out|circumvent|silence|weaken|remove|delete)\b[^\n.]{0,40}\b(?:checks?|guard|hooks?|tests?|lint(?:er|ing)?|ci|verification|validation|security|gate|safety|assertions?)\b/ },
  { name: 'skip-verification', re: /\b(?:do not|don't|dont|never|no need to|without)\s(?:run(?:ning)?|check(?:ing)?|verify(?:ing)?|test(?:ing)?|lint(?:ing)?|review(?:ing)?)\b|\bmark (?:the |this |that )?(?:ticket|task|run|it|issue) (?:as )?(?:done|complete|completed|resolved|closed)\b/ },
  { name: 'no-verify', re: /--no-verify\b|--no-gpg-sign\b/ },
  { name: 'push-merge-deploy', re: /\b(?:push|merge|deploy|release|publish|ship|commit)\b[^\n.]{0,30}\b(?:to|into|onto|on)\s(?:the\s)?(?:origin\s|upstream\s)?(?:main|master|trunk|prod(?:uction)?|release|live)\b/ },
  { name: 'force-push', re: /\bforce[- ]?push|\bpush\s(?:[^\n]{0,30}\s)?(?:-f|--force(?:-with-lease)?)\b/ },
  { name: 'git-remote-write', re: /\bgit\s(?:[\w=./:-]{1,40}\s){0,3}?push\b|\bgit\sreset\s--hard\sorigin|\bgh\s(?:pr\smerge|release\screate|repo\sdelete|api\s-x\s(?:post|put|patch|delete))\b/ },
  { name: 'prod-mutation', re: /\b(?:kubectl|oc)\s(?:[\w=./:@-]{1,60}\s){0,4}?(?:apply|delete|edit|patch|scale|rollout|replace|drain|cordon|annotate|label)\b|\bhelm\s(?:[\w=./:@-]{1,60}\s){0,3}?(?:install|upgrade|uninstall|rollback|delete)\b|\bargocd\s(?:app\s)?(?:sync|delete|set|rollback|terminate-op|create)\b|\bterraform\s(?:apply|destroy|import|taint|state\s(?:rm|mv))\b|\bpulumi\s(?:up|destroy)\b/ },
  { name: 'cloud-mutation', re: /\b(?:aws|gcloud|az)\s(?:[\w=./:@-]{1,60}\s){0,4}?(?:delete|create|put|update|deploy|remove|terminate|run-instances|start|stop|set|rm|rb|mv|cp|sync)[\w-]{0,30}\b/ },
  { name: 'destructive', re: /\brm\s-[a-z]{0,4}r[a-z]{0,4}f|\brm\s-[a-z]{0,4}f[a-z]{0,4}r|\bchmod\s(?:-r\s)?777\b|\bdrop\s(?:table|database|schema)\b|\btruncate\stable\b|\bmkfs\b|\bdd\sif=|\bformat\s[a-z]:/ },
  { name: 'contact-host', re: /\b(?:send|post|upload|exfiltrate|forward|transmit|e-?mail|curl|wget|contact|notify|beacon|fetch|download|visit|open|invoke-webrequest|iwr|nc|ncat|ssh|scp|rsync|ftp)\b[^\n]{0,60}?(?:https?:\/\/|ftp:\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b|\bwebhook\b|\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,4}\.[a-z]{2,24}\/|\b[a-z0-9-]{1,63}\.(?:com|net|org|io|dev|xyz|ru|cn|site|app|top|ai|sh|me|co|gg|info|biz|tk|ml|cc|ly|to|zip|link|click)\b)/ },
  { name: 'pipe-to-shell', re: /\|\s?(?:sudo\s)?(?:ba|z|k|da|fi)?sh\b|\|\s?(?:iex|invoke-expression|python3?|node|perl|ruby)\b|\b(?:and|then)\s(?:execute|run|eval)\s(?:it|them|the (?:script|payload|file|output))\b/ },
  { name: 'credentials', re: /\b(?:change|rotate|reset|set|update|replace|export|print|reveal|share|copy|paste|leak|dump|send|post)\b[^\n.]{0,40}\b(?:credentials?|passwords?|tokens?|api[ _-]?keys?|secrets?|ssh[ _-]?keys?|private keys?|kubeconfig)\b/ },
  { name: 'read-credentials', re: /\b(?:cat|type|echo|less|more|head|tail|print|printenv|get-content|gc|read|open|cp|copy|scp|base64|grep|strings)\b[^\n]{0,40}?(?:~\/\.(?:aws|ssh|kube|gnupg|docker)|\.aws\/|\.ssh\/|\bid_(?:rsa|ed25519|ecdsa)\b|\.npmrc\b|\.netrc\b|\.pypirc\b|\.git-credentials\b|\.env\b|\bcredentials\b|kubeconfig|\$\{?\w{0,40}(?:token|secret|key|password|passwd)\w{0,40})/ },
  { name: 'credential-path', re: /~\/\.(?:aws|ssh|kube|gnupg)\b|\.aws\/credentials\b|\.(?:netrc|pypirc|git-credentials)\b|\bid_(?:rsa|ed25519|ecdsa)\b/ },
  // Other languages: "ignore (previous) instructions" and "you must / you are now".
  { name: 'ignore-instructions-fr', re: /\b(?:ignore[zr]?|oublie[zr]?|ne tiens pas compte)\b[^\n]{0,40}?\b(?:instructions?|consignes?|règles)/ },
  { name: 'ignore-instructions-de', re: /\b(?:ignorier(?:e|en|t)?|vergiss|vergessen sie)\b[^\n]{0,40}?(?:anweisung|anleitung|befehl|regel|vorgabe)/ },
  { name: 'ignore-instructions-es-pt-it', re: /\b(?:ignor(?:a|ar|e|en|i|are)|olvid(?:a|e|ar)|esquece|dimentica)\b[^\n]{0,40}?(?:instruc|instruç|istruzion|indicaciones|reglas|regras|regole)/ },
  { name: 'ignore-instructions-ru', re: /(?:игнорир|проигнорир|забудь|забудьте)[^\n]{0,40}?(?:инструкц|указани|правил)/ },
  { name: 'ignore-instructions-zh-ja', re: /(?:忽略|无视|無視|忘记|忘記)[^\n]{0,20}?(?:指令|指示|说明|說明|提示|规则|規則)|(?:指示|命令|指令)[^\n]{0,10}?を?無視/ },
  { name: 'you-must-fr', re: /\b(?:vous devez|tu dois|désormais|vous êtes maintenant|tu es maintenant|à partir de maintenant)\b/ },
  { name: 'you-must-de', re: /\b(?:du musst|du sollst|du bist (?:jetzt|nun)|sie müssen|ab (?:jetzt|sofort))\b/ },
  { name: 'you-must-es', re: /\b(?:debes|tienes que|ahora eres|a partir de ahora|deve(?:s)? agora|você deve)\b/ },
  { name: 'you-must-zh', re: /你(?:必须|現在是|现在是|应该|應該)|从现在开始|從現在開始/ },
];

/** The name of the first instruction-like pattern the text matches in any normalised form, else null. */
export function instructionLike(text) {
  const f = scanForms(text);
  // Each form is also tried with _ . - read as spaces, so ignore_previous_instructions and
  // mcp__x__ignore-previous-instructions read as words (M2).
  const forms = [f.folded, f.latin, f.bare, f.bareLatin].flatMap((s) => [s, s.replace(/[_.-]+/g, ' ')]);
  for (const p of INSTRUCTION_PATTERNS) {
    if (p.compact ? p.re.test(f.compact) : forms.some((s) => p.re.test(s))) return p.name;
  }
  return null;
}
