// ============================================================
// DMs Module: Direct Messaging, Online User Presence & Directory
// ============================================================

import { state, isConversationMuted } from './state.js';
import { makeKeyboardClickable } from './utils.js';
import { screenshareState, getDmRoomId } from './screenshare.js';

export const userDirectory = new Map();

export function displayNickname(nick) {
  if (state.currentUser && nick === state.currentUser.username && state.currentUser.display_name) {
    return state.currentUser.display_name;
  }
  const entry = userDirectory.get(nick);
  return entry?.display_name || nick;
}

export function getOrCreateDm(nick, partnerUserId = null) {
  const convId = nick;
  const existing = state.dms.find(d => d.name === nick);
  if (!existing) {
    const newDm = {
      id: convId,
      name: nick,
      type: 'dm',
      partnerUserId: partnerUserId,
      messages: [],
      messageIds: new Set(),
      unread: 0,
      hasOlder: false,
      loadingOlder: false,
      lastActivityTime: 0,
    };
    state.dms.push(newDm);
    return newDm;
  }
  if (partnerUserId && !existing.partnerUserId) {
    existing.partnerUserId = partnerUserId;
  }
  return existing;
}

export async function loadGroupDms(onSwitchConv) {
  if (!state.currentUser) return;
  try {
    const res = await fetch('/api/group-dms', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data)) {
      state.groupDms = data;
      data.forEach(g => {
        if (typeof g.unread_count === 'number') {
          state.unreadCounts.channels[String(g.id)] = g.unread_count;
        }
      });
      if (typeof onSwitchConv === 'function') {
        renderDms(onSwitchConv);
      }
    }
  } catch (err) {
    console.debug('Failed to load group DMs:', err);
  }
}

export async function loadCandidateUsers() {
  try {
    const res = await fetch('/api/group-dms/users', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) return data;
    }
  } catch { /* fallback to userDirectory below */ }

  const myNick = state.currentUser?.username;
  const list = [];
  for (const [uname, u] of userDirectory.entries()) {
    if (uname !== myNick) {
      list.push({
        id: u.id,
        username: u.username,
        display_name: u.display_name || u.nickname || u.username,
        online: Boolean(u.online),
      });
    }
  }
  return list;
}

export function renderDms(onSwitchConv) {
  const dmListEl = document.getElementById('dm-list');
  if (!dmListEl) return;
  dmListEl.replaceChildren();
  const groupDmListEl = document.getElementById('group-dm-list') || dmListEl;
  if (groupDmListEl !== dmListEl) groupDmListEl.replaceChildren();

  // 1. Group DMs (own sidebar section)
  const groupDms = Array.isArray(state.groupDms) ? state.groupDms : [];
  groupDms.forEach(gdm => {
    const isActive = state.activeRoom.type === 'channel' && String(state.activeRoom.id) === String(gdm.id);
    const item = document.createElement('li');
    item.className = `sidebar-item conv-item dm-item group-dm-item${isActive ? ' active' : ''}`;
    item.dataset.id = gdm.id;
    item.dataset.type = 'group_dm';

    const icon = document.createElement('span');
    icon.className = 'conv-icon group-dm-icon';
    icon.textContent = '👥';

    const name = document.createElement('span');
    name.className = 'sidebar-item-name conv-name';
    name.textContent = gdm.effective_name || gdm.display_name || '그룹 대화';

    const countPill = document.createElement('span');
    countPill.className = 'group-dm-count-pill';
    countPill.textContent = String(gdm.member_count || gdm.members?.length || 0);
    countPill.title = `참여자 ${countPill.textContent}명`;

    item.append(icon, name, countPill);

    if (isConversationMuted('channel', gdm.id)) {
      const muteIcon = document.createElement('span');
      muteIcon.className = 'conv-mute-indicator';
      muteIcon.textContent = '🔕';
      muteIcon.title = '음소거됨';
      item.appendChild(muteIcon);
    }

    const unreadCount = state.unreadCounts.channels[String(gdm.id)] ?? gdm.unread_count ?? 0;
    if (unreadCount > 0 && !isActive) {
      const badge = document.createElement('span');
      badge.className = 'sidebar-badge conv-unread dm-unread';
      badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      item.appendChild(badge);
    }

    const activate = () => onSwitchConv('channel', gdm.id);
    item.addEventListener('click', activate);
    makeKeyboardClickable(item, activate);
    groupDmListEl.appendChild(item);
  });

  // 2. 1:1 DMs
  const sorted = [...state.dms].sort((a, b) => {
    const timeA = a.lastActivityTime || 0;
    const timeB = b.lastActivityTime || 0;
    if (timeB !== timeA) return timeB - timeA;
    return String(a.name).localeCompare(String(b.name));
  });

  sorted.forEach(conv => {
    const isActive = state.activeRoom.type === 'dm' && state.activeRoom.id === conv.name;
    const item = document.createElement('li');
    item.className = `sidebar-item conv-item dm-item${isActive ? ' active' : ''}`;
    item.dataset.id = conv.id;

    const icon = document.createElement('span');
    icon.className = 'conv-icon';
    icon.textContent = '👤';

    const name = document.createElement('span');
    name.className = 'sidebar-item-name conv-name';
    name.textContent = displayNickname(conv.name);

    item.append(icon, name);

    const partnerId = conv.partnerUserId || userDirectory.get(conv.name)?.id || conv.name;
    if (isConversationMuted('dm', partnerId)) {
      const muteIcon = document.createElement('span');
      muteIcon.className = 'conv-mute-indicator';
      muteIcon.textContent = '🔕';
      muteIcon.title = '음소거됨';
      item.appendChild(muteIcon);
    }

    const unreadCount = state.unreadCounts.dms[partnerId] ?? state.unreadCounts.dms[conv.name] ?? conv.unread ?? 0;
    if (unreadCount > 0 && !isActive) {
      const badge = document.createElement('span');
      badge.className = 'sidebar-badge conv-unread dm-unread';
      badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      item.appendChild(badge);
    }

    const dmRoomId = getDmRoomId(state.currentUser?.username, conv.name);
    if (dmRoomId && screenshareState?.hasSession(dmRoomId)) {
      const liveBadge = document.createElement('span');
      liveBadge.className = 'channel-live-badge';
      liveBadge.textContent = '🔴 LIVE';
      liveBadge.title = '화면 공유 중';
      item.appendChild(liveBadge);
    }

    const activate = () => onSwitchConv('dm', conv.name);
    item.addEventListener('click', activate);
    makeKeyboardClickable(item, activate);
    dmListEl.appendChild(item);
  });
}

