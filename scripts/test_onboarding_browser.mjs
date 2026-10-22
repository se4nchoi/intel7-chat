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
with tempfile.TemporaryDirectory(prefix='madi-onboarding-') as folder:
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
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().includes('Content Security Policy')) errors.push(message.text()); });
  let account = { id: 1, username: 'admin', display_name: 'Admin', is_admin: true, must_change_password: false };
  const cohort = { id: 1, slug: 'test-class', name: 'Test class', role: 'admin', archived: false };
  let imported = 0, passwordChanges = 0;
  await page.route('**/hub/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path.endsWith('/me')) return route.fulfill({ json: account });
    if (path.endsWith('/me/password')) {
      const body = route.request().postDataJSON();
      assert.equal(body.current_password, 'temporary-pass');
      assert.equal(body.new_password, 'personal-pass');
      passwordChanges++; account = { ...account, must_change_password: false };
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith('/accounts/import/preview')) {
      const { rows, cohort_id } = route.request().postDataJSON();
      assert.equal(cohort_id, 1);
      return route.fulfill({ json: { cohort, valid: true, revision: 'reviewed-version', total_rows: rows.length, invalid_rows: 0, counts: { create: 1, enroll: 0, unchanged: 0 }, rows: rows.map((r, i) => ({ ...r, row: i + 1, action: 'create', errors: [] })) } });
    }
    if (path.endsWith('/accounts/import')) {
      assert.equal(route.request().postDataJSON().revision, 'reviewed-version'); imported++;
      return route.fulfill({ status: 201, json: { cohort, counts: { create: 1, enroll: 0, unchanged: 0 }, credentials: [{ username: 'new_student', display_name: 'New learner', temporary_password: 'temporary-pass' }] } });
    }
    if (path.endsWith('/health')) return route.fulfill({ json: { postgresql: true, sfu_configured: false } });
    if (path.endsWith('/cohorts')) {
      assert.equal(account.must_change_password, false, 'No class request before onboarding');
      return route.fulfill({ json: [{ ...cohort, role: account.is_admin ? 'admin' : 'student' }] });
    }
    if (path.endsWith('/channels')) return route.fulfill({ json: [{ id: 1, slug: 'general', name: 'General', kind: 'channel' }] });
    return route.fulfill({ json: [] });
  });
  await page.routeWebSocket('**/hub/ws/**', ws => ws.send(JSON.stringify({ type: 'presence', online: [account.id] })));
  await page.goto(base + '/hub');
  await page.locator('#academy-manage-btn').click();
  const source = 'username,display_name,role\nnew_student,New learner,student';
  await page.locator('#roster-source').fill(source);
  await page.locator('#roster-preview-btn').click();
  await page.locator('#roster-apply').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#roster-source').inputValue(), source);
  await page.locator('#roster-source').fill(source + '\n');
  assert.equal(await page.locator('#roster-apply').isHidden(), true, 'Editing invalidates the preview');
  await page.locator('#roster-preview-btn').click();
  await page.locator('#roster-apply').click();
  await page.locator('#roster-result').waitFor({ state: 'visible' });
  assert.equal(imported, 1);
  assert.match(await page.locator('#roster-credentials').inputValue(), /temporary-pass/);
  const download = page.waitForEvent('download');
  await page.locator('#roster-download').click();
  assert.equal((await download).suggestedFilename(), 'madi-new-accounts.csv');
  await page.locator('#management-close').click();
  await page.waitForFunction(() => document.querySelector('#roster-credentials').value === '');
  assert.equal(await page.locator('#roster-credentials').inputValue(), '');

  account = { id: 2, username: 'new_student', display_name: 'New learner', is_admin: false, must_change_password: true };
  requests.length = 0;
  await page.reload();
  await page.locator('#first-login-card').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#hub-app').isHidden(), true);
  assert.equal(requests.includes('/hub/api/cohorts'), false);
  await page.reload();
  await page.locator('#first-login-card').waitFor({ state: 'visible' });
  await page.locator('#first-login-form [name=current_password]').fill('temporary-pass');
  await page.locator('#first-login-form [name=new_password]').fill('personal-pass');
  await page.locator('#first-login-form [name=confirm_password]').fill('mismatch');
  await page.locator('#first-login-form button').click();
  await page.locator('#first-login-status.error').waitFor();
  assert.equal(passwordChanges, 0);
  await page.locator('#first-login-form [name=confirm_password]').fill('personal-pass');
  await page.locator('#first-login-form button').click();
  await page.waitForFunction(() => document.querySelector('#channel-heading').textContent.includes('General'));
  assert.equal(passwordChanges, 1);
  assert.equal(await page.locator('#first-login-form [name=current_password]').inputValue(), '');
  assert.deepEqual(errors, []);
  console.log('Onboarding browser smoke passed: preview invalidation, import, credential download/cleanup, mandatory password change and class entry.');
} finally {
  await browser?.close(); server.kill();
}
