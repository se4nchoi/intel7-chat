// A persistent, non-modal status for cohort live updates only.
const MESSAGES = {
  idle: '', connected: '',
  connecting: '실시간 업데이트에 연결하는 중입니다…',
  reconnecting: '실시간 업데이트 연결이 끊겼습니다. 자동으로 다시 연결합니다.',
  offline: '기기가 오프라인입니다. 연결이 돌아오면 실시간 업데이트를 다시 연결합니다.',
};

export class ConnectionStatus {
  constructor({ root, message, retry, announcement }) {
    Object.assign(this, { root, message, retry, announcement, kind: 'idle', onRetry: null });
    retry.addEventListener('click', () => this.onRetry?.());
    this.set('idle');
  }
  set(kind, onRetry = null) {
    if (!Object.hasOwn(MESSAGES, kind)) throw new Error('Unknown connection state');
    const previous = this.kind;
    this.kind = kind;
    this.onRetry = onRetry;
    this.root.dataset.state = kind;
    this.root.classList.toggle('hidden', !MESSAGES[kind]);
    this.message.textContent = MESSAGES[kind];
    this.retry.disabled = !onRetry;
    this.retry.classList.toggle('hidden', !onRetry);
    // Retry attempts replace their callback, without repeating a live announcement.
    if (previous === kind) return;
    this.announcement.textContent = kind === 'connected'
      ? (previous === 'reconnecting' || previous === 'offline' ? '실시간 업데이트가 다시 연결되었습니다.' : '')
      : MESSAGES[kind];
  }
}
