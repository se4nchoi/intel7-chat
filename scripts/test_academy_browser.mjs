/* Optional smoke test: build frontend first; requires Playwright + Chromium/Chrome.
 * PLAYWRIGHT_MODULE_PATH may point at a bundled Playwright package.
 * MADI_BROWSER_CHANNEL defaults to chrome (set chromium for Playwright's download).
 * Starts its own loopback process with mocked migrations/API; never opens a DB.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.MADI_TEST_PYTHON || (process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const source = `
import socket, tempfile, os
from app.hub import db
from app.hub.application import create_app
import uvicorn
os.environ['MADI_DATABASE_URL']='postgresql://unused@127.0.0.1/unused'
os.environ['MADI_ALLOWED_HOSTS']='127.0.0.1'
with tempfile.TemporaryDirectory(prefix='madi-browser-') as data:
    os.environ['MADI_FILE_DIR']=data
    for key in ('MADI_SFU_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET'):
        os.environ.pop(key,None)
    db.initialize_schema=lambda: None
    db.close_pools=lambda: None
    app=create_app()
    sock=socket.socket()
    sock.bind(('127.0.0.1',0))
    print('READY:'+str(sock.getsockname()[1]),flush=True)
    uvicorn.Server(uvicorn.Config(app,log_level='error',access_log=False)).run(sockets=[sock])
`;
const server = spawn(python, ['-c', source], { cwd: root });
let errors = '', browser;
server.stderr.on('data', data => { errors += data.toString(); });
try {
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', data => {
      const match = data.toString().match(/READY:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    server.on('error', reject);
    server.on('exit', code => reject(new Error(`Server exited ${code}: ${errors}`)));
    setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 10000).unref();
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/health/live')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, errors);
  const channel = process.env.MADI_BROWSER_CHANNEL || 'chrome';
  browser = await chromium.launch({ headless: true, ...(channel === 'chromium' ? {} : { channel }) });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const pageErrors = [], cspErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.text().includes('Content Security Policy')) cspErrors.push(message.text()); });
  const account = { id: 1, username: 'teacher', display_name: 'Teacher', is_admin: false };
  const cohort = { id: 1, slug: 'class-a', name: 'Class A', role: 'instructor', archived: false };
  let pendingToken, tokenCalls = 0;
  await page.route('**/hub/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/media-token')) {
      tokenCalls++;
      if (tokenCalls === 1) { pendingToken = route; return; }
      return route.fulfill({ status: 503, json: { detail: 'Media service unavailable' } });
    }
    const json = path.endsWith('/me') ? account : path.endsWith('/cohorts') ? [cohort]
      : path.endsWith('/channels') ? [{ id: 1, slug: 'general', name: 'General', kind: 'channel' }] : [];
    return route.fulfill({ json });
  });
  await page.routeWebSocket('**/hub/ws/**', ws => ws.send(JSON.stringify({ type: 'presence', online: [1] })));
  await page.goto(base + '/hub/cohorts/class-a/chat');
  await page.waitForFunction(() => document.querySelector('#channel-heading').textContent.includes('General'));
  await page.click('#stage-toggle');
  await page.click('#media-connect');
  await page.waitForFunction(() => document.querySelector('#media-status').textContent.includes('연결하고'));
  assert.equal(await page.locator('#media-start').isDisabled(), true);
  await page.click('#media-connect');
  await page.waitForFunction(() => document.querySelector('#media-connect').textContent === '연결하기');
  await pendingToken.fulfill({ status: 503, json: { detail: 'cancelled' } });
  await page.click('#media-connect');
  await page.waitForFunction(() => document.querySelector('#media-status').textContent.includes('연결하지 못'));
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(cspErrors, []);
  console.log('Academy browser smoke passed: boot/channel load, LiveKit chunk import, join cancellation, failure retry UI, no JS/CSP errors.');
} finally {
  await browser?.close();
  server.kill();
}
