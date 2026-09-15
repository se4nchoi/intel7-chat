// ============================================================
// BambooChat - Korean Chess (Janggi - 장기) Module
// Native ES Module Architecture
// ============================================================

import { state } from './state.js';
import { showToast } from './utils.js';

let jgWs = null;
let currentRoom = null;
let myColor = null; // 'cho', 'han', or null
let selectedPoint = null; // { col, row }
let clockInterval = null;

const $ = id => document.getElementById(id);

// Traditional Hanja display names
const HANJA_MAP = {
  'K': '楚', 'R': '車', 'C': '包', 'N': '馬', 'B': '象', 'A': '士', 'P': '卒',
  'k': '漢', 'r': '車', 'c': '包', 'n': '馬', 'b': '象', 'a': '士', 'p': '兵',
};

// Wooden piece placement sound via Web Audio API
function playWoodClickSound() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.08);

    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.08);
  } catch (e) {
    // Autoplay or audio unavailable
  }
}

export function initJanggiListeners() {
  // Expose hook for tab activation
  window.bambooJanggiHook = {
    onTabActive: () => {
      ensureJanggiConnected();
      fetchJanggiRooms();
    }
  };

  // Lobby tabs
  const tabRooms = $('jgTabRooms');
  const tabRank = $('jgTabRank');
  const btnRefreshLobby = $('jgBtnRefreshLobby');
  const btnRefreshRank = $('jgBtnRefreshRank');
  const btnOpenCreate = $('jgBtnOpenCreate');
  const btnCancelCreate = $('jgBtnCancelCreate');
  const btnSubmitCreate = $('jgBtnSubmitCreate');

  if (tabRooms) tabRooms.addEventListener('click', () => switchJgLobbyTab('rooms'));
  if (tabRank) tabRank.addEventListener('click', () => switchJgLobbyTab('rank'));
  if (btnRefreshLobby) btnRefreshLobby.addEventListener('click', fetchJanggiRooms);
  if (btnRefreshRank) btnRefreshRank.addEventListener('click', fetchJanggiRankings);

  if (btnOpenCreate) {
    btnOpenCreate.addEventListener('click', () => {
      $('jgCreatePanel').classList.toggle('hidden');
      $('jgCreateTitle').focus();
    });
  }
  if (btnCancelCreate) {
    btnCancelCreate.addEventListener('click', () => $('jgCreatePanel').classList.add('hidden'));
  }
  if (btnSubmitCreate) {
    btnSubmitCreate.addEventListener('click', submitCreateJgRoom);
  }

  // Game screen actions
  const btnPass = $('jgBtnPass');
  const btnScoreJudge = $('jgBtnScoreJudge');
  const btnResign = $('jgBtnResign');
  const btnLeave = $('jgBtnLeave');
  const btnSitCho = $('jgBtnSitCho');
  const btnSitHan = $('jgBtnSitHan');
  const btnStartGame = $('jgBtnStartGame');
  const btnChangeFormation = $('jgBtnChangeFormation');
  const btnCloseFormation = $('jgBtnCloseFormation');

  if (btnPass) btnPass.addEventListener('click', handlePassTurn);
  if (btnScoreJudge) btnScoreJudge.addEventListener('click', handleScoreJudge);
  if (btnResign) btnResign.addEventListener('click', handleResign);
  if (btnLeave) btnLeave.addEventListener('click', handleLeaveRoom);
  if (btnSitCho) btnSitCho.addEventListener('click', () => sendJgAction('pick_role', { role: 'cho' }));
  if (btnSitHan) btnSitHan.addEventListener('click', () => sendJgAction('pick_role', { role: 'han' }));
  if (btnStartGame) btnStartGame.addEventListener('click', () => sendJgAction('start_game'));

  if (btnChangeFormation) {
    btnChangeFormation.addEventListener('click', () => {
      $('jgFormationModal').classList.toggle('hidden');
    });
  }
  if (btnCloseFormation) {
    btnCloseFormation.addEventListener('click', () => {
      $('jgFormationModal').classList.add('hidden');
    });
  }

  // Formation selection cards
  document.querySelectorAll('.jg-formation-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.jg-formation-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const f = card.getAttribute('data-formation');
      sendJgAction('set_formation', { formation: f });
    });
  });

  // Room chat
  const chatForm = $('jgChatForm');
  if (chatForm) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('jgChatInput');
      const text = (input?.value || '').trim();
      if (!text || !currentRoom) return;
      sendJgAction('chat', { text });
      input.value = '';
    });
  }
}

