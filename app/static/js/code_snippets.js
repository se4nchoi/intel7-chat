// Display-only parsing: stored messages and copied code keep their original text.
const LANGUAGES = { py: 'Python', python: 'Python', js: 'JavaScript', javascript: 'JavaScript',
  ts: 'TypeScript', typescript: 'TypeScript', cpp: 'C++', c: 'C', java: 'Java',
  json: 'JSON', html: 'HTML', css: 'CSS', sql: 'SQL', sh: 'Shell', bash: 'Shell', shell: 'Shell', zsh: 'Shell',
  powershell: 'PowerShell', ps1: 'PowerShell' };

export function codeLanguageLabel(language) {
  return LANGUAGES[String(language).toLowerCase()] || String(language || '코드').slice(0, 30);
}

// Catch command structure independently of the executable's name. A program
// followed only by ordinary words is ambiguous and stays as prose by default.
function hasCommandStructure(text) {
  const command = text.match(/^(?:[A-Za-z]:[\\/][^\s]+|(?:\.{0,2}\/)[^\s]+|[A-Za-z_][\w.-]*)\s+(.+)$/);
  if (!command) return false;
  const args = command[1];
  return /(?:^|\s)--?[A-Za-z][\w-]*(?:[=:\s]|$)/.test(args)
    || /(?:^|\s)(?:[.~]?\/\S+|[A-Za-z]:[\\/]\S+|[\w.+-]+:\/\/\S+)/.test(args)
    || /(?:^|\s)[\w./\\-]+\.[A-Za-z0-9]{1,8}(?:\s|$)/.test(args)
    || /(?:^|\s)[A-Za-z_]\w*=\S+/.test(args)
    || /(?:^|\s)['"`]/.test(args)
    || /\s(?:\|{1,2}|&&|>>?|<<-?)\s|\\$/.test(text)
    || /^[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+$/u.test(args);
}

function lineInfo(line) {
  const text = line.trim();
  if (!text) return { kind: 'blank' };
  if (/^(?:from\s+[\w.]+\s+import\s+|import\s+[\w.]+(?:\s|$)|(?:async\s+)?def\s+\w+\s*\(|class\s+\w+(?:\([^)]*\))?\s*:)/.test(text)
      || /^(?:if|elif|for|while|with|except)\s+.+:\s*(?:#.*)?$|^(?:else|try|finally):\s*(?:#.*)?$/.test(text)
      || /^(?:print|input)\s*\(.*\)\s*(?:#.*)?$/.test(text)) return { kind: 'strong', language: 'python' };
  if (/^(?:export\s+)?(?:(?:async\s+)?function\s+\w+\s*\(|(?:const|let|var)\s+\w+\s*=)|^(?:import\s+.+\s+from\s+['"]|console\.(?:log|error|warn)\s*\()/.test(text)) return { kind: 'strong', language: 'javascript' };
  if (/^#\s*include\s*[<"]|^(?:int|void|float|double|char|bool)\s+\w+\s*\([^;]*\)\s*\{?\s*$/.test(text)) return { kind: 'strong', language: 'c' };
  if (/^(?:SELECT\s+.+\s+FROM\s+|INSERT\s+INTO\s+|CREATE\s+TABLE\s+|UPDATE\s+\w+\s+SET\s+)/.test(text)) return { kind: 'strong', language: 'sql' };
  if (/^(?:sudo\s+(?:-[\w=.-]+\s+)*[\w./-]+(?:\s|$)|(?:apt|apt-get)\s+(?:update|install|upgrade|remove)\b|echo\s+['"$]|export\s+\w+=|(?:cd|source)\s+[~/.]|python(?:3)?\s+(?:-m\s+)?|(?:pip|pip3|uv)\s+(?:install|run|sync|add)\s+|npm\s+(?:install|ci|run|test)(?:\s|$))/.test(text)) return { kind: 'strong', language: 'bash' };
  if (hasCommandStructure(text)) return { kind: 'strong', language: 'shell' };
  if (/^<\/?[A-Za-z][\w-]*(?:\s|>|\/)/.test(text) && /[>]/.test(text)) return { kind: 'strong', language: 'html' };
  if (/^['"][^'"]+['"]\s*:/.test(text)) return { kind: 'code', language: 'json' };
  if (/^(?:[\w$]+(?:\.[\w$]+|\[[^\]]+\])*)\s*(?:=(?!=|>)|\+=|-=|\*=|\/=)\s*\S/.test(text)
      || /^(?:await\s+)?[\w$]+(?:\.[\w$]+)*\s*\(.*\)\s*;?$/.test(text)
      || /^(?:return|yield|raise|throw)\s+\S|^(?:pass|break|continue)\s*(?:#.*)?$/.test(text)
      || /^(?:if|for|while|switch|catch)\s*\(.+\).*[{;]$/.test(text)) return { kind: 'code' };
  if (/^(?:#|\/\/|\/\*|\* |\*\/|--\s)/.test(text)) return { kind: 'comment' };
  if (/^[\[\]{}(),;]+\s*;?$/.test(text) || /^[rubf]*['"]{3}/i.test(text)) return { kind: 'continuation' };
  if (/^[\t ]+\S/.test(line)) return { kind: 'continuation' };
  return { kind: 'prose' };
}

function appendText(parts, text) {
  const last = parts.at(-1);
  if (last?.type === 'text') last.text += '\n' + text;
  else parts.push({ type: 'text', text });
}

function contextualLineInfo(lines) {
  const infos = lines.map(lineInfo);
  const candidates = lines.map(line => {
    // Only simple command-shaped ASCII tokens qualify through context alone.
    // Korean explanations and sentence punctuation remain prose; an inline
    // shell comment may contain either without splitting the command.
    const command = line.split(/\s+#/, 1)[0].trim();
    return command.match(/^([A-Za-z_][\w.-]*)(?:\s+[A-Za-z0-9_./:@%+=,-]+)*$/)?.[1] || '';
  });
  const isShell = info => info.kind === 'strong' && /^(?:bash|shell)$/.test(info.language);
  const allowed = index => isShell(infos[index]) || candidates[index]
    || ['blank', 'comment'].includes(infos[index].kind);
  let start = 0;
  while (start < lines.length) {
    if (!allowed(start)) { start++; continue; }
    let end = start;
    const executables = new Set();
    while (end < lines.length && allowed(end)) {
      if (isShell(infos[end])) {
        const executable = lines[end].trim().match(/^([A-Za-z_][\w.-]*)/)?.[1];
        if (executable) executables.add(executable);
      }
      end++;
    }
    for (let index = start; index < end; index++) {
      if (infos[index].kind === 'prose' && executables.has(candidates[index])) {
        infos[index] = { kind: 'strong', language: 'shell' };
      }
    }
    start = end;
  }
  return infos;
}

function parsePlain(parts, lines) {
  const infos = contextualLineInfo(lines);
  let index = 0;
  while (index < lines.length) {
    const info = infos[index];
    if (!['strong', 'code', 'comment', 'continuation'].includes(info.kind)) {
      appendText(parts, lines[index++]);
      continue;
    }
    const start = index;
    let strong = 0, evidence = 0, language = '', lastContent = start;
    while (index < lines.length) {
      // A shell continuation belongs to the preceding command even when the
      // next line looks like prose (e.g. an unindented package-name list).
      const continued = index > start && /\\$/.test(lines[index - 1]);
      const current = continued ? { kind: 'continuation' } : infos[index];
      if (current.kind === 'prose') break;
      if (current.kind === 'strong') strong++;
      if (current.kind === 'code' || current.kind === 'strong') evidence++;
      if (!language && current.language) language = current.language;
      if (current.kind !== 'blank') lastContent = index;
      index++;
    }
    const end = lastContent + 1;
    // Isolated assignments, ordinary indented prose and comments stay as chat.
    if (strong || evidence >= 2) {
      parts.push({ type: 'code', code: lines.slice(start, end).join('\n'), language, detected: true });
    } else appendText(parts, lines.slice(start, end).join('\n'));
    if (index > end) appendText(parts, lines.slice(end, index).join('\n'));
  }
}

export function parseCodeSnippets(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const parts = [], plain = [];
  let index = 0;
  while (index < lines.length) {
    const opening = lines[index].match(/^\s*(`{3,}|~{3,})\s*([^`~]*)$/);
    if (!opening) { plain.push(lines[index++]); continue; }
    parsePlain(parts, plain.splice(0));
    const fence = opening[1], language = opening[2].trim().split(/\s+/)[0] || '';
    const closing = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`);
    const code = [];
    index++;
    while (index < lines.length && !closing.test(lines[index])) code.push(lines[index++]);
    if (index < lines.length) index++;
    parts.push({ type: 'code', code: code.join('\n'), language, detected: false });
  }
  parsePlain(parts, plain);
  return parts;
}

// Split shell blocks by complete commands, not physical lines. This is a
// display helper, never a shell interpreter: substitutions are not evaluated.
export function splitShellCommands(source) {
  const rows = [], pending = [];
  let quote = '', escaped = false, heredoc = '', stripTabs = false;
  for (const line of String(source).split('\n')) {
    if (!pending.length && (!line.trim() || /^\s*#/.test(line))) {
      rows.push({ type: 'comment', text: line });
      continue;
    }
    pending.push(line);
    if (heredoc) {
      if ((stripTabs ? line.replace(/^\t+/, '') : line) !== heredoc) continue;
      heredoc = '';
    } else {
      let syntax = '';
      for (let index = 0; index < line.length; index++) {
        const ch = line[index];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && quote !== "'") { escaped = true; continue; }
        if (quote) { if (ch === quote) quote = ''; continue; }
        const marker = ch === '<' && line.slice(index).match(/^<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w]*))/);
        if (marker) {
          heredoc = marker[2] || marker[3] || marker[4];
          stripTabs = Boolean(marker[1]);
          index += marker[0].length - 1;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
        if (ch === '#') break;
        syntax += ch;
      }
      if (heredoc) continue;
      const continued = escaped || quote || /(?:\||&&|\|\|)\s*$/.test(syntax);
      escaped = false;
      if (continued) continue;
    }
    rows.push({ type: 'command', text: pending.splice(0).join('\n') });
  }
  if (pending.length) rows.push({ type: 'command', text: pending.join('\n') });
  return rows;
}
