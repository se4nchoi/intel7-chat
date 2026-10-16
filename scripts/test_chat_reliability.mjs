// Run: node --experimental-vm-modules scripts/test_chat_reliability.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const wsSource = await readFile(new URL('../app/static/js/ws.js', import.meta.url), 'utf8');
const scrollSource = await readFile(new URL('../app/static/js/message_scroll.js', import.meta.url), 'utf8');

async function setup() {
  const listeners = new Map(), classes = new Set(['hidden']);
  const button = { textContent: '', classList: {
    add: name => classes.add(name), remove: name => classes.delete(name),
    contains: name => classes.has(name),
  }, addEventListener: (name, fn) => listeners.set(`button:${name}`, fn) };
  const list = { scrollHeight: 1000, clientHeight: 300, scrollTop: 100,
    addEventListener: (name, fn) => listeners.set(`list:${name}`, fn) };
  const state = { activeRoom: { type: 'channel', id: 1 }, currentUser: { id: 1, username: 'me' },
    unreadCounts: { channels: {}, dms: {} }, dms: [], channels: [], reconnectAttempts: 0 };
  const sockets = [], timers = new Map(), rows = [], toasts = [];
  let nextTimer = 0;
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 1; sockets.push(this); }
    close() { this.readyState = 3; }
    send(value) { this.sent = value; }
  }
  const context = vm.createContext({ console, WebSocket: Socket,
    location: { protocol: 'https:', host: 'testserver' },
    document: { getElementById: id => ({ 'message-list': list, 'new-messages-btn': button })[id] || null,
      querySelector: query => rows.find(row => query.includes(`"${row.message_id}"`)) || null },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const scroll = new vm.SourceTextModule(scrollSource, { context });
  await scroll.link(() => { throw new Error('Unexpected scroll dependency'); });
  await scroll.evaluate();
  const overrides = {
    state, setMutedConversations() {}, showToast: text => toasts.push(text),
    userDirectory: new Map(), channelsDirectory: new Map(),
    displayNickname: name => name, getOrCreateChannel: () => ({ displayName: 'Channel' }),
    getOrCreateDm: () => ({}), isChatActiveAndFocused: () => true,
    appendMessageNode: row => { rows.push(row); list.scrollHeight += 100; },
  };
  const imports = new Map([...wsSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)]
    .map(match => [match[2], match[1].split(',').map(name => name.trim()).filter(Boolean)]));
  const module = new vm.SourceTextModule(wsSource, { context });
  await module.link(specifier => {
    if (specifier === './message_scroll.js') return scroll;
    const names = imports.get(specifier);
    return new vm.SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, overrides[name] ?? (() => {}));
    }, { context });
  });
  await module.evaluate();
  return { api: module.namespace, scroll: scroll.namespace, state, sockets, timers, rows,
    list, button, listeners, toasts };
}

function message(socket, overrides = {}) {
  socket.onmessage({ data: JSON.stringify({ type: 'chat', channel_id: 1, author_id: 2,
    nickname: 'other', message_id: 'public:1', content: 'hello', ...overrides }) });
}

test('channel and DM traffic preserve reading position and expose jump to latest', async () => {
  for (const type of ['chat', 'dm']) {
    const h = await setup();
    if (type === 'dm') h.state.activeRoom = { type: 'dm', id: 'other' };
    h.api.initWebSocket();
    message(h.state.socket, { type, from_nick: 'other', from_user_id: 2, to_nick: 'me', to_user_id: 1 });
    assert.equal(h.rows.length, 1);
    assert.equal(h.list.scrollTop, 100);
    assert.equal(h.button.classList.contains('hidden'), false);
    h.listeners.get('button:click')();
    assert.equal(h.list.scrollTop, h.list.scrollHeight);
    assert.equal(h.button.classList.contains('hidden'), true);
  }
});

test('near-bottom traffic and own messages follow latest; own replay does not force scroll', async () => {
  const h = await setup();
  h.api.initWebSocket();
  h.list.scrollTop = 650;
  message(h.state.socket);
  assert.equal(h.list.scrollTop, 1100);
  h.list.scrollTop = 100;
  message(h.state.socket, { message_id: 'public:2', author_id: 1, nickname: 'me', history: true });
  assert.equal(h.list.scrollTop, 100);
  assert.equal(h.button.classList.contains('hidden'), true);
  message(h.state.socket, { message_id: 'public:3', author_id: 1, nickname: 'me' });
  assert.equal(h.list.scrollTop, h.list.scrollHeight);
});

test('scrolling to bottom or changing rooms clears the new-message indicator', async () => {
  const h = await setup();
  h.api.initWebSocket();
  message(h.state.socket);
  h.list.scrollTop = h.list.scrollHeight - h.list.clientHeight;
  h.listeners.get('list:scroll')();
  assert.equal(h.button.classList.contains('hidden'), true);
  h.list.scrollTop = 100;
  message(h.state.socket, { message_id: 'public:2' });
  h.scroll.scrollToLatest(); // renderMessages uses this when switching rooms.
  assert.equal(h.button.classList.contains('hidden'), true);
});

test('replaced sockets cannot process messages or schedule stale reconnects', async () => {
  const h = await setup();
  h.api.initWebSocket();
  const old = h.state.socket, oldClose = old.onclose;
  h.api.initWebSocket();
  message(old);
  oldClose({ code: 1006 });
  assert.equal(h.rows.length, 0);
  assert.equal(h.timers.size, 0);
  message(h.state.socket);
  message(h.state.socket); // Duplicate replay is ignored.
  assert.equal(h.rows.length, 1);
});

test('manual reconnect cancels old timer; auth close does not reconnect', async () => {
  const h = await setup();
  let expired = 0;
  h.api.initWebSocket({ onSessionExpired: () => expired++ });
  h.state.socket.onclose({ code: 1013 });
  assert.equal(h.timers.size, 1);
  h.api.initWebSocket({ onSessionExpired: () => expired++ });
  assert.equal(h.timers.size, 0);
  h.state.socket.onclose({ code: 1008 });
  assert.equal(expired, 1);
  assert.equal(h.timers.size, 0);
});

test('send exception reports failure to preserve composer and schedules reconnect', async () => {
  const h = await setup();
  h.api.initWebSocket();
  h.state.socket.send = () => { throw new Error('socket closed during send'); };
  assert.equal(h.api.sendWebSocketMessage({ type: 'chat' }), false);
  assert.equal(h.timers.size, 1);
  assert.equal(h.state.isWsConnected, false);
});

test('unread counts stay visible while reader is away from latest messages', async () => {
  const h = await setup();
  assert.equal(h.api.applyServerUnreadCounts({ 'channel:1': 3 }), 3);
  assert.equal(h.state.unreadCounts.channels[1], 3);
  h.scroll.scrollToLatest();
  assert.equal(h.api.applyServerUnreadCounts({ 'channel:1': 3 }), 0);
});
