/**
 * Classroom Chat client: conversations, safe Markdown, replies, drafts and files.
 */
'use strict';

const STORAGE_KEY = 'classroom_chat_nickname';
const DRAFTS_KEY = 'classroom_chat_drafts_v1';
const MAX_NICK_LEN = 30;
const RECONNECT_DELAY = 3000;
const GLOBAL_ID = 'global';

const nicknameModal = document.getElementById('nickname-modal');
const nicknameInput = document.getElementById('nickname-input');
const nicknameSubmit = document.getElementById('nickname-submit');
const nicknameError = document.getElementById('nickname-error');
const chatApp = document.getElementById('chat-app');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const convListEl = document.getElementById('conv-list');
const onlineListEl = document.getElementById('online-list');
const onlineCountEl = document.getElementById('online-count');
const messageListEl = document.getElementById('message-list');
const msgInput = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const chatAreaTitle = document.getElementById('chat-area-title');
const connStatus = document.getElementById('conn-status');
const myNickBadge = document.getElementById('my-nick-badge');
const charCount = document.getElementById('char-count');
const replyPreview = document.getElementById('reply-preview');
const replyPreviewName = document.getElementById('reply-preview-name');
const replyPreviewText = document.getElementById('reply-preview-text');
const replyCancel = document.getElementById('reply-cancel');
const attachmentPreview = document.getElementById('attachment-preview');
const attachmentPreviewName = document.getElementById('attachment-preview-name');
const attachmentPreviewMeta = document.getElementById('attachment-preview-meta');
const attachmentRemove = document.getElementById('attachment-remove');
const uploadProgressTrack = document.getElementById('upload-progress-track');
const uploadProgressBar = document.getElementById('upload-progress-bar');
const dropOverlay = document.getElementById('drop-overlay');
const toastRegion = document.getElementById('toast-region');
const chatArea = document.querySelector('.chat-area');
const MAX_MSG_LEN = msgInput.maxLength;
const MAX_FILE_MB = Number(fileInput.dataset.maxFileMb || 50);

const conversations = new Map();
const replyTargets = new Map();
const pendingAttachments = new Map();
let drafts = loadDrafts();
let activeConvId = GLOBAL_ID;
let myNickname = '';
let ws = null;
let reconnectTimer = null;
let nicknameRejected = false;
let lastNicknameError = '';
let dragDepth = 0;

function loadDrafts() {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function persistDrafts() {
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch { /* storage unavailable */ }
}

function initConversations() {
  conversations.clear();
  conversations.set(GLOBAL_ID, {
    id: GLOBAL_ID,
    name: '전체 채팅',
    type: 'global',
    messages: [],
    messageIds: new Set(),
    unread: 0,
  });
}

function displayNickname(nick, ipSuffix = '') {
  return ipSuffix ? `${nick} (ip: ${ipSuffix})` : nick;
}

function getOrCreateDm(nick, ipSuffix = '') {
  if (!conversations.has(nick)) {
    conversations.set(nick, {
      id: nick,
      name: nick,
      ipSuffix,
      type: 'dm',
      messages: [],
      messageIds: new Set(),
      unread: 0,
    });
  } else if (ipSuffix) {
    conversations.get(nick).ipSuffix = ipSuffix;
  }
  return conversations.get(nick);
}

async function fetchSuggested() {
  try {
    const response = await fetch('/api/client-info');
    return (await response.json()).suggested_nickname || '';
  } catch {
    return '';
  }
}

async function showNicknameModal(errorMessage = '') {
  const stored = (localStorage.getItem(STORAGE_KEY) || '').trim();
  nicknameInput.value = stored || await fetchSuggested();
  nicknameError.textContent = errorMessage;
  nicknameModal.classList.remove('hidden');
  setTimeout(() => nicknameInput.focus(), 50);
}

function hideNicknameModal() {
  nicknameModal.classList.add('hidden');
}

function enterChat(nick) {
  myNickname = nick;
  localStorage.setItem(STORAGE_KEY, nick);
  myNickBadge.textContent = nick;
  hideNicknameModal();
  initConversations();
  chatApp.classList.remove('hidden');
  switchConversation(GLOBAL_ID);
  initWebSocket();
}

function submitNickname() {
  const nick = nicknameInput.value.trim();
  if (!nick) {
    nicknameError.textContent = '닉네임을 입력해 주세요.';
    return;
  }
  if (nick.length > MAX_NICK_LEN) {
    nicknameError.textContent = `닉네임은 ${MAX_NICK_LEN}자 이하여야 합니다.`;
    return;
  }
  nicknameError.textContent = '';
  enterChat(nick);
}

nicknameSubmit.addEventListener('click', submitNickname);
nicknameInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') submitNickname();
});

