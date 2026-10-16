// Run: node --experimental-vm-modules scripts/test_screenshare_layout.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../app/static/js/screenshare_layout.js', import.meta.url), 'utf8');

async function setup() {
  function element() {
    const classes = new Set(), properties = new Map(), attrs = new Map(), events = new Map();
    return { events, attrs, properties,
      classList: { add: key => classes.add(key), remove: key => classes.delete(key),
        contains: key => classes.has(key), toggle(key, enabled) { if (enabled) classes.add(key); else classes.delete(key); } },
      style: { setProperty: (key, value) => properties.set(key, value) },
      setAttribute: (key, value) => attrs.set(key, String(value)),
      addEventListener: (key, value) => events.set(key, value),
      setPointerCapture(id) { this.captured = id; }, releasePointerCapture() { this.captured = null; },
      focus() { this.focused = true; },
    };
  }
  const appBody = element();
  const root = { ...element(), clientHeight: 800, closest: () => appBody, querySelector: selector => ({
    '.chat-area-header': { offsetHeight: 44 }, '.composer': { offsetHeight: 100 },
  })[selector] || null };
  const panel = { ...element(), closest: () => root,
    getBoundingClientRect: () => ({ height: parseInt(panel.properties.get('--ss-pane-height')) || 400 }) };
  const handle = element(), theatreButton = element(), documentEvents = new Map(), windowEvents = new Map();
  const document = { fullscreenElement: null,
    getElementById: id => ({ 'screenshare-panel-container': panel, 'ss-resize-handle': handle, 'ss-btn-theatre': theatreButton })[id],
    addEventListener: (key, value) => documentEvents.set(key, value),
  };
  const context = vm.createContext({ document, window: { addEventListener: (key, value) => windowEvents.set(key, value) } });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => { throw new Error('Unexpected dependency'); });
  await module.evaluate();
  const api = module.namespace;
  api.initScreenShareLayout();
  api.updateScreenShareLayout(true, false);
  const fire = (element, name, values = {}) => element.events.get(name)({ preventDefault() {}, ...values });
  return { api, root, appBody, panel, handle, theatreButton, document, documentEvents, windowEvents, fire,
    height: () => panel.getBoundingClientRect().height };
}

test('drag resizes within bounds, capture ends, and double-click restores split', async () => {
  const h = await setup();
  assert.equal(h.height(), 400);
  h.fire(h.handle, 'pointerdown', { button: 0, pointerId: 1, clientY: 400 });
  h.fire(h.handle, 'pointermove', { pointerId: 1, clientY: 500 });
  assert.equal(h.height(), 500);
  h.fire(h.handle, 'pointermove', { pointerId: 1, clientY: 5000 });
  assert.equal(h.height(), 546); // Leaves header, composer and chat space.
  h.fire(h.handle, 'pointerup');
  assert.equal(h.root.classList.contains('ss-resizing'), false);
  assert.equal(h.handle.captured, null);
  h.fire(h.handle, 'dblclick');
  assert.equal(h.height(), 400);
});

test('keyboard sizing is bounded and resizes proportionately with the app', async () => {
  const h = await setup();
  h.fire(h.handle, 'keydown', { key: 'ArrowDown' });
  assert.equal(h.height(), 424);
  h.fire(h.handle, 'keydown', { key: 'Home' });
  assert.equal(h.height(), 180);
  h.root.clientHeight = 600;
  h.windowEvents.get('resize')();
  assert.equal(h.height(), 180);
  assert.equal(h.handle.attrs.get('aria-valuenow'), '180');
});

test('theatre hides sidebar, Escape restores split, and fullscreen Escape is left to browser', async () => {
  const h = await setup();
  h.fire(h.theatreButton, 'click');
  assert.equal(h.root.classList.contains('ss-theatre'), true);
  assert.equal(h.appBody.classList.contains('ss-theatre-active'), true);
  assert.equal(h.handle.classList.contains('hidden'), true);
  h.document.fullscreenElement = {};
  h.documentEvents.get('keydown')({ key: 'Escape' });
  assert.equal(h.root.classList.contains('ss-theatre'), true);
  h.document.fullscreenElement = null;
  h.documentEvents.get('keydown')({ key: 'Escape' });
  assert.equal(h.root.classList.contains('ss-theatre'), false);
  assert.equal(h.appBody.classList.contains('ss-theatre-active'), false);
  assert.equal(h.theatreButton.focused, true);
  assert.equal(h.height(), 400);
});

test('stop or collapse restores chat and cancels an in-progress drag', async () => {
  const h = await setup();
  h.fire(h.handle, 'pointerdown', { button: 0, pointerId: 2, clientY: 400 });
  h.api.updateScreenShareLayout(true, true);
  assert.equal(h.handle.captured, null);
  assert.equal(h.theatreButton.disabled, true);
  h.api.updateScreenShareLayout(true, false);
  h.fire(h.theatreButton, 'click');
  h.api.updateScreenShareLayout(false, false);
  assert.equal(h.root.classList.contains('ss-theatre'), false);
  assert.equal(h.appBody.classList.contains('ss-theatre-active'), false);
  assert.equal(h.handle.classList.contains('hidden'), true);
});
