// Optional real-browser regression test. Requires Playwright and Chromium.
// PLAYWRIGHT_MODULE may point to an installed Playwright entry point;
// BROWSER_EXECUTABLE may point to a Chrome/Edge binary. No app server is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : 'playwright');
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const css = (await Promise.all(['layout', 'chat', 'screenshare'].map(name => read(`app/static/css/${name}.css`)))).join('\n');
const markup = (await read('app/templates/partials/chat_area.html'))
  .replace("{% include 'partials/composer.html' %}", await read('app/templates/partials/composer.html'));
const layout = await read('app/static/js/screenshare_layout.js');
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent(`<style>:root{--sidebar-w:240px;--safe-bottom:0px}html,body{margin:0;height:100%;font-family:Arial}.app-body{height:100vh}.hidden{display:none!important}${css}</style>
    <div class="app-body"><aside class="sidebar">Channels</aside>${markup}</div>`);
  await page.evaluate(() => {
    document.getElementById('screenshare-panel-container').classList.remove('hidden');
    const list = document.getElementById('message-list');
    for (const type of ['other', 'own', 'dm-recv', 'dm-own']) {
      const row = document.createElement('div'); row.className = `msg-row ${type}`;
      row.innerHTML = `<div class="msg-meta"><b>woogi · 체스의 신</b><span>10/16 14:30</span></div>
        <div class="message-shell"><div class="msg-bubble markdown-body"><div>오늘 항상 인계 포인트인 것 같습니다. Claude Sonnet 5.5 supports readable classroom chat.</div>
        <div class="code-block"><pre><code>const longLine = '${'x'.repeat(200)}';</code></pre></div></div>
        <div class="message-actions">${['답장', '반응', '고정 📌', '수정', '숨김 🙈', '이동 ➡️'].map(text => `<button>${text}</button>`).join('')}</div></div>`;
      list.appendChild(row);
    }
  });
  await page.addScriptTag({ type: 'module', content: `${layout}\ninitScreenShareLayout(); updateScreenShareLayout(true, false);` });
  await page.click('#ss-btn-theatre');
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  const verify = async () => {
    for (const row of await page.locator('.msg-row').all()) {
      const bubble = await row.locator('.msg-bubble').boundingBox();
      const actions = await row.locator('.message-actions').boundingBox();
      assert.ok(bubble.width >= 230, `Bubble collapsed to ${bubble.width}px`);
      assert.ok(actions.y >= bubble.y + bubble.height - 1, 'Actions must sit below the bubble');
    }
    assert.ok(await page.locator('#message-list').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Chat must not overflow sideways');
  };
  await verify();
  await page.locator('#msg-input').fill('Chat remains usable');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  await page.click('#ss-btn-theatre');
  await page.setViewportSize({ width: 900, height: 800 }); await verify();
  await page.setViewportSize({ width: 390, height: 700 }); await verify();
  assert.equal(await page.locator('#msg-input').inputValue(), 'Chat remains usable');
  console.log('PASS: populated theatre chat, own/received/DM bubbles, action controls, code overflow, composer and mobile');
} finally { await browser.close(); }
