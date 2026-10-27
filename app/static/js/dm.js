// ============================================================
// DMs Module: Direct Messaging, Online User Presence & Directory
// ============================================================

import { state, isConversationMuted } from './state.js';
import { makeKeyboardClickable, showToast } from './utils.js';
import { screenshareState, getDmRoomId } from './screenshare.js';

export const userDirectory = new Map();

export const DM_ICONS = {
  tripleDown: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7 3 12 8 17 3"/><polyline points="7 9.5 12 14.5 17 9.5"/><polyline points="7 16 12 21 17 16"/></svg>`,
  eye: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.4 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3.6 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/></svg>`,
  chevronDown: `<svg class="dm-hidden-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`,
};

let showHiddenDms = false;

function getDmPrefsStorageKey() {
  return state.currentUser ? `bamboo_dm_prefs_${state.currentUser.id}` : '';
}

function loadDmPrefs() {
  const key = getDmPrefsStorageKey();
  if (!key) return { hidden: [], bottom: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    return {
      hidden: Array.isArray(raw?.hidden) ? raw.hidden.map(String) : [],
      bottom: Array.isArray(raw?.bottom) ? raw.bottom.map(String) : [],
    };
  } catch {
    return { hidden: [], bottom: [] };
  }
}

function saveDmPrefs(prefs) {
  const key = getDmPrefsStorageKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      hidden: Array.from(new Set(prefs.hidden || [])),
      bottom: Array.from(new Set(prefs.bottom || [])),
    }));
  } catch { /* ignore storage errors */ }
}

export function isDmHidden(nick) {
  if (!nick) return false;
  return loadDmPrefs().hidden.includes(String(nick));
}

export function setDmHidden(nick, hidden) {
  if (!nick) return;
  const target = String(nick);
  const prefs = loadDmPrefs();
  if (hidden) {
    if (!prefs.hidden.includes(target)) prefs.hidden.push(target);
  } else {
    prefs.hidden = prefs.hidden.filter(item => item !== target);
  }
  saveDmPrefs(prefs);
}

export function isDmPinnedBottom(nick) {
  if (!nick) return false;
  return loadDmPrefs().bottom.includes(String(nick));
}

export function toggleDmPinnedBottom(nick) {
  if (!nick) return false;
  const target = String(nick);
  const prefs = loadDmPrefs();
  const nextPinned = !prefs.bottom.includes(target);
  if (nextPinned) {
    prefs.bottom.push(target);
  } else {
    prefs.bottom = prefs.bottom.filter(item => item !== target);
  }
  saveDmPrefs(prefs);
  return nextPinned;
}

export function hideDmConversation(nick, onSwitchConv) {
  if (!nick) return;
  setDmHidden(nick, true);
  if (state.activeRoom.type === 'dm' && String(state.activeRoom.id) === String(nick)) {
    const fallbackChanId = state.channels?.[0]?.channelId || 1;
    if (typeof onSwitchConv === 'function') {
      onSwitchConv('channel', fallbackChanId);
    }
  } else if (typeof onSwitchConv === 'function') {
    renderDms(onSwitchConv);
  }
  showToast('1:1 대화를 목록에서 숨겼습니다. (대화 기록은 유지됩니다)', 'info');
}

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

function getDmUnreadCount(conv) {
  const partnerId = conv.partnerUserId || userDirectory.get(conv.name)?.id || conv.name;
  return state.unreadCounts.dms[partnerId] ?? state.unreadCounts.dms[conv.name] ?? conv.unread ?? 0;
}

