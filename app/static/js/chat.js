// ============================================================
// Chat Module: Message Rendering, Attachments, Composer & Mentions
// ============================================================

import { state } from './state.js';
import { renderMarkdown, highlightMentions, formatTime, formatBytes, showToast } from './utils.js';
import { openReactionPicker, renderMessageReactions } from './reactions.js';
import { toggleMessagePin } from './pins.js';
import { displayNickname, userDirectory } from './dm.js';
import { channelsDirectory } from './channels.js';

export const replyTargets = new Map();
export const pendingAttachments = new Map();
let drafts = {};
let attachmentSequence = 0;
let mentionUsers = [];
let mentionMatches = [];
let mentionActiveIndex = 0;
let mentionRange = null;

const MAX_PARALLEL_UPLOADS = 2;

function draftsKey() {
  return state.currentUser ? `bamboochat_drafts_${state.currentUser.id}` : '';
}

export function loadDrafts() {
  try {
    const value = JSON.parse(localStorage.getItem(draftsKey()) || '{}');
    drafts = value && typeof value === 'object' ? value : {};
  } catch {
    drafts = {};
  }
}

export function persistDrafts() {
  if (!state.currentUser) return;
  try {
    localStorage.setItem(draftsKey(), JSON.stringify(drafts));
  } catch { /* ignore */ }
}

export function saveCurrentDraft() {
  const currentKey = `${state.activeRoom.type}:${state.activeRoom.id}`;
  const msgInput = document.getElementById('msg-input');
  if (!msgInput) return;
  const value = msgInput.value;
  if (value) drafts[currentKey] = value;
  else delete drafts[currentKey];
  persistDrafts();
}

export function loadActiveDraft() {
  const currentKey = `${state.activeRoom.type}:${state.activeRoom.id}`;
  const msgInput = document.getElementById('msg-input');
  if (!msgInput) return;
  msgInput.value = drafts[currentKey] || '';
  resizeComposer();
  updateCharCount();
}

export function resizeComposer() {
  const msgInput = document.getElementById('msg-input');
  if (!msgInput) return;
  msgInput.style.height = 'auto';
  msgInput.style.height = `${Math.min(msgInput.scrollHeight, 156)}px`;
}

export function updateCharCount() {
  const msgInput = document.getElementById('msg-input');
  const charCount = document.getElementById('char-count');
  if (!msgInput || !charCount) return;
  const maxLen = msgInput.maxLength || 2000;
  charCount.textContent = `${msgInput.value.length} / ${maxLen}`;
  charCount.classList.toggle('near-limit', msgInput.value.length > maxLen * 0.9);
}

export function setMentionUsers(users) {
  mentionUsers = users || [];
}

export function getMentionContext() {
  const msgInput = document.getElementById('msg-input');
  if (!msgInput || state.activeRoom.type !== 'channel' || msgInput.selectionStart !== msgInput.selectionEnd) return null;
  const caret = msgInput.selectionStart;
  const beforeCaret = msgInput.value.slice(0, caret);
  const match = beforeCaret.match(/(^|[^\p{L}\p{N}._@-])@([\p{L}\p{N}._-]*)$/u);
  if (!match) return null;
  return { start: caret - match[2].length - 1, end: caret, query: match[2] };
}

export function closeMentionMenu() {
  const mentionMenu = document.getElementById('mention-menu');
  if (!mentionMenu) return;
  mentionMenu.classList.add('hidden');
  mentionMenu.replaceChildren();
  mentionMatches = [];
  mentionRange = null;
  mentionActiveIndex = 0;
}

export function setMentionActiveIndex(index) {
  const mentionMenu = document.getElementById('mention-menu');
  if (!mentionMatches.length || !mentionMenu) return;
  mentionActiveIndex = (index + mentionMatches.length) % mentionMatches.length;
  [...mentionMenu.children].forEach((item, itemIndex) => {
    const selected = itemIndex === mentionActiveIndex;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-selected', String(selected));
    if (selected) item.scrollIntoView({ block: 'nearest' });
  });
}