sidebarToggle.addEventListener('click', () => {
  const open = sidebar.classList.toggle('open');
  sidebarToggle.setAttribute('aria-expanded', String(open));
  sidebarBackdrop.classList.toggle('hidden', !open);
});
sidebarBackdrop.addEventListener('click', closeSidebar);

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarToggle.setAttribute('aria-expanded', 'false');
  sidebarBackdrop.classList.add('hidden');
}

function saveCurrentDraft() {
  if (!conversations.has(activeConvId)) return;
  const value = msgInput.value;
  if (value) drafts[activeConvId] = value;
  else delete drafts[activeConvId];
  persistDrafts();
}

function loadActiveDraft() {
  msgInput.value = drafts[activeConvId] || '';
  resizeComposer();
  updateCharCount();
}

function switchConversation(id) {
  if (!conversations.has(id)) return;
  saveCurrentDraft();
  activeConvId = id;
  const conv = conversations.get(id);
  conv.unread = 0;
  const displayName = displayNickname(conv.name, conv.ipSuffix);
  chatAreaTitle.textContent = conv.type === 'global' ? '🌐 전체 채팅' : `💬 ${displayName}`;
  msgInput.placeholder = conv.type === 'global'
    ? '메시지를 입력하세요'
    : `${displayName}에게 DM 보내기`;
  loadActiveDraft();
  renderComposerPreviews();
  renderMessages();
  renderConversationList();
  closeSidebar();
  msgInput.focus();
}

function makeKeyboardClickable(element, callback) {
  element.tabIndex = 0;
  element.setAttribute('role', 'button');
  element.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      callback();
    }
  });
}

function renderConversationList() {
  convListEl.replaceChildren();
  for (const conv of conversations.values()) {
    const item = document.createElement('li');
    item.className = `conv-item${conv.id === activeConvId ? ' active' : ''}`;
    item.dataset.id = conv.id;
    const icon = document.createElement('span');
    icon.className = 'conv-icon';
    icon.textContent = conv.type === 'global' ? '🌐' : '👤';
    const name = document.createElement('span');
    name.className = 'conv-name';
    name.textContent = displayNickname(conv.name, conv.ipSuffix);
    item.append(icon, name);
    if (conv.unread > 0) {
      const badge = document.createElement('span');
      badge.className = `conv-unread${conv.type === 'dm' ? ' dm-unread' : ''}`;
      badge.textContent = conv.unread > 99 ? '99+' : String(conv.unread);
      item.appendChild(badge);
    }
    const activate = () => switchConversation(conv.id);
    item.addEventListener('click', activate);
    makeKeyboardClickable(item, activate);
    convListEl.appendChild(item);
  }
}