export function renderOnlineList(users, onOpenDm) {
  const onlineCountEl = document.getElementById('online-count');
  const userCountEl = document.getElementById('user-count');
  const onlineListEl = document.getElementById('online-list');
  if (!onlineListEl) return;

  const sortedUsers = [...users].sort((first, second) =>
    Number(Boolean(second.online)) - Number(Boolean(first.online))
      || String(first.username || first.nickname).localeCompare(String(second.username || second.nickname))
  );

  if (onlineCountEl) onlineCountEl.textContent = String(sortedUsers.filter(user => user.online).length);
  if (userCountEl) userCountEl.textContent = String(sortedUsers.length);
  onlineListEl.replaceChildren();

  const myNick = state.currentUser ? state.currentUser.username : '';

  sortedUsers.forEach(user => {
    const nick = user.username || user.nickname;
    const displayName = user.display_name || displayNickname(nick);
    const online = Boolean(user.online);
    const item = document.createElement('li');
    item.className = `sidebar-item online-item${online ? '' : ' offline'}`;

    const dot = document.createElement('span');
    dot.className = `online-dot${online ? '' : ' offline'}`;

    const nickElement = document.createElement('span');
    nickElement.className = `sidebar-item-name online-nick${nick === myNick ? ' is-me' : ''}`;
    nickElement.textContent = displayName + (nick === myNick ? ' (나)' : '');

    item.setAttribute('aria-label', `${displayName} ${online ? '온라인' : '오프라인'}`);
    item.title = `${displayName} (@${nick}) — ${online ? '온라인' : '오프라인'}`;
    item.append(dot, nickElement);

    if (user.quiz_badge) {
      const badgeSpan = document.createElement('span');
      badgeSpan.className = `quiz-user-badge badge-${user.quiz_badge.type}`;
      badgeSpan.textContent = `${user.quiz_badge.icon} ${user.quiz_badge.label}`;
      badgeSpan.title = user.quiz_badge.title || '';
      item.appendChild(badgeSpan);
    }

    if (nick !== myNick) {
      const openDm = () => {
        getOrCreateDm(nick, user.id);
        onOpenDm(nick);
      };
      item.title = `${displayName} (@${nick}) — ${online ? '온라인' : '오프라인'} (클릭 시 1:1 대화)`;
      item.addEventListener('click', openDm);
      makeKeyboardClickable(item, openDm);
    }
    onlineListEl.appendChild(item);

  });
}
