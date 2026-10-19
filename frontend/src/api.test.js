import test from 'node:test';
import assert from 'node:assert/strict';
import { api, uploadFile } from './api.js';

test('question attachments send multipart data and return the uploaded identity', async t => {
  const payload = new FormData();
  payload.append('upload', new Blob(['example error']), 'error.txt');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/hub/api/cohorts/7/files');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.body, payload);
    assert.equal(options.body.get('upload').name, 'error.txt');
    return Response.json({ id: 'file-id', name: 'error.txt' }, { status: 201 });
  });
  assert.deepEqual(await uploadFile(7, payload), { id: 'file-id', name: 'error.txt' });
});

test('a rejected upload stops question submission with a useful error', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(
    { detail: 'Unsupported file type' }, { status: 400 },
  ));
  await assert.rejects(uploadFile(7, new FormData()), /./);
});

test('expired API and upload sessions request reauthentication, but rejected logins do not', async t => {
  const events = [];
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: event => events.push(event.type) } });
  t.after(() => { if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else delete globalThis.window; });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'Unauthorized' }, { status: 401 }));
  await assert.rejects(api('/cohorts'), error => error.status === 401);
  await assert.rejects(uploadFile(7, new FormData()));
  await assert.rejects(api('/login', { method: 'POST' }), error => error.status === 401);
  assert.deepEqual(events, ['madi:unauthorized', 'madi:unauthorized']);
});
