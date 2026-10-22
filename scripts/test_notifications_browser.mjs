/* Build frontend first. Uses a disposable loopback app and mocked API, never a DB.
 * Configure PLAYWRIGHT_MODULE_PATH and MADI_BROWSER_CHANNEL as for test_academy_browser.mjs.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.MADI_TEST_PYTHON || (process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const server = spawn(python, ['-c', `
import os,socket,tempfile
from app.hub import db
from app.hub.application import create_app
import uvicorn
os.environ['MADI_DATABASE_URL']='postgresql://unused@127.0.0.1/unused'
os.environ['MADI_ALLOWED_HOSTS']='127.0.0.1'
for key in ('MADI_SFU_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','MADI_CLASSROOMS_FILE'):
    os.environ.pop(key,None)
db.initialize_schema=lambda: None
db.close_pools=lambda: None
with tempfile.TemporaryDirectory(prefix='madi-notifications-') as folder:
    os.environ['MADI_FILE_DIR']=folder
    app=create_app()
    sock=socket.socket();sock.bind(('127.0.0.1',0))
    print('READY:'+str(sock.getsockname()[1]),flush=True)
    uvicorn.Server(uvicorn.Config(app,log_level='error',access_log=False)).run(sockets=[sock])
`], { cwd: root });
let browser, stderr = '';
server.stderr.on('data', data => { stderr += data; });
try {
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', data => { const match = String(data).match(/READY:(\d+)/); if (match) resolve(Number(match[1])); });
    server.on('error', reject);
    server.on('exit', code => reject(new Error(`Server exited ${code}: ${stderr}`)));
    setTimeout(() => reject(new Error(`Startup timed out: ${stderr}`)), 10000).unref();
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/health/live')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const channel = process.env.MADI_BROWSER_CHANNEL || 'chrome';
  browser = await chromium.launch({ headless: true, ...(channel === 'chromium' ? {} : { channel }) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().includes('Content Security Policy')) errors.push(message.text()); });
  const account = { id: 1, username: 'student', display_name: 'Student', is_admin: false };
  const cohort = { id: 1, slug: 'test-class', name: 'Test class', role: 'student', archived: false };
  const question = { id: 7, username: 'student', display_name: 'Student', title: 'Notification question', body: 'Example', answer_count: 1, created_at: new Date().toISOString() };
  const message = id => ({ id, channel_id: 1, username: 'teacher', display_name: 'Teacher', body: `@student message ${id}`, created_at: new Date().toISOString(), reactions: [] });
  const notices = [
    { id: 2, kind: 'mention', cohort_id: 1, cohort_slug: 'test-class', cohort_name: 'Test class', channel_id: 1, channel_kind: 'channel', channel_name: 'General', message_id: 1, actor_name: 'Teacher', excerpt: 'Old message mention', read_at: null, created_at: new Date().toISOString() },
    { id: 1, kind: 'answer', cohort_id: 1, cohort_slug: 'test-class', cohort_name: 'Test class', question_id: 7, answer_id: 11, actor_name: 'Teacher', question_title: 'Notification question', excerpt: 'An answer', read_at: null, created_at: new Date().toISOString() },
  ];
  let following = true, unavailable = false, socket, holdFollow = false, followHeld;
  const heldFollow = new Promise(resolve => { followHeld = resolve; });
  const unread = () => notices.filter(n => !n.read_at).length;
  await page.route('**/hub/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, method = req.method();
    if (path.endsWith('/me')) return route.fulfill({ json: account });
    if (path.endsWith('/health')) return route.fulfill({ json: { postgresql: true, sfu_configured: false } });
    if (path.endsWith('/notifications/unread')) return route.fulfill({ json: { unread_total: unread() } });
    if (path.endsWith('/notifications')) {
      if (unavailable) return route.fulfill({ status: 503, json: { detail: 'temporary failure' } });
      const items = notices.filter(n => url.searchParams.get('unread_only') !== 'true' || !n.read_at);
      return route.fulfill({ json: { items, total: items.length, unread_total: unread(), has_more: false } });
    }
    if (path.endsWith('/notifications/read-all')) {
      const cutoff = req.postDataJSON().through_id;
      notices.forEach(n => { if (n.id <= cutoff) n.read_at = new Date().toISOString(); });
      return route.fulfill({ status: 204 });
    }
    const read = path.match(/\/notifications\/(\d+)\/read$/);
    if (read) {
      const item = notices.find(n => n.id === Number(read[1]));
      item.read_at = req.postDataJSON().read ? new Date().toISOString() : null;
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith('/follow')) {
      if (method === 'PUT' && holdFollow) { followHeld(route); return; }
      if (method === 'PUT') following = req.postDataJSON().following;
      return route.fulfill({ json: { following } });
    }
    if (path.endsWith('/questions/page')) return route.fulfill({ json: { items: [question], total: 1, has_more: false } });
    if (path.endsWith('/questions/7/answers')) return route.fulfill({ json: [{ id: 11, username: 'teacher', display_name: 'Teacher', role: 'instructor', body: 'An answer', created_at: new Date().toISOString() }] });
    if (path.endsWith('/questions/7')) return route.fulfill({ json: question });
    if (path.endsWith('/messages')) return route.fulfill({ json: url.searchParams.has('around') ? [message(1)] : Array.from({ length: 100 }, (_, index) => message(index + 2)) });
    if (path.endsWith('/read')) return route.fulfill({ status: 204 });
    if (path.endsWith('/cohorts')) return route.fulfill({ json: [cohort] });
    if (path.endsWith('/channels')) return route.fulfill({ json: [{ id: 1, slug: 'general', name: 'General', kind: 'channel' }] });
    return route.fulfill({ json: [] });
  });
  await page.routeWebSocket('**/hub/ws/**', ws => { socket = ws; ws.send(JSON.stringify({ type: 'presence', online: [1] })); });
  await page.goto(base + '/hub');
  await page.waitForFunction(() => document.querySelector('#notifications-count').textContent === '2');
  await page.locator('#notifications-btn').click();
  await page.locator('.notification-link').filter({ hasText: 'Notification question' }).click();
  await page.locator('#post-view').waitFor({ state: 'visible' });
  await page.locator('#answer-11').waitFor({ state: 'visible' });
  assert.match(page.url(), /\?answer=11#post-7$/);
  assert.equal(await page.locator('#answer-11').evaluate(node => document.activeElement === node), true);
  await page.waitForFunction(() => document.querySelector('#post-follow').getAttribute('aria-pressed') === 'true');
  holdFollow = true;
  await page.locator('#post-follow').click();
  const heldRoute = await heldFollow;
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/questions/7'));
  socket.send(JSON.stringify({ type: 'board_changed', question_id: 7 }));
  await refreshed;
  following = heldRoute.request().postDataJSON().following; holdFollow = false;
  await heldRoute.fulfill({ json: { following } });
  await page.waitForFunction(() => document.querySelector('#post-follow').getAttribute('aria-pressed') === 'false');
  assert.equal(following, false);
  await page.locator('#answer-form textarea').fill('Keep this answer draft');
  await page.locator('#notifications-btn').click();
  await page.locator('.notification-link').filter({ hasText: 'Old message mention' }).click();
  await page.locator('[data-message-id="1"]').waitFor();
  assert(page.url().endsWith('?channel=1#message-1'));
  await page.reload();
  await page.locator('[data-message-id="1"]').waitFor();
  await page.locator('#history-latest').click();
  await page.waitForFunction(() => !location.hash && document.querySelectorAll('#messages .msg').length === 100);
  assert.equal(await page.locator('[data-message-id="1"]').count(), 0);
  await page.goto(base + '/hub/cohorts/test-class/board#post-7');
  await page.waitForFunction(() => document.querySelector('#answer-form textarea').value === 'Keep this answer draft');

  unavailable = true;
  await page.locator('#notifications-btn').click();
  await page.locator('#notifications-state.error button').waitFor();
  unavailable = false;
  await page.locator('#notifications-state button').click();
  await page.waitForFunction(() => document.querySelectorAll('#notifications-list .notification').length === 2);
  await page.locator('#notifications-close').click();
  notices.unshift({ ...notices[0], id: 3, read_at: null });
  socket.send(JSON.stringify({ type: 'notifications_changed' }));
  await page.waitForFunction(() => document.querySelector('#notifications-count').textContent === '1');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#board-space .menu-btn').click();
  await page.locator('#notifications-btn').click();
  await page.locator('#notifications-unread').check();
  await page.waitForFunction(() => document.querySelectorAll('#notifications-list .notification').length === 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#notifications-read-all').click();
  await page.waitForFunction(() => document.querySelectorAll('#notifications-list .notification').length === 0);
  assert.equal(unread(), 0);
  await page.locator('#notifications-close').click();
  assert.deepEqual(errors, []);
  console.log('Notifications browser smoke passed: follow, question and old message links, reload, draft preservation, retry, live badge, mobile filter/read-all.');
} finally {
  await browser?.close(); server.kill();
}
