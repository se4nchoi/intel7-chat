import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClassroomSession } from './classroom-session.js';

function harness() {
  const calls = [];
  let current = { id: 'session-1' };
  const controller = new ClassroomSession({ interval: 100000, onLost() {}, api: async (path, options = {}) => {
    calls.push([path, options]);
    if (path.endsWith('/media-token')) return { session: current, url: 'wss://hub/media/lab-1', token: 'signed' };
    if (options.method === 'POST' && path.endsWith('/media-session')) return { session: current, control_token: 'owner-tab-only' };
    if (path.endsWith('/media-session')) return { distributed: true, session: current };
    return { ok: true };
  } });
  return { controller, calls, setCurrent: value => { current = value; } };
}

test('instructor reserves a lab, supplies tab control, renews and releases', async () => {
  const { controller, calls } = harness();
  try {
    await controller.join(1, 2, 'lab-1');
    assert.deepEqual(calls[1][1].json, { classroom_id: 'lab-1' });
    assert.deepEqual(calls[2][1].json, { control_token: 'owner-tab-only' });
    await controller.check();
    assert.ok(calls.some(([path]) => path.endsWith('/session-1/heartbeat')));
  } finally { await controller.leave(); }
  assert.equal(calls.at(-1)[1].method, 'DELETE');
  assert.equal(controller.timer, null);
});

test('student follows current session without reserving or renewing a lab', async () => {
  const { controller, calls, setCurrent } = harness();
  try {
    await controller.join(1, 2, '');
    await controller.check();
    assert.equal(calls.filter(([, options]) => options.method === 'POST').length, 1);
    setCurrent({ id: 'moved-to-lab-3' });
    await assert.rejects(controller.check(), /ended or changed/);
  } finally { await controller.leave(); }
  assert.ok(!calls.some(([, options]) => options.method === 'DELETE'));
});

test('cancelled pending reservation is released instead of leaking a heartbeat', async () => {
  let finish, reserved;
  const started = new Promise(resolve => { reserved = resolve; });
  const released = [];
  const controller = new ClassroomSession({ onLost() {}, api: async (path, options = {}) => {
    if (options.method === 'POST') { reserved(); return new Promise(resolve => { finish = resolve; }); }
    if (options.method === 'DELETE') { released.push(path); return; }
    return { distributed: true };
  } });
  const joining = controller.join(1, 2, 'lab-1');
  await started; await controller.leave();
  finish({ session: { id: 'cancelled' }, control_token: 'control' });
  await assert.rejects(joining, /cancelled/);
  assert.equal(released.length, 1);
  assert.equal(controller.timer, null);
});

test('token failure releases the reserved classroom', async () => {
  const deleted = [];
  const controller = new ClassroomSession({ onLost() {}, api: async (path, options = {}) => {
    if (path.endsWith('media-token')) throw new Error('SFU configuration removed');
    if (options.method === 'POST') return { session: { id: 'one' }, control_token: 'control' };
    if (options.method === 'DELETE') { deleted.push(path); return; }
    return { distributed: true };
  } });
  await assert.rejects(controller.join(1, 2, 'lab-1'));
  assert.equal(deleted.length, 1);
});

test('student request secret stays in the requester tab and is used only for refreshed publish tokens', async () => {
  const calls = [], updates = [], changes = [];
  let revision = 0, requests = [];
  const controller = new ClassroomSession({ interval: 100000, onLost() {},
    onUpdate: data => updates.push(data), onChanged: active => changes.push(active.revision),
    api: async (path, options = {}) => {
      calls.push([path, options]);
      if (path.endsWith('/media-token')) return { session: { id: 'one', revision }, can_publish: revision === 1 };
      if (path.endsWith('/requests') && options.method === 'POST') {
        requests = [{ id: 8, status: 'pending', account_id: 5 }];
        return { request: { id: 8, status: 'pending' }, request_token: 'student-private' };
      }
      if (path.endsWith('/requests') && options.method === 'DELETE') { revision++; requests[0].status = 'cancelled'; return; }
      return { distributed: true, session: { id: 'one', revision }, requests };
    },
  });
  try {
    await controller.join(1, 2, '');
    await controller.requestPresentation();
    assert.equal(updates.at(-1).requests[0].status, 'pending');
    assert.deepEqual(changes, []);  // A request alone does not grant publishing.
    revision = 1; requests[0].status = 'approved';
    await controller.check();
    assert.deepEqual(changes, [1]);
    await controller.token();
    assert.deepEqual(calls.at(-1)[1].json, { control_token: '', request_token: 'student-private' });
    await controller.cancelPresentation();
    assert.deepEqual(changes, [1, 2]);
    assert.equal(controller.active.requestToken, null);
  } finally { await controller.leave(); }
});

test('leaving cancels a student pending request without ending the instructor lease', async () => {
  const deleted = [];
  const controller = new ClassroomSession({ interval: 100000, onLost() {}, api: async (path, options = {}) => {
    if (options.method === 'DELETE') { deleted.push([path, options.json]); return; }
    if (path.endsWith('/requests')) return { request: { id: 1 }, request_token: 'request-secret' };
    if (path.endsWith('/media-token')) return { session: { id: 'one' } };
    return { distributed: true, session: { id: 'one' }, requests: [] };
  } });
  await controller.join(1, 2, '');
  await controller.requestPresentation();
  await controller.leave();
  assert.equal(deleted.length, 1);
  assert.ok(deleted[0][0].endsWith('/one/requests'));
  assert.deepEqual(deleted[0][1], { request_token: 'request-secret' });
});