export function selectMention(user = mentionMatches[mentionActiveIndex]) {
  const msgInput = document.getElementById('msg-input');
  if (!user || !mentionRange || !msgInput) return;
  const before = msgInput.value.slice(0, mentionRange.start);
  const after = msgInput.value.slice(mentionRange.end);
  const inserted = `@${user.username} `;
  msgInput.value = before + inserted + after;
  const caret = before.length + inserted.length;
  msgInput.setSelectionRange(caret, caret);
  closeMentionMenu();
  msgInput.dispatchEvent(new Event('input', { bubbles: true }));
  msgInput.focus();
}

export function updateMentionMenu() {
  const mentionMenu = document.getElementById('mention-menu');
  if (!mentionMenu) return;
  const context = getMentionContext();
  if (!context || !mentionUsers.length) {
    closeMentionMenu();
    return;
  }
  const myUserId = state.currentUser ? Number(state.currentUser.id) : null;
  const query = context.query.toLocaleLowerCase();
  mentionRange = context;
  mentionMatches = mentionUsers.filter(user => {
    if (Number(user.id) === myUserId) return false;
    const username = String(user.username || '').toLocaleLowerCase();
    const displayName = String(user.display_name || '').toLocaleLowerCase();
    return username.startsWith(query) || displayName.startsWith(query);
  });
  if (!mentionMatches.length) {
    closeMentionMenu();
    return;
  }
  mentionActiveIndex = Math.min(mentionActiveIndex, mentionMatches.length - 1);
  mentionMenu.replaceChildren();
  mentionMatches.forEach((user, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = `mention-option${index === mentionActiveIndex ? ' active' : ''}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(index === mentionActiveIndex));
    const nameLabel = document.createElement('span');
    const userDisplayName = user.display_name || user.username;
    nameLabel.textContent = userDisplayName !== user.username
      ? `${userDisplayName} (@${user.username})`
      : `@${user.username}`;
    const presence = document.createElement('span');
    presence.className = `mention-presence${user.online ? ' online' : ''}`;
    presence.textContent = user.online ? '온라인' : '오프라인';
    option.append(nameLabel, presence);
    option.addEventListener('mousedown', event => event.preventDefault());
    option.addEventListener('click', () => selectMention(user));
    mentionMenu.appendChild(option);
  });
  mentionMenu.classList.remove('hidden');
}

export function normaliseMessageAttachments(msg) {
  if (Array.isArray(msg.attachments)) return msg.attachments;
  if (msg.attachment) return [msg.attachment];
  if (msg.attachment_removed) return [{ id: 'removed', name: '파일', removed: true }];
  return [];
}

export function createAttachmentRemovedNotice(attachment) {
  const notice = document.createElement('div');
  notice.className = 'attachment-removed';
  notice.setAttribute('role', 'status');
  notice.textContent = `🗑️ ${attachment.name || '파일'} · 업로더가 삭제함`;
  return notice;
}

export function createAttachmentEntry(attachment) {
  const entry = document.createElement('div');
  entry.className = 'attachment-entry';
  if (attachment.removed) {
    entry.appendChild(createAttachmentRemovedNotice(attachment));
    return entry;
  }

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
  meta.textContent = `${formatBytes(attachment.size)} · SHA-256 ${(attachment.sha256 || '').slice(0, 12)}…`;
  info.append(name, meta);
  card.append(icon, info);
  entry.appendChild(card);

  const myUserId = state.currentUser ? Number(state.currentUser.id) : null;
  if (Number(attachment.owner_id) === myUserId || state.currentUser?.role === 'admin') {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-delete-btn';
    remove.textContent = '파일 삭제';
    remove.setAttribute('aria-label', `${attachment.name} 삭제`);
    remove.addEventListener('click', async () => {
      if (!confirm('파일만 삭제할까요? 채팅 메시지는 그대로 유지됩니다.')) return;
      try {
        const response = await fetch(`/api/files/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('파일 삭제 실패');
        showToast('파일을 삭제했습니다.', 'success');
      } catch (err) {
        showToast(err.message || '파일 삭제 실패', 'error');
      }
    });
    entry.appendChild(remove);
  }
  return entry;
}