function ensureJanggiConnected() {
  if (jgWs && (jgWs.readyState === WebSocket.OPEN || jgWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  jgWs = new WebSocket(`${protocol}//${window.location.host}/ws/janggi`);

  jgWs.onopen = () => {
    fetchJanggiRooms();
  };

  jgWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleJgMessage(msg);
    } catch (e) {
      console.error('Invalid janggi message', e);
    }
  };

  jgWs.onclose = () => {
    setTimeout(ensureJanggiConnected, 3000);
  };
}

function sendJgAction(action, data = {}) {
  if (!jgWs || jgWs.readyState !== WebSocket.OPEN) return;
  const payload = { action, room_id: currentRoom?.id, ...data };
  jgWs.send(JSON.stringify(payload));
}

function fetchJanggiRooms() {
  sendJgAction('list_rooms');
}

function handleJgMessage(msg) {
  if (msg.type === 'lobby_update') {
    renderJgRoomList(msg.rooms || []);
  } else if (msg.type === 'room_state') {
    updateJgRoomState(msg.room);
  } else if (msg.type === 'chat') {
    appendJgChat(msg.sender, msg.text, msg.time);
  } else if (msg.type === 'error') {
    showToast(msg.message, 'error');
  }
}

function switchJgLobbyTab(tab) {
  const isRooms = tab === 'rooms';
  $('jgTabRooms').classList.toggle('active', isRooms);
  $('jgTabRank').classList.toggle('active', !isRooms);
  $('jgLobbyActionsRooms').classList.toggle('hidden', !isRooms);
  $('jgLobbyActionsRank').classList.toggle('hidden', isRooms);
  $('jgRoomGrid').classList.toggle('hidden', !isRooms);
  $('jgLobbyEmpty').classList.toggle('hidden', true);
  $('jgRankingsPanel').classList.toggle('hidden', isRooms);

  if (!isRooms) {
    fetchJanggiRankings();
  }
}

async function fetchJanggiRankings() {
  try {
    const res = await fetch('/api/janggi/rankings');
    const data = await res.json();
    renderJgRankings(data.rankings || []);
  } catch (e) {
    console.error('Failed to fetch janggi rankings', e);
  }
}

function renderJgRankings(rankings) {
  const tbody = $('jgRankingsTbody');
  if (!tbody) return;
  if (!rankings.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--jg-muted);">아직 기록된 전적이 없습니다.</td></tr>';
    return;
  }
  const getJgBadge = (rank) => {
    if (rank === 1) return '<span class="quiz-user-badge badge-janggi" style="margin-left:6px;">🀄 장기의 신</span>';
    if (rank === 2) return '<span class="quiz-user-badge badge-janggi" style="margin-left:6px;">🀄 장기의 왕</span>';
    if (rank === 3) return '<span class="quiz-user-badge badge-janggi" style="margin-left:6px;">🀄 장기고인물</span>';
    return '';
  };

  tbody.innerHTML = rankings.map(r => `
    <tr>
      <td style="text-align:center;font-weight:700;">${r.rank === 1 ? '🥇 1' : r.rank === 2 ? '🥈 2' : r.rank === 3 ? '🥉 3' : r.rank}</td>
      <td style="font-weight:600;">${r.display_name || r.username}${getJgBadge(r.rank)}</td>
      <td style="text-align:center;color:#a7f3d0;font-weight:700;">${r.wins}승</td>
      <td style="text-align:center;">${r.win_rate}%</td>
      <td style="text-align:center;color:var(--jg-muted);">${r.wins}승 ${r.draws}무 ${r.losses}패</td>
      <td style="text-align:center;font-size:12px;color:var(--jg-muted);">${r.last_win_at ? r.last_win_at.slice(0, 16) : '-'}</td>
    </tr>
  `).join('');
}

