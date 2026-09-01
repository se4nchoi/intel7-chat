// ============================================================
// State Management Module
// ============================================================

export const state = {
  currentUser: null,
  activeRoom: { type: 'channel', id: 'general' }, // { type: 'channel'|'dm', id: string|number }
  channels: [],
  dms: [],
  onlineUsers: [],
  pinnedMessages: [],
  unreadCounts: { channels: {}, dms: {} },
  mutedConversations: new Set(),
  socket: null,
  isWsConnected: false,
  reconnectAttempts: 0,
  isSnoozed: false,
  snoozeUntil: null,
  soundMode: localStorage.getItem('sound_mode') || 'important',
  soundVolume: parseInt(localStorage.getItem('sound_volume') || '50', 10),
  activeMenuMessageId: null,
  activePickerMessageId: null,
};

export function setCurrentUser(user) {
  state.currentUser = user;
}

export function setActiveRoom(type, id) {
  state.activeRoom = { type, id: String(id) };
}

export function setMutedConversations(convList) {
  state.mutedConversations = new Set(convList.map(c => `${c.conversation_type}:${c.conversation_id}`));
}

export function isConversationMuted(type, id) {
  return state.mutedConversations.has(`${type}:${id}`);
}

export function setConversationMuted(type, id, muted) {
  const key = `${type}:${id}`;
  if (muted) {
    state.mutedConversations.add(key);
  } else {
    state.mutedConversations.delete(key);
  }
}
