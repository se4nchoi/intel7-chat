// Light message formatting built from DOM nodes only (never innerHTML), so
// posted text can't inject markup. Supports:
//   ```lang            fenced code blocks, with a copy button
//   `code`             inline code
//   **bold**           bold
//   https://...        links (http/https only), opened in a new tab
//   @username          mentions, highlighted more when they're you

const FENCE = /```([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/g;
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(https?:\/\/[^\s<>"'`]+)|(@[\w.-]+)/g;
const TRAILING = /[.,;:!?)\]}'"]+$/;

export function renderRich(node, text, { me = '' } = {}) {
  node.replaceChildren();
  let last = 0;
  for (const match of text.matchAll(FENCE)) {
    // A block already breaks the line, so drop one newline on either side of it.
    appendInline(node, text.slice(last, match.index).replace(/\n$/, ''), me);
    node.append(codeBlock(match[2].replace(/\n$/, ''), match[1]));
    last = match.index + match[0].length;
    if (text[last] === '\n') last += 1;
  }
  appendInline(node, text.slice(last), me);
  return node;
}

function appendInline(node, text, me) {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    let [token] = match;
    let trail = '';
    if (match[3]) {  // keep sentence punctuation out of links
      trail = token.match(TRAILING)?.[0] || '';
      token = token.slice(0, token.length - trail.length);
    }
    node.append(text.slice(last, match.index));
    if (match[1]) node.append(tag('code', token.slice(1, -1)));
    else if (match[2]) node.append(tag('strong', token.slice(2, -2)));
    else if (match[3]) {
      const link = tag('a', token);
      link.href = token; link.target = '_blank'; link.rel = 'noopener noreferrer';
      node.append(link, trail);
    } else {
      const mine = me && token.slice(1).toLowerCase() === me.toLowerCase();
      node.append(tag('span', token, `mention${mine ? ' me' : ''}`));
    }
    last = match.index + match[0].length;
  }
  node.append(text.slice(last));
}

function codeBlock(code, language) {
  const pre = document.createElement('pre');
  pre.className = 'code-block';
  const copy = tag('button', '복사', 'copy-code');
  copy.type = 'button';
  copy.setAttribute('aria-label', '코드 복사');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(code); copy.textContent = '복사됨'; }
    catch { copy.textContent = '복사 실패'; }
    setTimeout(() => { copy.textContent = '복사'; }, 1500);
  });
  if (language) pre.append(tag('span', language, 'code-lang'));
  pre.append(copy, tag('code', code));
  return pre;
}

function tag(name, text, className) {
  const node = document.createElement(name);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
