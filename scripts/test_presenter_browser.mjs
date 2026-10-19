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
    for key in ('MADI_SFU_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','MADI_CLASSROOMS_FILE'):
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
  // This smoke exercises actual built UI with mocked APIs/SFU; PostgreSQL and
  // real media forwarding are covered independently by integration checks.
  let session = null, revision = 0, approved = null;
  const requests = [], sockets = [], pages = [], pageErrors = [];
  const notify = () => sockets.forEach(ws => ws.send(JSON.stringify({ type: 'media_updated', channel_id: 1 })));
  for (const [id, name, role] of [[1, 'Teacher', 'instructor'], [2, 'Student One', 'student'], [3, 'Student Two', 'student']]) {
    const context = await browser.newContext();
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/hub/assets/livekit-client*.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      export const RoomEvent = Object.fromEntries(['TrackSubscribed','TrackUnsubscribed','Reconnecting','Reconnected','Disconnected','LocalTrackUnpublished'].map(k=>[k,k]));
      export const Track={Kind:{Video:'video'},Source:{ScreenShare:'screen'}};
      export const VideoQuality={HIGH:'high'};
      export class Room {
        constructor(){this.events={};this.localParticipant={setScreenShareEnabled:async enabled=>{
          window.__captures=(window.__captures||[]).concat(enabled);
          if(!enabled)this.events.LocalTrackUnpublished?.({source:'screen'});
        }};}
        on(event, listener){this.events[event]=listener;}
        async connect(url, token){window.__connections=(window.__connections||[]).concat(token);}
        async disconnect(){window.__disconnects=(window.__disconnects||0)+1;this.events.Disconnected?.();}
      }
    ` }));
    await page.route('**/hub/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
      if (path.endsWith('/health')) return route.fulfill({ json: { postgresql: true, sfu_configured: true } });
      const body = req.postData() ? req.postDataJSON() : {};
      if (path.endsWith('/me')) return route.fulfill({ json: { id, username: name, display_name: name } });
      if (path.endsWith('/cohorts')) return route.fulfill({ json: [{ id: 1, slug: 'class-a', name: 'Class A', role, archived: false }] });
      if (path.endsWith('/channels')) return route.fulfill({ json: [{ id: 1, slug: 'general', name: 'General', kind: 'channel' }] });
      if (path.endsWith('/classrooms')) return route.fulfill({ json: [{ id: 'lab-1', name: 'Lab 1' }] });
      if (path.endsWith('/media-session')) {
        if (method === 'POST') {
          session = { id: 'session', revision, cohort_id: 1, channel_id: 1 };
          return route.fulfill({ json: { session, control_token: 'instructor-tab' } });
        }
        return route.fulfill({ json: { distributed: true, session: session && {...session,revision},
          requests: role === 'instructor' ? requests : requests.filter(r=>r.account_id===id) } });
      }
      if (path.endsWith('/heartbeat')) return route.fulfill({ json: { ok: true } });
      if (path.endsWith('/media-token')) {
        const publish = approved ? id===approved.account_id && body.request_token===`request-${id}` : id===1 && body.control_token==='instructor-tab';
        return route.fulfill({ json: { url:'wss://unused', token:`${name}:revision-${revision}`, can_publish:publish, session:{...session,revision} } });
      }
      if (path.endsWith('/requests') && method==='POST') {
        const request={id,account_id:id,display_name:name,status:'pending'}; requests.push(request); notify();
        return route.fulfill({ status:201,json:{request,request_token:`request-${id}`} });
      }
      if (/\/requests\/\d+$/.test(path)) {
        const target=requests.find(r=>r.id===Number(path.split('/').at(-1)));
        if (body.action==='approve') {
          if(approved)approved.status='revoked';
          target.status='approved';approved=target;revision++;
        } else { target.status=body.action==='deny'?'denied':'revoked'; if(approved===target){approved=null;revision++;} }
        notify();return route.fulfill({json:target});
      }
      if(method==='DELETE')return route.fulfill({status:204});
      return route.fulfill({json:[]});
    });
    await page.routeWebSocket('**/hub/ws/**', ws => { sockets.push(ws);ws.send(JSON.stringify({type:'presence',online:[1,2,3]})); });
    await page.goto(base+'/hub/cohorts/class-a/chat');
    await page.waitForFunction(()=>document.querySelector('#channel-heading').textContent.includes('General'));
    await page.click('#stage-toggle');
    if(role==='instructor')await page.selectOption('#media-classroom','lab-1');
    await page.click('#media-connect');
    await page.waitForFunction(()=>document.querySelector('#media-connect').textContent==='연결 끊기');
  }
  const [teacher, first, second]=pages;
  await first.click('#media-request'); await second.click('#media-request');
  await teacher.waitForFunction(()=>document.querySelector('#media-request-count').textContent.includes('2'));
  assert.equal(await first.locator('#media-start').isVisible(),false);
  await teacher.locator('#media-request-list li').filter({hasText:'Student One'}).getByRole('button',{name:'허용',exact:true}).click();
  await first.waitForFunction(()=>!document.querySelector('#media-start').disabled && !document.querySelector('#media-start').classList.contains('hidden'));
  await teacher.waitForFunction(()=>document.querySelector('#media-start').disabled);
  assert.equal(await teacher.locator('#media-start').isDisabled(),true);
  await first.click('#media-start');
  await first.waitForFunction(()=>window.__captures?.includes(true));
  await teacher.locator('#media-request-list li').filter({hasText:'Student Two'}).getByRole('button',{name:'허용',exact:true}).click();
  await second.waitForFunction(()=>!document.querySelector('#media-start').disabled && !document.querySelector('#media-start').classList.contains('hidden'));
  await first.waitForFunction(()=>document.querySelector('#media-start').classList.contains('hidden'));
  assert.ok(await first.evaluate(()=>window.__disconnects>=2));
  await teacher.getByRole('button',{name:'발표 종료 / 강사로 전환',exact:true}).click();
  await teacher.waitForFunction(()=>!document.querySelector('#media-start').disabled);
  await second.waitForFunction(()=>document.querySelector('#media-start').classList.contains('hidden'));
  assert.deepEqual(pageErrors,[]);
  console.log('Presenter browser smoke passed: two requests, instructor queue, approval, student share action, handoff, revocation and instructor return. APIs and SFU are mocked.');
} finally {
  await browser?.close();
  server.kill();
}
