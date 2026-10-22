import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionStatus } from './connection-status.js';

function node() {
  const classes = new Set(), listeners = new Map();
  let value = '', writes = 0;
  return { dataset: {}, disabled: false,
    get textContent() { return value; }, set textContent(text) { value = text; writes++; },
    get writes() { return writes; },
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
    addEventListener: (event, callback) => listeners.set(event, callback),
    click: () => listeners.get('click')?.(),
  };
}

test('retries replace one banner without repeated announcements or changing form errors', () => {
  const root = node(), message = node(), retry = node(), announcement = node();
  const formError = node(); formError.textContent = '아이디가 중복됩니다.';
  const banner = new ConnectionStatus({ root, message, retry, announcement });
  assert(root.classList.contains('hidden'));
  banner.set('connecting');
  assert(!root.classList.contains('hidden'));
  banner.set('reconnecting', () => assert.fail('stale retry'));
  const writes = announcement.writes;
  let retried = 0;
  banner.set('reconnecting', () => { retried++; });
  assert.equal(announcement.writes, writes);
  retry.click(); assert.equal(retried, 1);
  assert.equal(formError.textContent, '아이디가 중복됩니다.');
  banner.set('connected');
  assert(root.classList.contains('hidden'));
  assert.equal(announcement.textContent, '실시간 업데이트가 다시 연결되었습니다.');
  assert(retry.disabled);
  assert.equal(formError.textContent, '아이디가 중복됩니다.');
});

test('offline, initial connection, and leaving a cohort have distinct quiet states', () => {
  const root = node(), message = node(), retry = node(), announcement = node();
  const banner = new ConnectionStatus({ root, message, retry, announcement });
  banner.set('connecting'); banner.set('connected');
  assert.equal(announcement.textContent, '');
  banner.set('offline'); assert.match(message.textContent, /오프라인/); assert(retry.disabled);
  banner.set('idle'); assert(root.classList.contains('hidden')); assert.equal(announcement.textContent, '');
});