export function createReplyQuote(reply) {
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

export function createMessageActions(msg) {
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const isChat = msg.msgType === 'chat';
  const myNick = state.currentUser ? state.currentUser.username : '';
  const isOwn = isChat ? msg.nickname === myNick : msg.from_nick === myNick;
  const isAdmin = state.currentUser?.role === 'admin';

  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.textContent = '답장';
  replyBtn.addEventListener('click', () => {
    const currentKey = `${state.activeRoom.type}:${state.activeRoom.id}`;
    const authorNick = isChat ? msg.nickname : msg.from_nick;
    replyTargets.set(currentKey, {
      nickname: authorNick || '메시지',
      content: (msg.content || '첨부 파일').slice(0, 180),
    });
    renderComposerPreviews();
    document.getElementById('msg-input')?.focus();
  });
  actions.appendChild(replyBtn);

  const reactBtn = document.createElement('button');
  reactBtn.type = 'button';
  reactBtn.className = 'msg-action-react-btn';
  reactBtn.textContent = '반응';
  reactBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openReactionPicker(msg, reactBtn);
  });
  actions.appendChild(reactBtn);

  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.className = 'msg-action-pin-btn';
  pinBtn.textContent = msg.is_pinned ? '고정 해제' : '고정';
  pinBtn.addEventListener('click', () => toggleMessagePin(msg));
  actions.appendChild(pinBtn);

  if (isOwn) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = '수정';
    editBtn.addEventListener('click', () => startInlineMessageEdit(msg));
    actions.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger';
    delBtn.textContent = '삭제';
    delBtn.addEventListener('click', () => deleteMessage(msg));
    actions.appendChild(delBtn);
  }

  if (isAdmin && isChat) {
    const moveBtn = document.createElement('button');
    moveBtn.type = 'button';
    moveBtn.textContent = '이동';
    moveBtn.addEventListener('click', () => openMoveMessageModal(msg));
    actions.appendChild(moveBtn);
  }

  return actions;
}

export function openMoveMessageModal(msg) {
  const moveMessageModal = document.getElementById('move-message-modal');
  const moveMessageId = document.getElementById('move-message-id');
  const moveMessageChannelSelect = document.getElementById('move-message-channel-select');
  const moveMessageError = document.getElementById('move-message-error');
  if (!moveMessageModal || !msg) return;

  const rawId = String(msg.message_id || '').replace(/^public:/, '');
  if (moveMessageId) moveMessageId.value = rawId;
  if (moveMessageError) moveMessageError.textContent = '';
  if (moveMessageChannelSelect) {
    moveMessageChannelSelect.replaceChildren();
    const currentChanId = Number(msg.channel_id || 1);
    const eligible = Array.from(channelsDirectory.values())
      .filter(chan => !chan.archived && Number(chan.id) !== currentChanId);
    eligible.forEach(chan => {
      const opt = document.createElement('option');
      opt.value = String(chan.id);
      opt.textContent = `# ${chan.display_name} (${chan.name})`;
      moveMessageChannelSelect.appendChild(opt);
    });
    if (eligible.length === 0) {
      showToast('이동할 수 있는 다른 활성 채널이 없습니다.', 'warning');
      return;
    }
  }
  moveMessageModal.classList.remove('hidden');
}

export async function deleteMessage(msg) {
  if (!confirm('이 메시지를 정말로 삭제하시겠습니까?')) return;
  const isChat = msg.msgType === 'chat';
  const rawId = typeof msg.message_id === 'string' ? msg.message_id.replace(/^(public|dm):/, '') : String(msg.id || '');
  const numId = Number(rawId);
  if (!numId) return;

  const endpoint = isChat ? `/api/messages/${numId}` : `/api/dm/messages/${numId}`;
  try {
    const res = await fetch(endpoint, { method: 'DELETE' });
    if (!res.ok) throw new Error('메시지 삭제 실패');
    showToast('메시지를 삭제했습니다.', 'info');
  } catch (err) {
    showToast(err.message || '메시지 삭제 실패', 'error');
  }
}