function renderOnlineList(users) {
  onlineCountEl.textContent = String(users.length);
  onlineListEl.replaceChildren();
  users.forEach(user => {
    const nick = user.nickname;
    const ipSuffix = user.ip_suffix || '';
    const item = document.createElement('li');
    item.className = 'online-item';
    const dot = document.createElement('span');
    dot.className = 'online-dot';
    const nickElement = document.createElement('span');
    nickElement.className = `online-nick${nick === myNickname ? ' is-me' : ''}`;
    nickElement.textContent = displayNickname(nick, ipSuffix) + (nick === myNickname ? ' (나)' : '');
    item.append(dot, nickElement);
    if (nick !== myNickname) {
      const openDm = () => {
        getOrCreateDm(nick, ipSuffix);
        renderConversationList();
        switchConversation(nick);
      };
      const dmButton = document.createElement('button');
      dmButton.type = 'button';
      dmButton.className = 'online-dm-btn';
      dmButton.textContent = 'DM';
      dmButton.setAttribute('aria-label', `${nick}님에게 DM`);
      dmButton.addEventListener('click', event => {
        event.stopPropagation();
        openDm();
      });
      item.appendChild(dmButton);
      item.addEventListener('click', openDm);
      makeKeyboardClickable(item, openDm);
    }
    onlineListEl.appendChild(item);
  });
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = date.toDateString() === new Date().toDateString();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return today ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validLink(href) {
  try {
    const url = new URL(href, location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function appendInlineMarkdown(parent, source) {
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
        node = document.createElement('a');
        node.href = url.href;
        node.textContent = match[5];
        node.target = '_blank';
        node.rel = 'noopener noreferrer';
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

function appendParagraph(container, lines) {
  const paragraph = document.createElement('p');
  lines.forEach((line, index) => {
    if (index) paragraph.appendChild(document.createElement('br'));
    appendInlineMarkdown(paragraph, line);
  });
  container.appendChild(paragraph);
}

function renderMarkdown(container, source) {
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
    if (/^\s*[-+]\s+/.test(lines[index])) {
      const list = document.createElement('ul');
      while (index < lines.length && /^\s*[-+]\s+/.test(lines[index])) {
        const item = document.createElement('li');
        appendInlineMarkdown(item, lines[index].replace(/^\s*[-+]\s+/, ''));
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
      !/^\s*[-+]\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    appendParagraph(container, paragraphLines);
  }
}

function createReplyQuote(reply) {
  if (!reply) return null;
  const quote = document.createElement('div');
  quote.className = 'message-reply-quote';
  const name = document.createElement('strong');
  name.textContent = reply.nickname || '메시지';
  const text = document.createElement('span');
  text.textContent = reply.content || '첨부 파일';
  quote.append(name, text);
  return quote;
}

function createAttachmentCard(attachment) {
  if (!attachment) return null;
  const card = document.createElement('a');
  card.className = `attachment-card${attachment.previewable ? ' image-attachment' : ''}`;
  card.href = attachment.url;
  card.target = '_blank';
  card.rel = 'noopener';
  if (!attachment.previewable) card.download = attachment.name;
  if (attachment.previewable) {
    const image = document.createElement('img');
    image.src = attachment.url;
    image.alt = attachment.name;
    image.loading = 'lazy';
    card.appendChild(image);
  }
  const icon = document.createElement('span');
  icon.className = 'attachment-icon';
  icon.textContent = attachment.previewable ? '🖼️' : '📄';
  const info = document.createElement('span');
  info.className = 'attachment-info';
  const name = document.createElement('strong');
  name.textContent = attachment.name;
  const meta = document.createElement('small');
  meta.textContent = `${formatBytes(attachment.size)} · SHA-256 ${attachment.sha256.slice(0, 12)}…`;
  info.append(name, meta);
  card.append(icon, info);
  return card;
}

function messageAuthor(msg) {
  if (msg.msgType === 'chat') return msg.nickname;
  return msg.from_nick;
}

function replySummary(msg) {
  return {
    nickname: messageAuthor(msg) || '메시지',
    content: (msg.content || msg.attachment?.name || '첨부 파일').slice(0, 180),
  };
}

function createMessageActions(msg) {
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const replyButton = document.createElement('button');
  replyButton.type = 'button';
  replyButton.textContent = '답장';
  replyButton.addEventListener('click', () => {
    replyTargets.set(activeConvId, replySummary(msg));
    renderComposerPreviews();
    msgInput.focus();
  });
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = '복사';
  copyButton.addEventListener('click', () => copyText(msg.content || msg.attachment?.name || '', '메시지를 복사했습니다.'));
  actions.append(replyButton, copyButton);
  return actions;
}

function appendMessageNode(msg) {
  if (msg.msgType === 'system') {
    const row = document.createElement('div');
    row.className = 'msg-row system';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = msg.content;
    row.appendChild(bubble);
    messageListEl.appendChild(row);
    return;
  }

  const isChat = msg.msgType === 'chat';
  const isOwn = isChat ? msg.nickname === myNickname : msg.from_nick === myNickname;
  const row = document.createElement('article');
  row.className = `msg-row ${isChat ? (isOwn ? 'own' : 'other') : (isOwn ? 'dm-own' : 'dm-recv')}`;
  if (msg.message_id) row.dataset.messageId = msg.message_id;

  if (isChat) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const nick = document.createElement('span');
    nick.className = 'nick';
    nick.textContent = displayNickname(msg.nickname, msg.ip_suffix);
    const time = document.createElement('time');
    time.dateTime = msg.created_at || '';
    time.textContent = formatTime(msg.created_at);
    meta.append(nick, time);
    row.appendChild(meta);
  } else {
    const label = document.createElement('div');
    label.className = 'dm-label';
    label.textContent = isOwn
      ? `→ ${displayNickname(msg.to_nick, msg.to_ip_suffix)}`
      : `← ${displayNickname(msg.from_nick, msg.from_ip_suffix)}`;
    const time = document.createElement('time');
    time.className = 'dm-time';
    time.dateTime = msg.created_at || '';
    time.textContent = formatTime(msg.created_at);
    row.append(label, time);
  }

  const shell = document.createElement('div');
  shell.className = 'message-shell';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble markdown-body';
  const reply = createReplyQuote(msg.reply);
  if (reply) bubble.appendChild(reply);
  if (msg.content) {
    const markdown = document.createElement('div');
    renderMarkdown(markdown, msg.content);
    bubble.appendChild(markdown);
  }
  const attachment = createAttachmentCard(msg.attachment);
  if (attachment) bubble.appendChild(attachment);
  shell.append(bubble, createMessageActions(msg));
  row.appendChild(shell);
  messageListEl.appendChild(row);
}

function renderMessages() {
  messageListEl.replaceChildren();
  const conv = conversations.get(activeConvId);
  if (!conv) return;
  conv.messages.forEach(appendMessageNode);
  scrollBottom();
}

function addMessage(convId, msg) {
  const conv = conversations.get(convId);
  if (!conv) return false;
  if (msg.message_id && conv.messageIds.has(msg.message_id)) return false;
  if (msg.message_id) conv.messageIds.add(msg.message_id);
  conv.messages.push(msg);
  if (convId === activeConvId) {
    appendMessageNode(msg);
    scrollBottom();
  } else {
    conv.unread += 1;
    renderConversationList();
  }
  return true;
}

function addSystemMessage(convId, text) {
  addMessage(convId, { msgType: 'system', content: text });
}

function scrollBottom() {
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

function resizeComposer() {
  msgInput.style.height = 'auto';
  msgInput.style.height = `${Math.min(msgInput.scrollHeight, 156)}px`;
}

function updateCharCount() {
  charCount.textContent = `${msgInput.value.length} / ${MAX_MSG_LEN}`;
  charCount.classList.toggle('near-limit', msgInput.value.length > MAX_MSG_LEN * 0.9);
}

function renderComposerPreviews() {
  const reply = replyTargets.get(activeConvId);
  replyPreview.classList.toggle('hidden', !reply);
  if (reply) {
    replyPreviewName.textContent = `↩ ${reply.nickname}`;
    replyPreviewText.textContent = reply.content;
  }

  const state = pendingAttachments.get(activeConvId);
  attachmentPreview.classList.toggle('hidden', !state);
  if (state) {
    attachmentPreviewName.textContent = state.name;
    if (state.status === 'uploading') {
      attachmentPreviewMeta.textContent = `업로드 중 · ${Math.round(state.progress || 0)}%`;
      uploadProgressTrack.classList.remove('hidden');
      uploadProgressBar.style.width = `${state.progress || 0}%`;
    } else if (state.status === 'ready') {
      attachmentPreviewMeta.textContent = `${formatBytes(state.meta.size)} · 준비됨`;
      uploadProgressTrack.classList.add('hidden');
    } else {
      attachmentPreviewMeta.textContent = state.error || '업로드 실패';
      uploadProgressTrack.classList.add('hidden');
    }
  }
  const uploading = state?.status === 'uploading';
  sendBtn.disabled = !isConnected() || uploading;
}

function isConnected() {
  return Boolean(ws && ws.readyState === WebSocket.OPEN);
}

function sendMessage() {
  const content = msgInput.value.trim();
  const attachmentState = pendingAttachments.get(activeConvId);
  if (attachmentState?.status === 'uploading') {
    showToast('파일 업로드가 끝날 때까지 기다려 주세요.', 'warning');
    return;
  }
  if (attachmentState?.status === 'error') {
    showToast('실패한 첨부 파일을 제거해 주세요.', 'error');
    return;
  }
  if (!content && !attachmentState?.meta) return;
  if (content.length > MAX_MSG_LEN) {
    showToast(`메시지는 ${MAX_MSG_LEN}자 이하여야 합니다.`, 'error');
    return;
  }
  if (!isConnected()) {
    addSystemMessage(activeConvId, '⚠️ 서버에 연결되지 않았습니다.');
    return;
  }

  const payload = {
    type: activeConvId === GLOBAL_ID ? 'chat' : 'dm',
    content,
  };
  if (activeConvId !== GLOBAL_ID) payload.to = activeConvId;
  if (attachmentState?.meta) payload.attachment_id = attachmentState.meta.id;
  const reply = replyTargets.get(activeConvId);
  if (reply) payload.reply = reply;
  ws.send(JSON.stringify(payload));

  msgInput.value = '';
  delete drafts[activeConvId];
  persistDrafts();
  replyTargets.delete(activeConvId);
  pendingAttachments.delete(activeConvId);
  resizeComposer();
  updateCharCount();
  renderComposerPreviews();
  msgInput.focus();
}

msgInput.addEventListener('input', () => {
  drafts[activeConvId] = msgInput.value;
  if (!msgInput.value) delete drafts[activeConvId];
  persistDrafts();
  resizeComposer();
  updateCharCount();
});
msgInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});
sendBtn.addEventListener('click', sendMessage);
replyCancel.addEventListener('click', () => {
  replyTargets.delete(activeConvId);
  renderComposerPreviews();
  msgInput.focus();
});

function chooseFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    showToast(`파일은 ${MAX_FILE_MB}MB 이하여야 합니다.`, 'error');
    return;
  }
  clearPendingAttachment(activeConvId, true);
  uploadAttachment(activeConvId, file);
}

function uploadAttachment(convId, file) {
  const state = { status: 'uploading', name: file.name, progress: 0, xhr: null, meta: null };
  pendingAttachments.set(convId, state);
  renderComposerPreviews();
  const xhr = new XMLHttpRequest();
  state.xhr = xhr;
  xhr.open('POST', '/api/files');
  xhr.setRequestHeader('X-Chat-Nickname', myNickname);
  xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.upload.addEventListener('progress', event => {
    if (!event.lengthComputable) return;
    state.progress = Math.round((event.loaded / event.total) * 100);
    if (activeConvId === convId) renderComposerPreviews();
  });
  xhr.addEventListener('load', () => {
    let response = {};
    try { response = JSON.parse(xhr.responseText || '{}'); } catch { /* invalid error payload */ }
    if (xhr.status === 201) {
      state.status = 'ready';
      state.progress = 100;
      state.meta = response;
    } else {
      state.status = 'error';
      state.error = response.detail || `업로드 실패 (${xhr.status})`;
      showToast(state.error, 'error');
    }
    if (activeConvId === convId) renderComposerPreviews();
  });
  xhr.addEventListener('error', () => {
    state.status = 'error';
    state.error = '네트워크 오류로 업로드하지 못했습니다.';
    if (activeConvId === convId) renderComposerPreviews();
  });
  xhr.addEventListener('abort', () => {
    if (pendingAttachments.get(convId) === state) pendingAttachments.delete(convId);
    if (activeConvId === convId) renderComposerPreviews();
  });
  xhr.send(file);
}

async function clearPendingAttachment(convId, discardRemote = true) {
  const state = pendingAttachments.get(convId);
  if (!state) return;
  pendingAttachments.delete(convId);
  if (state.status === 'uploading' && state.xhr) state.xhr.abort();
  if (discardRemote && state.status === 'ready' && state.meta?.id) {
    try {
      await fetch(`/api/files/${encodeURIComponent(state.meta.id)}`, {
        method: 'DELETE',
        headers: { 'X-Chat-Nickname': myNickname },
      });
    } catch { /* automatic expiry is the fallback */ }
  }
  if (activeConvId === convId) renderComposerPreviews();
}

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  chooseFile(fileInput.files?.[0]);
  fileInput.value = '';
});
attachmentRemove.addEventListener('click', () => clearPendingAttachment(activeConvId));

