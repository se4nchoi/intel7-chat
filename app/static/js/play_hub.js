// ============================================================
// BambooChat - Play Hub (놀이마당) Controller
// Supports Chess (B&W tone), Janggi (Green-ish tone), Omok (Woody tone)
// ============================================================

import { state } from './state.js';
import { showToast } from './utils.js';

let activeGame = 'chess'; // 'chess' | 'janggi' | 'omok'
const LAST_GAME_KEY = 'bamboochat_last_game';

export function getActiveGame() {
  return activeGame;
}

export function openPlayModal(requestedGame = null) {
  const modal = document.getElementById('play-modal');
  if (!modal) return;

  const targetGame = requestedGame || localStorage.getItem(LAST_GAME_KEY) || 'chess';
  modal.classList.remove('hidden');
  switchGameTab(targetGame);
}

export function closePlayModal() {
  const modal = document.getElementById('play-modal');
  if (!modal) return;
  modal.classList.add('hidden');
}

export function switchGameTab(game) {
  if (!['chess', 'janggi', 'omok'].includes(game)) {
    game = 'chess';
  }
  activeGame = game;
  localStorage.setItem(LAST_GAME_KEY, game);

  const dialog = document.getElementById('play-dialog');
  if (dialog) {
    dialog.classList.remove('theme-chess', 'theme-janggi', 'theme-omok');
    dialog.classList.add(`theme-${game}`);
  }

  // Update tab buttons
  const tabs = document.querySelectorAll('.play-tab-btn');
  tabs.forEach(tab => {
    const isTarget = tab.getAttribute('data-game') === game;
    tab.classList.toggle('active', isTarget);
    tab.setAttribute('aria-selected', isTarget ? 'true' : 'false');
  });

  // Toggle views
  const chessView = document.getElementById('play-view-chess');
  const janggiView = document.getElementById('play-view-janggi');
  const omokView = document.getElementById('play-view-omok');

  if (chessView) chessView.classList.toggle('hidden', game !== 'chess');
  if (janggiView) janggiView.classList.toggle('hidden', game !== 'janggi');
  if (omokView) omokView.classList.toggle('hidden', game !== 'omok');

  // Trigger game-specific hooks
  if (game === 'chess' && window.bambooChessHook?.onTabActive) {
    window.bambooChessHook.onTabActive();
  } else if (game === 'janggi' && window.bambooJanggiHook?.onTabActive) {
    window.bambooJanggiHook.onTabActive();
  } else if (game === 'omok' && window.bambooOmokHook?.onTabActive) {
    window.bambooOmokHook.onTabActive();
  }
}

export function initPlayHubListeners() {
  const hubBtn = document.getElementById('play-hub-btn');
  const closeBtn = document.getElementById('play-modal-close');
  const modal = document.getElementById('play-modal');

  if (hubBtn) {
    hubBtn.addEventListener('click', () => openPlayModal());
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', closePlayModal);
  }

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closePlayModal();
      }
    });
  }

  // Tab switching clicks
  const tabs = document.querySelectorAll('.play-tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const g = tab.getAttribute('data-game');
      switchGameTab(g);
    });
  });

  // ESC key closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      closePlayModal();
    }
  });
}
