// Local viewing controls; never change capture, signaling, or other viewers.
let panel, root, handle, theatreButton;
let visible = false;
let collapsed = false;
let theatre = false;
let ratio = 0.5;
let drag = null;

function bounds() {
  const height = root.clientHeight;
  const header = root.querySelector('.chat-area-header')?.offsetHeight || 0;
  const composer = root.querySelector('.composer')?.offsetHeight || 0;
  // Reserve space for chat and its composer in split view, even on small screens.
  const max = Math.max(80, Math.min(height * 0.8, height - header - composer - 110));
  return { min: Math.min(180, max), max, height };
}

function sync() {
  if (!root) return;
  const list = document?.getElementById?.('message-list');
  const wasNearBottom = list ? (list.scrollHeight - list.clientHeight - list.scrollTop <= 120) : false;
  let anchor = null;
  let anchorOffset = 0;
  if (list && !wasNearBottom && typeof list.querySelectorAll === 'function') {
    const rows = list.querySelectorAll('.msg-row');
    if (rows && rows.length) {
      for (const row of rows) {
        if (row.offsetTop + row.offsetHeight > list.scrollTop) {
          anchor = row;
          anchorOffset = list.scrollTop - row.offsetTop;
          break;
        }
      }
    }
  }

  const { min, max, height } = bounds();
  const pixels = Math.round(Math.max(min, Math.min(max, height * ratio)));
  panel.style.setProperty('--ss-pane-height', `${pixels}px`);
  const active = visible && !collapsed && theatre;
  root.classList.toggle('ss-theatre', active);
  root.closest?.('.app-body')?.classList.toggle('ss-theatre-active', active);
  handle.classList.toggle('hidden', !visible || collapsed || theatre || Boolean(document.fullscreenElement));
  handle.setAttribute('aria-valuemin', Math.round(min));
  handle.setAttribute('aria-valuemax', Math.round(max));
  handle.setAttribute('aria-valuenow', pixels);
  handle.setAttribute('aria-valuetext', `화면 공유 높이 ${pixels}px`);
  theatreButton.setAttribute('aria-pressed', String(theatre));
  theatreButton.disabled = collapsed;
  theatreButton.textContent = theatre ? '기본 보기' : '집중 모드';

  if (list) {
    const restoreScroll = () => {
      if (wasNearBottom) {
        list.scrollTop = list.scrollHeight;
        document?.getElementById?.('new-messages-btn')?.classList.add('hidden');
      } else if (anchor) {
        list.scrollTop = anchor.offsetTop + anchorOffset;
      }
    };
    restoreScroll();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(restoreScroll);
    }
    if (typeof setTimeout === 'function') {
      setTimeout(restoreScroll, 50);
    }
  }
}

function resizeTo(pixels) {
  const { min, max, height } = bounds();
  ratio = Math.max(min, Math.min(max, pixels)) / Math.max(1, height);
  sync();
}

function endDrag() {
  if (!drag) return;
  const id = drag.id;
  drag = null;
  try { handle.releasePointerCapture(id); } catch {}
  root.classList.remove('ss-resizing');
}

export function initScreenShareLayout() {
  // Missing controls are tolerated while older clients are being refreshed.
  const candidate = document.getElementById('screenshare-panel-container');
  const nextHandle = document.getElementById('ss-resize-handle');
  const nextButton = document.getElementById('ss-btn-theatre');
  const nextRoot = candidate?.closest('.chat-area');
  if (!nextHandle || !nextButton || !nextRoot || root) return;
  panel = candidate; root = nextRoot; handle = nextHandle; theatreButton = nextButton;
  theatreButton.addEventListener('click', () => {
    endDrag();
    theatre = !theatre;
    sync();
  });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !visible || collapsed || theatre) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, y: event.clientY, height: panel.getBoundingClientRect().height };
    root.classList.add('ss-resizing');
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) resizeTo(drag.height + event.clientY - drag.y);
  });
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('lostpointercapture', endDrag);
  handle.addEventListener('dblclick', () => { ratio = 0.5; sync(); });
  handle.addEventListener('keydown', event => {
    const { min, max } = bounds();
    const current = panel.getBoundingClientRect().height;
    const pixels = ({ ArrowUp: current - 24, ArrowDown: current + 24, Home: min, End: max })[event.key];
    if (pixels === undefined) return;
    event.preventDefault();
    resizeTo(pixels);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && theatre && !document.fullscreenElement) {
      theatre = false;
      sync();
      theatreButton.focus();
    }
  });
  document.addEventListener('fullscreenchange', sync);
  if (typeof ResizeObserver === 'function') new ResizeObserver(sync).observe(root);
  else window.addEventListener('resize', sync);
  sync();
}

export function updateScreenShareLayout(isVisible, isCollapsed) {
  visible = isVisible;
  collapsed = isCollapsed;
  if (!visible || collapsed) { theatre = false; endDrag(); }
  sync();
}
