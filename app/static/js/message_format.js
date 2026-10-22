// Display preferences stay in this browser, scoped to the signed-in account.
const MODES = new Set(['auto', 'code', 'commands', 'text']);
const LIMIT = 300;
const fallbackFormats = new Map();

function messageKey(message) {
  if (message.message_id != null) return String(message.message_id);
  if (message.id == null) return '';
  return `${message.msgType === 'dm' ? 'dm' : 'public'}:${message.id}`;
}

function storageKey(userId) {
  return `bamboochat_message_formats_v1_${userId ?? 'guest'}`;
}

function loadFormats(userId) {
  if (fallbackFormats.has(storageKey(userId))) return fallbackFormats.get(storageKey(userId));
  try {
    const values = JSON.parse(localStorage.getItem(storageKey(userId)) || '[]');
    if (!Array.isArray(values)) return new Map();
    return new Map(values.filter(entry => Array.isArray(entry) && entry.length === 2
      && typeof entry[0] === 'string' && MODES.has(entry[1])).slice(-LIMIT));
  } catch { return new Map(); }
}

export function getMessageFormat(message, userId) {
  return loadFormats(userId).get(messageKey(message)) || 'auto';
}

export function setMessageFormat(message, userId, mode) {
  const key = messageKey(message);
  if (!key || !MODES.has(mode)) return false;
  const formats = loadFormats(userId);
  formats.delete(key);
  if (mode !== 'auto') formats.set(key, mode);
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify([...formats].slice(-LIMIT)));
    fallbackFormats.delete(storageKey(userId));
    return true;
  } catch {
    fallbackFormats.set(storageKey(userId), new Map([...formats].slice(-LIMIT)));
    return false;
  }
}
