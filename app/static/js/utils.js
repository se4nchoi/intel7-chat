// ============================================================
// Utilities Module: Formatting, Toast, Markdown & Helpers
// ============================================================

export function showToast(message, type = 'info') {
  const toastRegion = document.getElementById('toast-region');
  if (!toastRegion) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastRegion.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'opacity 0.25s, transform 0.25s';
    setTimeout(() => toast.remove(), 260);
  }, 3200);
}

export function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = date.toDateString() === new Date().toDateString();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return today ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validLink(href) {
  try {
    const url = new URL(href, location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function createWarningLink(url, label) {
  const link = document.createElement('a');
  link.href = url.href;
  link.textContent = label;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'message-external-link';
  link.title = '외부 링크 — 클릭하면 이동 전 확인합니다.';
  link.addEventListener('click', event => {
    if (!confirm(`외부 링크로 이동합니다.\n\n${url.href}\n\n신뢰할 수 있는 주소인지 확인한 뒤 계속하세요.`)) {
      event.preventDefault();
    }
  });
  return link;
}

export function appendInlineMarkdown(parent, source) {
  const pattern = /(\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*([^*\n]+)\*)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    let node;
    if (match[2] !== undefined) {
      node = document.createElement('strong');
      node.textContent = match[2];
    } else if (match[3] !== undefined) {
      node = document.createElement('del');
      node.textContent = match[3];
    } else if (match[4] !== undefined) {
      node = document.createElement('code');
      node.textContent = match[4];
    } else if (match[5] !== undefined) {
      const url = validLink(match[6]);
      if (url) {
        node = createWarningLink(url, match[5]);
      } else {
        node = document.createTextNode(match[0]);
      }
    } else {
      node = document.createElement('em');
      node.textContent = match[7];
    }
    parent.appendChild(node);
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) parent.appendChild(document.createTextNode(source.slice(cursor)));
}

export function appendParagraph(container, lines) {
  const paragraph = document.createElement('p');
  lines.forEach((line, index) => {
    if (index) paragraph.appendChild(document.createElement('br'));
    appendInlineMarkdown(paragraph, line);
  });
  container.appendChild(paragraph);
}

export function renderMarkdown(container, source) {
  container.replaceChildren();
  const lines = String(source || '').split('\n');
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }
    if (lines[index].trimStart().startsWith('```')) {
      index += 1;
      const codeLines = [];
      while (index < lines.length && !lines[index].trimStart().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'code-copy-btn';
      copy.textContent = '복사';
      copy.addEventListener('click', () => copyText(codeLines.join('\n'), '코드를 복사했습니다.'));
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.appendChild(code);
      wrapper.append(copy, pre);
      container.appendChild(wrapper);
      continue;
    }
    if (/^\s*[-+•]\s+/.test(lines[index])) {
      const list = document.createElement('ul');
      while (index < lines.length && /^\s*[-+•]\s+/.test(lines[index])) {
        const item = document.createElement('li');
        appendInlineMarkdown(item, lines[index].replace(/^\s*[-+•]\s+/, ''));
        list.appendChild(item);
        index += 1;
      }
      container.appendChild(list);
      continue;
    }
    if (/^\s*>\s?/.test(lines[index])) {
      const quote = document.createElement('blockquote');
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      appendParagraph(quote, quoteLines);
      container.appendChild(quote);
      continue;
    }
    const paragraphLines = [];
    while (
      index < lines.length && lines[index].trim() &&
      !lines[index].trimStart().startsWith('```') &&
      !/^\s*[-+•]\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    appendParagraph(container, paragraphLines);
  }
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement?.closest('a, code')) textNodes.push(walker.currentNode);
  }
  const urlPattern = /https?:\/\/[^\s<>()]+/gi;
  textNodes.forEach(textNode => {
    const text = textNode.nodeValue || '';
    const matches = [...text.matchAll(urlPattern)];
    if (!matches.length) return;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    matches.forEach(match => {
      if (match.index > cursor) fragment.append(text.slice(cursor, match.index));
      const url = validLink(match[0]);
      fragment.append(url ? createWarningLink(url, match[0]) : match[0]);
      cursor = match.index + match[0].length;
    });
    if (cursor < text.length) fragment.append(text.slice(cursor));
    textNode.replaceWith(fragment);
  });
}

export function highlightMentions(container, mentions) {
  const usernames = (Array.isArray(mentions) ? mentions : [])
    .map(mention => String(mention.username || ''))
    .filter(Boolean)
    .sort((first, second) => second.length - first.length);
  if (!usernames.length) return;
  const names = usernames.map(escapeRegExp).join('|');
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}._-])(@(?:${names}))(?![\\p{L}\\p{N}._-])`, 'giu');
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest('code, a')) textNodes.push(node);
  }
  textNodes.forEach(textNode => {
    const source = textNode.nodeValue || '';
    pattern.lastIndex = 0;
    if (!pattern.test(source)) return;
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
      if (match.index > cursor) fragment.append(source.slice(cursor, match.index));
      if (match[1]) fragment.append(match[1]);
      const mention = document.createElement('span');
      mention.className = 'message-mention';
      mention.textContent = match[2];
      fragment.appendChild(mention);
      cursor = match.index + match[0].length;
    }
    if (cursor < source.length) fragment.append(source.slice(cursor));
    textNode.replaceWith(fragment);
  });
}

export async function copyText(text, successMsg = '클립보드에 복사했습니다.') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMsg, 'success');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    try {
      if (!document.execCommand('copy')) throw new Error('copy command rejected');
      showToast(successMsg, 'success');
    } catch {
      showToast('복사에 실패했습니다.', 'error');
    }
    ta.remove();
  }
}

export function makeKeyboardClickable(el, handler) {
  el.setAttribute('tabindex', '0');
  el.setAttribute('role', 'button');
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler(e);
    }
  });
}

export function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u3131-\u3163\uac00-\ud7a3._-]/g, '')
    .slice(0, 30);
}
