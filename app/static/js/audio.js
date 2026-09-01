// ============================================================
// Audio Module: Web Audio Synthesizer & Sound Settings
// ============================================================

import { state } from './state.js';

let audioCtx = null;
let lastSoundTime = 0;
const SOUND_THROTTLE_MS = 500;

function getSoundModeKey() {
  return state.currentUser ? `bamboochat_sound_mode_${state.currentUser.id}` : 'bamboochat_sound_mode';
}

function getSoundVolumeKey() {
  return state.currentUser ? `bamboochat_sound_volume_${state.currentUser.id}` : 'bamboochat_sound_volume';
}

export function getSoundMode() {
  try {
    return localStorage.getItem(getSoundModeKey()) || 'important';
  } catch {
    return 'important';
  }
}

export function setSoundMode(mode) {
  try {
    localStorage.setItem(getSoundModeKey(), mode);
  } catch { /* storage */ }
}

export function getSoundVolume() {
  try {
    const raw = localStorage.getItem(getSoundVolumeKey());
    return raw !== null ? Math.max(0, Math.min(1, parseFloat(raw))) : 0.5;
  } catch {
    return 0.5;
  }
}

export function setSoundVolume(volume) {
  try {
    localStorage.setItem(getSoundVolumeKey(), String(Math.max(0, Math.min(1, volume))));
  } catch { /* storage */ }
}

export function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

export function playNotificationSound(overrideThrottle = false) {
  const now = Date.now();
  if (!overrideThrottle && (now - lastSoundTime < SOUND_THROTTLE_MS)) return;
  lastSoundTime = now;

  const volume = getSoundVolume();
  if (volume <= 0) return;

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const gainNode = ctx.createGain();
    gainNode.connect(ctx.destination);
    gainNode.gain.setValueAtTime(volume * 0.15, ctx.currentTime);

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();

    osc1.type = 'sine';
    osc2.type = 'sine';

    osc1.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc1.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.08); // A5

    osc2.frequency.setValueAtTime(880, ctx.currentTime + 0.08); // A5
    osc2.frequency.exponentialRampToValueAtTime(1174.66, ctx.currentTime + 0.16); // D6

    osc1.connect(gainNode);
    osc2.connect(gainNode);

    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

    osc1.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.12);

    osc2.start(ctx.currentTime + 0.08);
    osc2.stop(ctx.currentTime + 0.35);
  } catch {
    // Suppressed audio error
  }
}