export function startInlineMessageEdit(msg) {
  const formattedId = msg.message_id;
  const row = document.querySelector(`.msg-row[data-message-id="${formattedId}"]`);
  if (!row) return;

  const bubble = row.querySelector('.msg-bubble');
  if (!bubble) return;

  const originalContent = msg.content || '';
  const originalHtml = bubble.innerHTML;

  row.classList.add('is-editing');
  bubble.replaceChildren();

  const editBox = document.createElement('div');
  editBox.className = 'inline-edit-box';

  const textarea = document.createElement('textarea');
  textarea.className = 'inline-edit-input';
  textarea.value = originalContent;

  const actionsBox = document.createElement('div');
  actionsBox.className = 'inline-edit-actions';

  const hint = document.createElement('span');
  hint.className = 'inline-edit-hint';
  hint.textContent = 'ESC: 취소 · Enter: 저장 · Shift+Enter: 줄바꿈';

  const btnGroup = document.createElement('div');
  btnGroup.className = 'inline-edit-btn-group';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'inline-edit-cancel';
  cancelBtn.textContent = '취소';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'inline-edit-save';
  saveBtn.textContent = '저장';

  const cancelEdit = () => {
    row.classList.remove('is-editing');
    bubble.innerHTML = originalHtml;
  };

  const saveEdit = async () => {
    const newContent = textarea.value.trim();
    if (!newContent) {
      showToast('메시지 내용을 입력해 주세요.', 'warning');
      return;
    }
    const isChat = msg.msgType === 'chat';
    const rawId = typeof msg.message_id === 'string' ? msg.message_id.replace(/^(public|dm):/, '') : String(msg.id || '');
    const numId = Number(rawId);
    const endpoint = isChat ? `/api/messages/${numId}` : `/api/dm/messages/${numId}`;

    saveBtn.disabled = true;
    try {
      const res = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent }),
      });
      if (!res.ok) throw new Error('메시지 수정 실패');
      msg.content = newContent;
      msg.edited_at = new Date().toISOString();
      row.classList.remove('is-editing');
      bubble.replaceChildren();
      const markdown = document.createElement('div');
      renderMarkdown(markdown, newContent);
      highlightMentions(markdown, msg.mentions);
      const editedBadge = document.createElement('span');
      editedBadge.className = 'msg-edited-badge';
      editedBadge.textContent = '(수정됨)';
      markdown.appendChild(editedBadge);
      bubble.appendChild(markdown);
      showToast('메시지가 수정되었습니다.', 'success');
    } catch (err) {
      showToast(err.message || '메시지 수정 실패', 'error');
      saveBtn.disabled = false;
    }
  };

  cancelBtn.addEventListener('click', cancelEdit);
  saveBtn.addEventListener('click', saveEdit);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      saveEdit();
    }
  });

  btnGroup.append(cancelBtn, saveBtn);
  actionsBox.append(hint, btnGroup);
  editBox.append(textarea, actionsBox);
  bubble.appendChild(editBox);
  textarea.focus();
}

