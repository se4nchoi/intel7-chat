// ============================================================
// Reactions Module: Emoji Picker & Reaction Management
// ============================================================

import { state } from './state.js';
import { showToast } from './utils.js';

export const REACTION_PALETTE = ['👍', '❤️', '😂', '😮', '😢', '👏', '✅', '❌', '👀'];

let activeReactionPicker = null;

export function closeReactionPicker() {
  if (activeReactionPicker) {
    activeReactionPicker.remove();
    activeReactionPicker = null;
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.reaction-picker-popover') && !e.target.closest('.msg-action-react-btn')) {
    closeReactionPicker();
  }
});

export function openReactionPicker(msg, anchorBtn) {
  if (activeReactionPicker && activeReactionPicker.dataset.msgId === msg.message_id) {
    closeReactionPicker();
    return;
  }
  closeReactionPicker();
  const picker = document.createElement('div');
  picker.className = 'reaction-picker-popover';
  picker.dataset.msgId = msg.message_id;

  const myUserId = state.currentUser ? Number(state.currentUser.id) : null;

  REACTION_PALETTE.forEach(emoji => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reaction-picker-emoji-btn';
    btn.textContent = emoji;
    const isReacted = Array.isArray(msg.reactions) && msg.reactions.some(r => r.emoji === emoji && (r.reacted_by_me || r.users?.some(u => Number(u.id) === myUserId)));
    if (isReacted) btn.classList.add('active');
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeReactionPicker();
      await toggleReaction(msg, emoji);
    });
    picker.appendChild(btn);
  });

  const parentShell = anchorBtn.closest('.message-actions') || anchorBtn.parentElement;
  parentShell.appendChild(picker);
  activeReactionPicker = picker;
}

export async function toggleReaction(msg, emoji) {
  if (!state.currentUser || !msg) return;
  const isChat = msg.msgType === 'chat';
  const rawId = typeof msg.message_id === 'string' ? msg.message_id.replace(/^(public|dm):/, '') : String(msg.id || '');
  const numId = Number(rawId);
  if (!numId) return;

  const endpoint = `/api/messages/${isChat ? 'channel' : 'dm'}/${numId}/reactions/toggle`;


  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || '리액션 처리에 실패했습니다.');
    }
  } catch (err) {
    showToast(err.message || '리액션 처리에 실패했습니다.', 'error');
  }
}

export function renderMessageReactions(msg, container) {
  container.replaceChildren();
  const reactions = Array.isArray(msg.reactions) ? msg.reactions : [];
  if (!reactions.length) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  const myUserId = state.currentUser ? Number(state.currentUser.id) : null;

  reactions.forEach(r => {
    if (!r.count || r.count <= 0) return;
    const isReactedByMe = Boolean(r.reacted_by_me || r.users?.some(u => Number(u.id) === myUserId));
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `reaction-pill${isReactedByMe ? ' reacted-by-me' : ''}`;

    const emojiSpan = document.createElement('span');
    emojiSpan.className = 'reaction-pill-emoji';
    emojiSpan.textContent = r.emoji;

    const countSpan = document.createElement('span');
    countSpan.className = 'reaction-pill-count';
    countSpan.textContent = r.count;

    pill.append(emojiSpan, countSpan);

    if (Array.isArray(r.users) && r.users.length) {
      const names = r.users.map(u => u.display_name || u.username);
      const tooltipText = names.length <= 3
        ? `${names.join(', ')}님이 반응함`
        : `${names.slice(0, 3).join(', ')} 외 ${names.length - 3}명이 반응함`;
      pill.title = tooltipText;
    }

    pill.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleReaction(msg, r.emoji);
    });

    container.appendChild(pill);
  });
}

export function updateMessageReactionsInDOM(formattedId, newReactions) {
  const row = document.querySelector(`.msg-row[data-message-id="${formattedId}"]`);
  if (!row) return;
  const reactionsRow = row.querySelector('.message-reactions-row');
  if (!reactionsRow) return;

  const dummyMsg = {
    message_id: formattedId,
    msgType: formattedId.startsWith('public:') ? 'chat' : 'dm',
    reactions: newReactions,
  };
  renderMessageReactions(dummyMsg, reactionsRow);
}