function createOneToOneDmItem(conv, prefs, onSwitchConv, { isHiddenEntry = false } = {}) {
  const isActive = state.activeRoom.type === 'dm' && state.activeRoom.id === conv.name;
  const isBottom = prefs.bottom.includes(String(conv.name));
  const item = document.createElement('li');
  item.className = `sidebar-item conv-item dm-item${isActive ? ' active' : ''}${isBottom && !isHiddenEntry ? ' is-sunk' : ''}${isHiddenEntry ? ' is-hidden-dm' : ''}`;
  item.dataset.id = conv.id;

  const icon = document.createElement('span');
  icon.className = 'conv-icon';
  if (isHiddenEntry) {
    icon.classList.add('dm-hidden-icon');
    icon.innerHTML = DM_ICONS.eyeOff;
  } else {
    icon.textContent = '👤';
  }

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

  const unreadCount = getDmUnreadCount(conv);
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

  const actions = document.createElement('span');
  actions.className = 'dm-item-actions';

  if (isHiddenEntry) {
    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'dm-row-action-btn dm-restore-btn';
    restoreBtn.innerHTML = DM_ICONS.eye;
    restoreBtn.title = '숨김 해제 (목록에 표시)';
    restoreBtn.setAttribute('aria-label', `${displayNickname(conv.name)} 숨김 해제`);
    restoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setDmHidden(conv.name, false);
      renderDms(onSwitchConv);
      showToast('1:1 대화 숨김을 해제했습니다.', 'info');
    });
    actions.appendChild(restoreBtn);
  } else {
    const sinkBtn = document.createElement('button');
    sinkBtn.type = 'button';
    sinkBtn.className = `dm-row-action-btn dm-sink-btn${isBottom ? ' is-sunk' : ''}`;
    sinkBtn.innerHTML = DM_ICONS.tripleDown;
    sinkBtn.title = isBottom ? '기본 순서로 복구' : '목록 맨 아래로 내리기';
    sinkBtn.setAttribute('aria-label', sinkBtn.title);
    sinkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowBottom = toggleDmPinnedBottom(conv.name);
      renderDms(onSwitchConv);
      showToast(nowBottom ? '1:1 대화를 목록 맨 아래로 내렸습니다.' : '1:1 대화 순서를 복구했습니다.', 'info');
    });

    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.className = 'dm-row-action-btn dm-hide-btn';
    hideBtn.innerHTML = DM_ICONS.eyeOff;
    hideBtn.title = '1:1 대화 목록에서 숨기기';
    hideBtn.setAttribute('aria-label', `${displayNickname(conv.name)} 대화 숨기기`);
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideDmConversation(conv.name, onSwitchConv);
    });

    actions.append(sinkBtn, hideBtn);
  }

  item.appendChild(actions);

  const activate = () => {
    if (isHiddenEntry) {
      setDmHidden(conv.name, false);
    }
    onSwitchConv('dm', conv.name);
  };
  item.addEventListener('click', activate);
  makeKeyboardClickable(item, activate);
  return item;
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

  // 2. 1:1 DMs (with hide + pin-to-bottom preferences)
  const prefs = loadDmPrefs();
  const hiddenSet = new Set(prefs.hidden);
  const bottomSet = new Set(prefs.bottom);

  const visibleDms = [];
  const hiddenDms = [];
  state.dms.forEach(conv => {
    const isActive = state.activeRoom.type === 'dm' && state.activeRoom.id === conv.name;
    const hasUnread = getDmUnreadCount(conv) > 0;
    if (hiddenSet.has(String(conv.name)) && !hasUnread && !isActive) {
      hiddenDms.push(conv);
    } else {
      visibleDms.push(conv);
    }
  });

  const byActivityDesc = (a, b) => {
    const timeA = a.lastActivityTime || 0;
    const timeB = b.lastActivityTime || 0;
    if (timeB !== timeA) return timeB - timeA;
    return String(a.name).localeCompare(String(b.name));
  };

  visibleDms.sort((a, b) => {
    const bottomA = Number(bottomSet.has(String(a.name)));
    const bottomB = Number(bottomSet.has(String(b.name)));
    if (bottomA !== bottomB) return bottomA - bottomB;
    return byActivityDesc(a, b);
  });

  visibleDms.forEach(conv => {
    dmListEl.appendChild(createOneToOneDmItem(conv, prefs, onSwitchConv));
  });

  if (hiddenDms.length > 0) {
    hiddenDms.sort(byActivityDesc);
    const toggleItem = document.createElement('li');
    toggleItem.className = 'dm-hidden-toggle-row';
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = `dm-hidden-toggle-btn${showHiddenDms ? ' is-open' : ''}`;
    toggleBtn.setAttribute('aria-expanded', String(showHiddenDms));

    const toggleIcon = document.createElement('span');
    toggleIcon.className = 'dm-hidden-toggle-icon';
    toggleIcon.innerHTML = DM_ICONS.eyeOff;

    const toggleLabel = document.createElement('span');
    toggleLabel.className = 'dm-hidden-toggle-label';
    toggleLabel.textContent = `숨긴 대화 ${hiddenDms.length}개`;

    const toggleChevron = document.createElement('span');
    toggleChevron.className = 'dm-hidden-toggle-chevron';
    toggleChevron.innerHTML = DM_ICONS.chevronDown;

    toggleBtn.append(toggleIcon, toggleLabel, toggleChevron);
    toggleBtn.addEventListener('click', () => {
      showHiddenDms = !showHiddenDms;
      renderDms(onSwitchConv);
    });
    toggleItem.appendChild(toggleBtn);
    dmListEl.appendChild(toggleItem);

    if (showHiddenDms) {
      hiddenDms.forEach(conv => {
        dmListEl.appendChild(createOneToOneDmItem(conv, prefs, onSwitchConv, { isHiddenEntry: true }));
      });
    }
  } else {
    showHiddenDms = false;
  }
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
        setDmHidden(nick, false);
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