function submitCreateJgRoom() {
  const title = ($('jgCreateTitle')?.value || '').trim();
  const timeMins = parseInt($('jgCreateTime')?.value || '10', 10);
  sendJgAction('create_room', { title, time_minutes: timeMins });
  $('jgCreatePanel').classList.add('hidden');
}

function renderJgRoomList(rooms) {
  const grid = $('jgRoomGrid');
  const empty = $('jgLobbyEmpty');
  if (!grid) return;

  if (!rooms.length) {
    grid.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  grid.innerHTML = rooms.map(r => `
    <div class="jg-room-card" data-room-id="${r.id}">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-weight:700;font-size:15px;color:#a7f3d0;">${r.title}</span>
        <span style="font-size:11px;background:rgba(52,211,153,0.15);color:#6ee7b7;padding:2px 8px;border-radius:6px;">⏱️ ${r.time_minutes}분</span>
      </div>
      <div style="font-size:12.5px;color:var(--jg-muted);display:flex;justify-content:space-between;">
        <span>楚: ${r.cho || '대기 중'}</span>
        <span>漢: ${r.han || '대기 중'}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--jg-muted);">
        <span>관전 ${r.spectator_count}명</span>
        <span style="color:${r.game_started ? '#34d399' : '#f59e0b'};font-weight:600;">${r.game_started ? '⚔️ 대국 중' : '대기 중'}</span>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.jg-room-card').forEach(card => {
    card.addEventListener('click', () => {
      const rId = card.getAttribute('data-room-id');
      sendJgAction('join_room', { room_id: rId });
    });
  });
}

function updateJgRoomState(room) {
  currentRoom = room;
  const lobby = $('jgLobbyScreen');
  const game = $('jgGameScreen');

  if (!room) {
    if (lobby) lobby.classList.remove('hidden');
    if (game) game.classList.add('hidden');
    return;
  }

  if (lobby) lobby.classList.add('hidden');
  if (game) game.classList.remove('hidden');

  // Title & ID
  $('jgRoomTitle').textContent = room.title;
  $('jgRoomIdBadge').textContent = `#${room.id.slice(7)}`;

  // Determine user's role
  const myId = String(state.currentUser?.id);
  myColor = null;
  if (room.cho && String(room.cho.id) === myId) myColor = 'cho';
  if (room.han && String(room.han.id) === myId) myColor = 'han';

  // Player cards
  $('jgChoName').textContent = room.cho ? room.cho.name : '초 플레이어 대기 중';
  $('jgHanName').textContent = room.han ? room.han.name : '한 플레이어 대기 중';
  $('jgChoFormationBadge').textContent = `[${getFormationName(room.cho_formation)}]`;
  $('jgHanFormationBadge').textContent = `[${getFormationName(room.han_formation)}]`;

  // Start & Role buttons
  const isBothSeated = room.cho && room.han;
  const isPlayer = myColor !== null;
  $('jgBtnStartGame').classList.toggle('hidden', !(isBothSeated && isPlayer && !room.game_started));
  $('jgBtnSitCho').classList.toggle('hidden', !!room.cho || room.game_started);
  $('jgBtnSitHan').classList.toggle('hidden', !!room.han || room.game_started);
  $('jgBtnChangeFormation').classList.toggle('hidden', room.game_started || !isPlayer);

  // Status banner
  if (room.result) {
    $('jgStatusText').textContent = `대국 종료: ${room.result.desc || ''}`;
    $('jgTurnBadge').classList.add('hidden');
  } else if (room.game_started) {
    $('jgTurnBadge').classList.remove('hidden');
    $('jgTurnText').textContent = `${room.active_turn === 'cho' ? '초(楚)' : '한(漢)'} 차례`;
    $('jgStatusText').textContent = `${room.move_history?.length || 1}수 진행 중`;
  } else {
    $('jgTurnBadge').classList.add('hidden');
    $('jgStatusText').textContent = isBothSeated ? '대국 준비 완료! "대국 시작"을 눌러주세요.' : '상대 플레이어를 기다리는 중입니다.';
  }

  // Score banner
  if (room.board?.score) {
    const s = room.board.score;
    $('jgScoreBanner').textContent = `초 ${s.cho}점 vs 한 ${s.han}점 (덤 1.5)`;
  }

  // Render board
  renderJgBoard(room);

  // Render move notation
  renderJgMoveHistory(room.move_history || []);

  // Update clocks
  startJgClock(room);
}

function getFormationName(f) {
  const map = { wonangma: '원앙마', yangwima: '양귀마', oenma: '왼마', oreunma: '오른마' };
  return map[f] || '원앙마';
}

function renderJgBoard(room) {
  const svg = $('jgBoardSvg');
  const layer = $('jgIntersectionsLayer');
  if (!svg || !layer) return;

  const width = 504;
  const height = 560;
  const padX = 24;
  const padY = 25;
  const stepX = (width - padX * 2) / 8;  // 57px
  const stepY = (height - padY * 2) / 9; // 56.67px

  const getPt = (c, r) => ({
    x: padX + c * stepX,
    // Cho ranks 0..3 are bottom, Han ranks 6..9 are top
    y: height - (padY + r * stepY)
  });

  // Render SVG Grid Lines
  let lines = '';
  // Horizontal lines (10 ranks)
  for (let r = 0; r < 10; r++) {
    const p1 = getPt(0, r);
    const p2 = getPt(8, r);
    lines += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#34d399" stroke-opacity="0.5" stroke-width="1.5" />`;
  }

  // Vertical lines (9 files) - Janggi lines don't break across the river (unlike Xiangqi)
  for (let c = 0; c < 9; c++) {
    const p1 = getPt(c, 0);
    const p2 = getPt(c, 9);
    lines += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#34d399" stroke-opacity="0.5" stroke-width="1.5" />`;
  }

  // Palace diagonals:
  // Cho palace (ranks 0..2, cols 3..5)
  const c30 = getPt(3, 0), c52 = getPt(5, 2);
  const c50 = getPt(5, 0), c32 = getPt(3, 2);
  lines += `<line x1="${c30.x}" y1="${c30.y}" x2="${c52.x}" y2="${c52.y}" stroke="#34d399" stroke-opacity="0.75" stroke-width="1.5" />`;
  lines += `<line x1="${c50.x}" y1="${c50.y}" x2="${c32.x}" y2="${c32.y}" stroke="#34d399" stroke-opacity="0.75" stroke-width="1.5" />`;

  // Han palace (ranks 7..9, cols 3..5)
  const h37 = getPt(3, 7), h59 = getPt(5, 9);
  const h57 = getPt(5, 7), h39 = getPt(3, 9);
  lines += `<line x1="${h37.x}" y1="${h37.y}" x2="${h59.x}" y2="${h59.y}" stroke="#34d399" stroke-opacity="0.75" stroke-width="1.5" />`;
  lines += `<line x1="${h57.x}" y1="${h57.y}" x2="${h39.x}" y2="${h39.y}" stroke="#34d399" stroke-opacity="0.75" stroke-width="1.5" />`;

  svg.innerHTML = lines;

  // Render Intersections and Pieces
  layer.innerHTML = '';
  const pieces = room.board?.pieces || [];
  const pieceMap = {};
  pieces.forEach(p => { pieceMap[`${p.col},${p.row}`] = p; });

  const isMyTurn = (room.game_started && !room.result && myColor && room.active_turn === myColor);

  for (let c = 0; c < 9; c++) {
    for (let r = 0; r < 10; r++) {
      const pt = getPt(c, r);
      const piece = pieceMap[`${c},${r}`];
      const isSelected = selectedPoint && selectedPoint.col === c && selectedPoint.row === r;
      const isLastMove = room.last_to && room.last_to[0] === c && room.last_to[1] === r;

      const ptDiv = document.createElement('div');
      ptDiv.className = `jg-point ${isSelected ? 'selected' : ''} ${isLastMove ? 'last-move' : ''}`;
      ptDiv.style.left = `${pt.x}px`;
      ptDiv.style.top = `${pt.y}px`;

      if (piece) {
        const pieceDiv = document.createElement('div');
        const pType = piece.piece.toUpperCase();
        const sizeClass = (pType === 'K') ? 'king' : (pType === 'P' || pType === 'A') ? 'soldier' : '';
        pieceDiv.className = `jg-piece ${piece.color} ${sizeClass}`;
        pieceDiv.textContent = HANJA_MAP[piece.piece] || piece.piece;
        ptDiv.appendChild(pieceDiv);
      }

      ptDiv.addEventListener('click', () => handlePointClick(c, r, piece, isMyTurn));
      layer.appendChild(ptDiv);
    }
  }
}

function handlePointClick(c, r, piece, isMyTurn) {
  if (!currentRoom || !currentRoom.game_started || currentRoom.result) return;
  if (!isMyTurn) return;

  if (selectedPoint) {
    // If clicking same piece, deselect
    if (selectedPoint.col === c && selectedPoint.row === r) {
      selectedPoint = null;
      renderJgBoard(currentRoom);
      return;
    }
    // If clicking another friendly piece, switch selection
    if (piece && piece.color === myColor) {
      selectedPoint = { col: c, row: r };
      renderJgBoard(currentRoom);
      return;
    }
    // Attempt move
    sendJgAction('move', {
      from_col: selectedPoint.col,
      from_row: selectedPoint.row,
      to_col: c,
      to_row: r
    });
    playWoodClickSound();
    selectedPoint = null;
  } else {
    // Select friendly piece
    if (piece && piece.color === myColor) {
      selectedPoint = { col: c, row: r };
      renderJgBoard(currentRoom);
    }
  }
}

function handlePassTurn() {
  if (!currentRoom || !currentRoom.game_started || currentRoom.result) return;
  if (myColor !== currentRoom.active_turn) {
    showToast('자신의 차례에만 한수 쉼을 할 수 있습니다.', 'info');
    return;
  }
  sendJgAction('pass_turn');
}

function handleScoreJudge() {
  if (!currentRoom || !currentRoom.game_started || currentRoom.result) return;
  if (confirm('현재 기물 점수로 승패를 판정하시겠습니까? (한 1.5점 덤 포함)')) {
    sendJgAction('request_score_judge');
  }
}

function handleResign() {
  if (!currentRoom || !currentRoom.game_started || currentRoom.result) return;
  if (confirm('정말로 기권하시겠습니까?')) {
    sendJgAction('resign');
  }
}

function handleLeaveRoom() {
  if (!currentRoom) return;
  sendJgAction('leave_room');
  currentRoom = null;
  updateJgRoomState(null);
}

function renderJgMoveHistory(history) {
  const list = $('jgMoveList');
  if (!list) return;
  if (!history.length) {
    list.innerHTML = '<div class="chess-empty-history">대국이 시작되면 기록됩니다.</div>';
    return;
  }
  list.innerHTML = history.map((item, idx) => `
    <div class="chess-move-item" style="padding:3px 8px;font-size:12px;">
      <span style="color:var(--jg-muted);width:26px;">${idx + 1}.</span>
      <span>${item.move}</span>
    </div>
  `).join('');
  list.scrollTop = list.scrollHeight;
}

function startJgClock(room) {
  if (clockInterval) clearInterval(clockInterval);
  if (!room.game_started || room.result) return;

  const updateTimers = () => {
    const now = Date.now() / 1000;
    const turn = room.active_turn;
    const clock = room.clock || {};

    let choRemain = clock.cho_remain || 0;
    let hanRemain = clock.han_remain || 0;

    if (turn === 'cho' && clock.cho_deadline) {
      choRemain = Math.max(0, clock.cho_deadline - now);
    } else if (turn === 'han' && clock.han_deadline) {
      hanRemain = Math.max(0, clock.han_deadline - now);
    }

    const fmt = s => {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    };

    if ($('jgChoTimer')) $('jgChoTimer').textContent = fmt(choRemain);
    if ($('jgHanTimer')) $('jgHanTimer').textContent = fmt(hanRemain);
  };

  updateTimers();
  clockInterval = setInterval(updateTimers, 500);
}

function appendJgChat(sender, text, timeStr) {
  const container = $('jgChatMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'chess-chat-item';
  div.innerHTML = `
    <span class="chess-chat-time" style="color:var(--jg-muted);">${timeStr}</span>
    <span class="chess-chat-sender" style="color:#a7f3d0;font-weight:600;">${sender}:</span>
    <span class="chess-chat-body">${text}</span>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}
