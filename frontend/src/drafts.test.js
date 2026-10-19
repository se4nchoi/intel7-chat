import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftStore } from './drafts.js';

test('private messages, public channels, answers and accounts never share a draft', () => {
  const store = new DraftStore();
  const privateKey = store.key(1, 2, 'message', 3);
  store.set(privateKey, 'private text');
  for (const key of [store.key(1, 2, 'message', 4), store.key(1, 2, 'answer', 3), store.key(2, 2, 'message', 3), store.key(1, 5, 'message', 3)]) assert.equal(store.get(key), '');
  assert.equal(store.get(privateKey), 'private text');
});

test('a completed request clears its own draft without erasing newer typing', () => {
  const store = new DraftStore();
  store.set('old-target', 'sent text');
  store.set('new-target', 'new target text');
  store.clearIfUnchanged('old-target', 'sent text');
  assert.equal(store.get('old-target'), '');
  assert.equal(store.get('new-target'), 'new target text');
  store.set('old-target', 'new typing');
  store.clearIfUnchanged('old-target', 'sent text');
  assert.equal(store.get('old-target'), 'new typing');
});

test('tab drafts restore through storage and survive storage being unavailable', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  new DraftStore(storage).set('key', 'restored');
  assert.equal(new DraftStore(storage).get('key'), 'restored');
  const unavailable = new DraftStore({ getItem() { throw Error(); }, setItem() { throw Error(); } });
  unavailable.set('key', 'memory draft');
  assert.equal(unavailable.get('key'), 'memory draft');
});