export function appendMessageNode(msg, previousMsg) {
  const messageListEl = document.getElementById('message-list');
  if (!messageListEl) return;

  const isChat = msg.msgType === 'chat'
    || (state.activeRoom && state.activeRoom.type === 'channel')
    || Boolean(msg.channel_id)
    || Boolean(msg.nickname && !msg.from_nick);

  const myNick = state.currentUser ? state.currentUser.username : '';
  const isOwn = isChat
    ? (msg.nickname === myNick || (state.currentUser && Number(msg.author_id) === Number(state.currentUser.id)))
    : (msg.from_nick === myNick || (state.currentUser && Number(msg.from_user_id) === Number(state.currentUser.id)));

  const row = document.createElement('article');
  row.className = `msg-row ${isChat ? (isOwn ? 'own' : 'other') : (isOwn ? 'dm-own' : 'dm-recv')}`;
  if (msg.is_hidden) row.classList.add('hidden-msg');
  if (msg.is_pinned) row.classList.add('pinned');
  if (msg.message_id) row.dataset.messageId = msg.message_id;

  if (isChat) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const nick = document.createElement('span');
    nick.className = 'nick';
    const rawNick = msg.nickname || (msg.author_id ? `user-${msg.author_id}` : '익명');
    const displayName = displayNickname(rawNick);
    nick.textContent = displayName;
    nick.title = displayName !== rawNick ? `${displayName} (@${rawNick})` : `@${rawNick}`;
    meta.append(nick);

    if (msg.quiz_badge) {
      const badgeSpan = document.createElement('span');
      badgeSpan.className = `quiz-user-badge badge-${msg.quiz_badge.type}`;
      badgeSpan.textContent = `${msg.quiz_badge.icon} ${msg.quiz_badge.label}`;
      meta.appendChild(badgeSpan);
    }

    const time = document.createElement('time');
    time.dateTime = msg.created_at || '';
    time.textContent = formatTime(msg.created_at);
    meta.appendChild(time);

    if (msg.is_pinned) {
      const pinBadge = document.createElement('span');
      pinBadge.className = 'pinned-indicator-badge';
      pinBadge.textContent = '📌 고정됨';
      meta.appendChild(pinBadge);
    }
    row.appendChild(meta);
  } else {
    const label = document.createElement('div');
    label.className = 'dm-label';
    const partnerNick = isOwn ? msg.to_nick : msg.from_nick;
    const rawNick = partnerNick || (isOwn ? '나' : '상대방');
    const displayName = displayNickname(rawNick);
    label.textContent = displayName;
    const time = document.createElement('time');
    time.className = 'dm-time';
    time.dateTime = msg.created_at || '';
    time.textContent = formatTime(msg.created_at);
    label.appendChild(time);
    if (msg.is_pinned) {
      const pinBadge = document.createElement('span');
      pinBadge.className = 'pinned-indicator-badge';
      pinBadge.textContent = '📌 고정됨';
      label.appendChild(pinBadge);
    }
    row.appendChild(label);
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
    highlightMentions(markdown, msg.mentions);
    if (msg.edited_at) {
      const editedBadge = document.createElement('span');
      editedBadge.className = 'msg-edited-badge';
      editedBadge.textContent = '(수정됨)';
      markdown.appendChild(editedBadge);
    }
    bubble.appendChild(markdown);
  }
  const attachments = normaliseMessageAttachments(msg);
  if (attachments.length) {
    const group = document.createElement('div');
    group.className = 'message-attachments';
    attachments.forEach(attachment => group.appendChild(createAttachmentEntry(attachment)));
    bubble.appendChild(group);
  }

  const actions = createMessageActions(msg);
  shell.append(bubble, actions);
  row.appendChild(shell);

  const reactionsRow = document.createElement('div');
  reactionsRow.className = 'message-reactions-row';
  renderMessageReactions(msg, reactionsRow);
  row.appendChild(reactionsRow);

  messageListEl.appendChild(row);
}

export function renderMessages(messages = []) {
  const messageListEl = document.getElementById('message-list');
  const loadOlderBtn = document.getElementById('load-older-btn');
  if (!messageListEl) return;
  messageListEl.replaceChildren();
  if (loadOlderBtn) {
    messageListEl.appendChild(loadOlderBtn);
  }
  const isChannel = !state.activeRoom || state.activeRoom.type === 'channel';
  messages.forEach((rawMsg, idx) => {
    const msg = {
      ...rawMsg,
      msgType: rawMsg.msgType || (isChannel ? 'chat' : 'dm')
    };
    appendMessageNode(msg, idx > 0 ? messages[idx - 1] : null);
  });
  scrollBottom();
}