chatArea.addEventListener('dragenter', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  dropOverlay.classList.remove('hidden');
});
chatArea.addEventListener('dragover', event => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
chatArea.addEventListener('dragleave', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.classList.add('hidden');
});
chatArea.addEventListener('drop', event => {
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add('hidden');
  chooseFile(event.dataTransfer?.files?.[0]);
});
msgInput.addEventListener('paste', event => {
  const file = [...(event.clipboardData?.files || [])][0];
  if (file) {
    event.preventDefault();
    chooseFile(file);
  }
});

async function copyText(text, successMessage) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage, 'success');
  } catch {
    showToast('클립보드에 복사하지 못했습니다.', 'error');
  }
}

function showToast(message, tone = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  toastRegion.replaceChildren(toast);
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 3200);
}

function setConnected(connected) {
  connStatus.textContent = connected ? '연결됨' : '연결 끊김';
  connStatus.className = `conn-status ${connected ? 'connected' : 'disconnected'}`;
  msgInput.disabled = !connected;
  attachBtn.disabled = !connected;
  renderComposerPreviews();
}

function getWsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${location.host}/ws?nickname=${encodeURIComponent(myNickname)}`;
}

function initWebSocket() {
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
  }
  nicknameRejected = false;
  lastNicknameError = '';
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    setConnected(true);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = event => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    switch (data.type) {
      case 'chat':
        addMessage(GLOBAL_ID, {
          msgType: 'chat',
          message_id: data.message_id,
          nickname: data.nickname,
          ip_suffix: data.ip_suffix || '',
          content: data.content || '',
          created_at: data.created_at,
          reply: data.reply || null,
          attachment: data.attachment || null,
        });
        break;
      case 'dm': {
        const partner = data.from_nick === myNickname ? data.to_nick : data.from_nick;
        const partnerIpSuffix = data.from_nick === myNickname
          ? (data.to_ip_suffix || '')
          : (data.from_ip_suffix || '');
        getOrCreateDm(partner, partnerIpSuffix);
        renderConversationList();
        addMessage(partner, {
          msgType: 'dm',
          message_id: data.message_id,
          from_nick: data.from_nick,
          to_nick: data.to_nick,
          from_ip_suffix: data.from_ip_suffix || '',
          to_ip_suffix: data.to_ip_suffix || '',
          content: data.content || '',
          created_at: data.created_at,
          reply: data.reply || null,
          attachment: data.attachment || null,
        });
        break;
      }
      case 'presence':
        break;
      case 'users':
        renderOnlineList(Array.isArray(data.list) ? data.list : []);
        break;
      case 'error_nickname':
        nicknameRejected = true;
        lastNicknameError = data.message || '닉네임이 이미 사용 중입니다.';
        break;
      case 'error':
        addSystemMessage(activeConvId, `⚠️ ${data.message}`);
        showToast(data.message || '요청을 처리하지 못했습니다.', 'error');
        break;
    }
  };

  ws.onclose = () => {
    setConnected(false);
    renderOnlineList([]);
    if (nicknameRejected) {
      chatApp.classList.add('hidden');
      myNickname = '';
      localStorage.removeItem(STORAGE_KEY);
      showNicknameModal(lastNicknameError);
      nicknameRejected = false;
    } else {
      scheduleReconnect();
    }
  };
  ws.onerror = () => setConnected(false);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  addSystemMessage(activeConvId, '연결이 끊어졌습니다. 재연결을 시도합니다...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (myNickname) initWebSocket();
  }, RECONNECT_DELAY);
}

window.addEventListener('beforeunload', saveCurrentDraft);
resizeComposer();
updateCharCount();
setConnected(false);
showNicknameModal();
