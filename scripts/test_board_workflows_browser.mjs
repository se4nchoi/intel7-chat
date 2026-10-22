/* Disposable loopback browser smoke: mocked API and schema, no database. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.MADI_TEST_PYTHON || (process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const server = spawn(python, ['-c', `
import os, socket, tempfile
from app.hub import db
from app.hub.application import create_app
import uvicorn
os.environ['MADI_DATABASE_URL']='postgresql://unused@127.0.0.1/unused'
os.environ['MADI_ALLOWED_HOSTS']='127.0.0.1'
for key in ('MADI_SFU_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','MADI_CLASSROOMS_FILE'):
    os.environ.pop(key,None)
db.initialize_schema=lambda: None
db.close_pools=lambda: None
with tempfile.TemporaryDirectory(prefix='madi-board-') as folder:
    os.environ['MADI_FILE_DIR']=folder
    app=create_app()
    sock=socket.socket(); sock.bind(('127.0.0.1',0))
    print('READY:'+str(sock.getsockname()[1]),flush=True)
    uvicorn.Server(uvicorn.Config(app,log_level='error',access_log=False)).run(sockets=[sock])
`], { cwd: root });
let stderr = '', browser;
server.stderr.on('data', data => { stderr += data.toString(); });
try {
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', data => { const match = data.toString().match(/READY:(\d+)/); if (match) resolve(Number(match[1])); });
    server.on('error', reject);
    server.on('exit', code => reject(new Error(`Server exited ${code}: ${stderr}`)));
    setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 10000).unref();
  });
  const channel = process.env.MADI_BROWSER_CHANNEL || 'chrome';
  browser = await chromium.launch({ headless: true, ...(channel === 'chromium' ? {} : { channel }) });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.setDefaultTimeout(7000);
  const errors = [], sortRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().includes('Content Security Policy')) errors.push(message.text()); });
  const account = { id: 1, username: 'teacher', display_name: 'Teacher', is_admin: false };
  const cohort = { id: 1, slug: 'class-a', name: 'Class A', role: 'instructor', archived: false };
  const questions = [1, 2, 3].map(id => ({ id, title: `Waiting ${id}`, body: `Question body ${id}`, username: 'student', display_name: 'Student', role: 'student', answer_count: 0, instructor_answered: false, resolved: false, created_at: new Date(Date.now() - id * 60000).toISOString(), attachments: [] }));
  await page.route('**/hub/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.endsWith('/me')) return route.fulfill({ json: account });
    if (path.endsWith('/health')) return route.fulfill({ json: { postgresql: true, sfu_configured: false } });
    if (path.endsWith('/notifications/unread')) return route.fulfill({ json: { unread_total: 0 } });
    if (path.endsWith('/cohorts')) return route.fulfill({ json: [cohort] });
    if (path.endsWith('/channels')) return route.fulfill({ json: [{ id: 1, slug: 'general', name: 'General', kind: 'channel' }] });
    if (path.endsWith('/questions/page')) {
      const sort = url.searchParams.get('sort'); sortRequests.push(sort);
      const before = Number(url.searchParams.get('before'));
      const ordered = [...questions].sort((a, b) => sort === 'oldest' ? a.id - b.id : b.id - a.id);
      const remaining = before ? ordered.filter(q => sort === 'oldest' ? q.id > before : q.id < before) : ordered;
      const items = remaining.slice(0, 2);
      return route.fulfill({ json: { items, total: questions.length, has_more: remaining.length > 2, next_before: remaining.length > 2 ? items.at(-1).id : null, stats: { total: 3, pending: 3, unanswered: 3, resolved: 0 } } });
    }
    if (path.endsWith('/follow')) return route.fulfill({ json: { following: false } });
    if (/\/questions\/\d+\/answers$/.test(path)) return route.fulfill({ json: [] });
    const questionId = path.match(/\/questions\/(\d+)$/);
    if (questionId) return route.fulfill({ json: questions.find(q => q.id === Number(questionId[1])) });
    return route.fulfill({ json: [] });
  });
  await page.routeWebSocket('**/hub/ws/**', ws => ws.send(JSON.stringify({ type: 'presence', online: [1] })));
  await page.goto(`http://127.0.0.1:${port}/hub/cohorts/class-a/board?filter=no-instructor`);
  await page.locator('#question-list .feed-item').first().waitFor();
  assert.match(await page.locator('#question-list .feed-item').first().innerText(), /Waiting 1/);
  assert.match(await page.locator('#question-list .feed-item').first().innerText(), /째 대기/);
  await page.locator('#question-list .feed-item').first().locator('button').click();
  await page.locator('#post-next-queue').click();
  await page.waitForFunction(() => document.querySelector('#post-title').textContent === 'Waiting 2');
  await page.locator('#post-next-queue').click();
  await page.waitForFunction(() => document.querySelector('#post-title').textContent === 'Waiting 3');
  await page.locator('#board-back').click();
  await page.locator('[data-queue-sort="newest"]').click();
  await page.waitForFunction(() => document.querySelector('#question-list .feed-item')?.textContent.includes('Waiting 3'));
  assert(sortRequests.includes('oldest') && sortRequests.includes('newest'));
  await page.locator('#new-post-btn').click();
  await page.locator('#question-form [name=title]').fill('PLC question');
  await page.locator('#question-form [name=body]').fill('**Bold** `code`');
  await page.locator('#question-files').setInputFiles({ name: 'ladder.gwx', mimeType: 'application/octet-stream', buffer: Buffer.from('PLC') });
  assert.match(await page.locator('#question-selected-files').innerText(), /ladder.gwx/);
  await page.locator('#question-preview').click();
  assert.equal(await page.locator('#question-preview-body strong').innerText(), 'Bold');
  assert.equal(await page.locator('#question-preview-body code').innerText(), 'code');
  await page.locator('#question-write').click();
  await page.locator('#compose-cancel').click();
  await page.locator('#new-post-btn').click();
  assert.equal(await page.locator('#question-form [name=title]').inputValue(), 'PLC question');
  await page.locator('#question-discard').click();
  assert.equal(await page.locator('#question-form [name=title]').inputValue(), '');
  assert.equal(await page.locator('#question-selected-files li').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Board browser smoke passed: stable queue paging/sorting/next, waiting age, rich preview, file selection, keep/discard draft, no JS/CSP errors.');
} finally {
  await browser?.close(); server.kill();
}
