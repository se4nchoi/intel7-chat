// ============================================================
// Utilities Module: Formatting, Toast, Markdown & Helpers
// ============================================================

import { parseCodeSnippets, codeLanguageLabel, splitShellCommands } from './code_snippets.js';

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

function renderMarkdownText(container, source) {
  const lines = String(source || '').split('\n');
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
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
      !/^\s*[-+•]\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    appendParagraph(container, paragraphLines);
  }
}

function snippetCopyButton(text, label, className = 'code-copy-btn', visibleLabel = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.setAttribute('aria-label', label);
  button.title = label;
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const copyPath = 'M9 5h10v14H9z M15 5V2H5v14h4';
  path.setAttribute('d', copyPath);
  icon.appendChild(path);
  button.appendChild(icon);
  if (visibleLabel) {
    const textLabel = document.createElement('span');
    textLabel.textContent = visibleLabel;
    button.appendChild(textLabel);
  }
  let resetTimer;
  button.addEventListener('click', async () => {
    if (!await copyText(text, '코드를 복사했습니다.')) return;
    clearTimeout(resetTimer);
    path.setAttribute('d', 'm5 12 4 4L19 6');
    button.setAttribute('aria-label', '복사됨');
    button.title = '복사됨';
    resetTimer = setTimeout(() => {
      path.setAttribute('d', copyPath);
      button.setAttribute('aria-label', label);
      button.title = label;
    }, 1600);
  });
  return button;
}

function createCodeCard(snippet, text, payload, commandNumber = 0) {
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block';
  const header = document.createElement('div');
  header.className = 'code-block-header';
  const label = document.createElement('span');
  label.className = 'code-language';
  label.textContent = /^(?:bash|sh|shell|zsh)$/i.test(snippet.language)
    ? snippet.language.toLowerCase() : codeLanguageLabel(snippet.language);
  header.appendChild(label);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = text;
  pre.appendChild(code);
  const footer = document.createElement('div');
  footer.className = 'code-block-footer';
  const hint = document.createElement('span');
  hint.textContent = commandNumber ? `명령어 ${commandNumber}` : codeLanguageLabel(snippet.language);
  footer.append(hint, snippetCopyButton(payload,
    commandNumber ? `명령 ${commandNumber} 복사` : snippet.language ? `${label.textContent} 코드 복사` : '코드 복사'));
  wrapper.append(header, pre, footer);
  return wrapper;
}

function appendCodeSnippet(container, snippet) {
  const group = document.createElement('div');
  group.className = 'code-snippet-group';
  const shellCommands = /^(?:bash|sh|shell|zsh)$/i.test(snippet.language);
  const rows = shellCommands ? splitShellCommands(snippet.code) : [{ type: 'code', text: snippet.code }];
  const commandCount = rows.filter(item => item.type === 'command').length;
  if (commandCount > 1) {
    const tools = document.createElement('div');
    tools.className = 'code-snippet-tools';
    const count = document.createElement('span');
    count.textContent = `명령어 ${commandCount}개`;
    tools.append(count, snippetCopyButton(snippet.code, '전체 명령어 복사', 'code-copy-all-btn', '전체 복사'));
    group.appendChild(tools);
  }
  const comments = [];
  let commandNumber = 0;
  for (const item of rows) {
    if (item.type === 'comment') {
      comments.push(item.text);
      continue;
    }
    const displayText = [...comments.splice(0), item.text].join('\n');
    group.appendChild(createCodeCard(snippet, displayText, item.text,
      item.type === 'command' ? ++commandNumber : 0));
  }
  if (comments.length) {
    const notes = document.createElement('pre');
    notes.className = 'code-snippet-notes';
    const code = document.createElement('code');
    code.textContent = comments.join('\n');
    notes.appendChild(code);
    group.appendChild(notes);
  }
  container.appendChild(group);
}

export function renderMarkdown(container, source, format = 'auto') {
  container.replaceChildren();
  if (format === 'text') {
    const plain = document.createElement('div');
    plain.className = 'message-plain-text';
    plain.textContent = String(source ?? '');
    container.appendChild(plain);
    return;
  }
  const parts = format === 'code' || format === 'commands'
    ? [{ type: 'code', code: String(source ?? ''), language: format === 'commands' ? 'shell' : '', detected: false }]
    : parseCodeSnippets(source);
  for (const part of parts) {
    if (part.type === 'code') appendCodeSnippet(container, part);
    else renderMarkdownText(container, part.text);
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
  const mentionList = Array.isArray(mentions) ? mentions : [];
  if (!mentionList.length) return;

  const targets = [];
  mentionList.forEach(m => {
    const username = String(m.username || '').trim();
    const displayName = String(m.display_name || '').trim();
    if (!username && !displayName) return;

    if (displayName && username && displayName !== username) {
      targets.push({
        regexStr: `@${escapeRegExp(displayName)}\\s*\\(${escapeRegExp(username)}\\)`,
        mention: m,
      });
      targets.push({
        regexStr: `@${escapeRegExp(displayName)}(?![\\p{L}\\p{N}._-])`,
        mention: m,
      });
    }
    if (username) {
      targets.push({
        regexStr: `@${escapeRegExp(username)}(?![\\p{L}\\p{N}._-])`,
        mention: m,
      });
    }
  });

  if (!targets.length) return;

  targets.sort((a, b) => b.regexStr.length - a.regexStr.length);
  const combinedNames = targets.map(t => t.regexStr).join('|');
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}._-])(${combinedNames})`, 'giu');

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

      const matchedText = match[2];
      const matched = targets.find(t => {
        const testReg = new RegExp(`^${t.regexStr}$`, 'iu');
        return testReg.test(matchedText);
      })?.mention;

      const mention = document.createElement('span');
      mention.className = 'message-mention';
      if (matched && matched.display_name && matched.username && matched.display_name !== matched.username) {
        mention.textContent = `@${matched.display_name} (${matched.username})`;
      } else {
        mention.textContent = matchedText;
      }
      fragment.appendChild(mention);
      cursor = match.index + match[0].length;
    }
    if (cursor < source.length) fragment.append(source.slice(cursor));
    textNode.replaceWith(fragment);
  });
}

export async function copyText(text, successMsg = '클립보드에 복사했습니다.') {
  let copied = false;

  // 1. Modern Clipboard API (available in secure contexts: HTTPS or localhost)
  if (window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = false;
    }
  }

  // 2. Fallback for insecure HTTP LAN contexts using textarea + execCommand
  if (!copied) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '2em';
    ta.style.height = '2em';
    ta.style.padding = '0';
    ta.style.border = 'none';
    ta.style.outline = 'none';
    ta.style.boxShadow = 'none';
    ta.style.background = 'transparent';
    ta.style.opacity = '0';
    ta.style.zIndex = '-1';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    try {
      copied = Boolean(document.execCommand('copy'));
    } catch {
      copied = false;
    }
    ta.remove();
  }

  // 3. Fallback prompt if clipboard access is completely blocked by policy
  if (!copied) {
    window.prompt('아래 텍스트를 Ctrl+C를 눌러 복사하세요:', text);
    copied = true;
  }

  if (copied && successMsg) {
    showToast(successMsg, 'success');
  }
  return copied;
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