export function scrollBottom() {
  const messageListEl = document.getElementById('message-list');
  if (!messageListEl) return;
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

export function renderComposerPreviews() {
  const currentKey = `${state.activeRoom.type}:${state.activeRoom.id}`;
  const replyPreview = document.getElementById('reply-preview');
  const replyPreviewName = document.getElementById('reply-preview-name');
  const replyPreviewText = document.getElementById('reply-preview-text');
  const attachmentPreview = document.getElementById('attachment-preview');
  const attachmentList = document.getElementById('attachment-list');
  const sendBtn = document.getElementById('send-btn');

  const reply = replyTargets.get(currentKey);
  if (replyPreview) replyPreview.classList.toggle('hidden', !reply);
  if (reply) {
    if (replyPreviewName) replyPreviewName.textContent = `↩ ${reply.nickname}`;
    if (replyPreviewText) replyPreviewText.textContent = reply.content;
  }

  const states = pendingAttachments.get(currentKey) || [];
  if (attachmentPreview) attachmentPreview.classList.toggle('hidden', states.length === 0);
  if (attachmentList) {
    attachmentList.replaceChildren();
    for (const st of states) {
      const row = document.createElement('div');
      row.className = `attachment-queue-item ${st.status}`;
      const icon = document.createElement('span');
      icon.className = 'attachment-preview-icon';
      icon.textContent = '📎';
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = st.name;
      const meta = document.createElement('span');
      if (st.status === 'queued') meta.textContent = '대기 중';
      if (st.status === 'uploading') meta.textContent = `업로드 중 · ${Math.round(st.progress || 0)}%`;
      if (st.status === 'ready') meta.textContent = `${formatBytes(st.meta.size)} · 준비됨`;
      if (st.status === 'error') meta.textContent = st.error || '업로드 실패';
      info.append(name, meta);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'preview-remove';
      remove.textContent = '×';
      remove.addEventListener('click', () => clearPendingAttachment(currentKey, st.clientId));
      row.append(icon, info, remove);
      attachmentList.appendChild(row);
    }
  }

  const busy = states.some(st => ['queued', 'uploading'].includes(st.status));
  if (sendBtn) sendBtn.disabled = busy;
}

export function clearPendingAttachment(convKey, clientId) {
  const states = pendingAttachments.get(convKey) || [];
  const index = states.findIndex(s => s.clientId === clientId);
  if (index < 0) return;
  const [removed] = states.splice(index, 1);
  if (!states.length) pendingAttachments.delete(convKey);
  if (removed.status === 'uploading' && removed.xhr) removed.xhr.abort();
  renderComposerPreviews();
  processUploadQueue();
}

export function chooseFiles(fileList) {
  const incoming = [...(fileList || [])];
  if (!incoming.length) return;
  const currentKey = `${state.activeRoom.type}:${state.activeRoom.id}`;
  const states = pendingAttachments.get(currentKey) || [];
  for (const file of incoming) {
    if (file.size > 50 * 1024 * 1024) {
      showToast(`${file.name}: 50MB를 초과했습니다.`, 'error');
      continue;
    }
    states.push({
      clientId: ++attachmentSequence,
      status: 'queued',
      name: file.name,
      file,
      progress: 0,
      xhr: null,
      meta: null,
    });
  }
  pendingAttachments.set(currentKey, states);
  renderComposerPreviews();
  processUploadQueue();
}

export function processUploadQueue() {
  let count = 0;
  for (const states of pendingAttachments.values()) {
    count += states.filter(s => s.status === 'uploading').length;
  }
  if (count >= MAX_PARALLEL_UPLOADS) return;
  for (const [convKey, states] of pendingAttachments) {
    for (const st of states) {
      if (count >= MAX_PARALLEL_UPLOADS) return;
      if (st.status !== 'queued') continue;
      startAttachmentUpload(convKey, st);
      count++;
    }
  }
}

export function startAttachmentUpload(convKey, st) {
  st.status = 'uploading';
  const xhr = new XMLHttpRequest();
  st.xhr = xhr;
  xhr.open('POST', '/api/files');
  xhr.setRequestHeader('X-File-Name', encodeURIComponent(st.file.name));
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.upload.addEventListener('progress', event => {
    if (!event.lengthComputable) return;
    st.progress = Math.round((event.loaded / event.total) * 100);
    renderComposerPreviews();
  });
  xhr.addEventListener('load', () => {
    let response = {};
    try { response = JSON.parse(xhr.responseText || '{}'); } catch { /* ignore */ }
    if (xhr.status === 201) {
      st.status = 'ready';
      st.progress = 100;
      st.meta = response;
      st.file = null;
    } else {
      st.status = 'error';
      st.error = response.detail || `업로드 실패 (${xhr.status})`;
      showToast(`${st.name}: ${st.error}`, 'error');
    }
    renderComposerPreviews();
    processUploadQueue();
  });
  xhr.addEventListener('error', () => {
    st.status = 'error';
    st.error = '네트워크 연결이 끊겼습니다.';
    renderComposerPreviews();
    processUploadQueue();
  });
  try {
    xhr.send(st.file);
  } catch {
    st.status = 'error';
    renderComposerPreviews();
    processUploadQueue();
  }
  renderComposerPreviews();
}

export function initChatListeners(onSendMessage) {
  const msgInput = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  const attachBtn = document.getElementById('attach-btn');
  const fileInput = document.getElementById('file-input');
  const replyCancel = document.getElementById('reply-cancel');
  const chatArea = document.querySelector('.chat-area');
  const dropOverlay = document.getElementById('drop-overlay');
  const markdownToolbar = document.getElementById('markdown-toolbar');

  if (markdownToolbar) {
    markdownToolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-markdown]');
      if (!btn || !msgInput) return;
      const action = btn.dataset.markdown;
      const start = msgInput.selectionStart;
      const end = msgInput.selectionEnd;
      const sel = msgInput.value.slice(start, end);

      const wrapMap = {
        bold: ['**', '**', '굵은 텍스트'],
        italic: ['*', '*', '기울임 텍스트'],
        strike: ['~~', '~~', '취소선 텍스트'],
        code: ['`', '`', '코드'],
        codeblock: ['```\n', '\n```', '코드 블록'],
      };

      if (wrapMap[action]) {
        const [open, close, def] = wrapMap[action];
        const rep = open + (sel || def) + close;
        msgInput.setRangeText(rep, start, end, 'end');
        msgInput.setSelectionRange(start + open.length, start + open.length + (sel || def).length);
      }
      msgInput.dispatchEvent(new Event('input', { bubbles: true }));
      msgInput.focus();
    });
  }

  if (msgInput) {
    msgInput.addEventListener('input', () => {
      const currentKey = `${state.activeRoom.type}:${state.activeRoom.id}`;
      drafts[currentKey] = msgInput.value;
      if (!msgInput.value) delete drafts[currentKey];
      persistDrafts();
      resizeComposer();
      updateCharCount();
      updateMentionMenu();
    });

    msgInput.addEventListener('keydown', (event) => {
      if (!event.isComposing && (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        onSendMessage();
      }
    });

    msgInput.addEventListener('click', updateMentionMenu);
  }

  if (sendBtn) sendBtn.addEventListener('click', onSendMessage);
  if (attachBtn && fileInput) attachBtn.addEventListener('click', () => fileInput.click());
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      chooseFiles(fileInput.files);
      fileInput.value = '';
    });
  }

  if (replyCancel) {
    replyCancel.addEventListener('click', () => {
      const currentKey = `${state.activeRoom.type}:${state.activeRoom.id}`;
      replyTargets.delete(currentKey);
      renderComposerPreviews();
      msgInput?.focus();
    });
  }

  if (chatArea && dropOverlay) {
    let dragDepth = 0;
    chatArea.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      dragDepth++;
      dropOverlay.classList.remove('hidden');
    });
    chatArea.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    chatArea.addEventListener('dragleave', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropOverlay.classList.add('hidden');
    });
    chatArea.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      dropOverlay.classList.add('hidden');
      chooseFiles(e.dataTransfer?.files);
    });
  }
}
