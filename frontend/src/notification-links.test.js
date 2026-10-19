import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationUrl } from './notification-links.js';

test('notification URLs restore question and old message context', () => {
  assert.equal(notificationUrl({ kind: 'answer', cohort_slug: '수업 반', question_id: 105 }), '/hub/cohorts/%EC%88%98%EC%97%85%20%EB%B0%98/board#post-105');
  assert.equal(notificationUrl({ kind: 'mention', cohort_slug: 'class-a', channel_id: 37, message_id: 1 }), '/hub/cohorts/class-a/chat?channel=37#message-1');
});
test('incomplete notification targets cannot create misleading navigation', () => {
  for (const item of [{}, { kind: 'answer', cohort_slug: 'a', question_id: -1 }, { kind: 'mention', cohort_slug: 'a', channel_id: 1, message_id: 'javascript:bad' }]) assert.throws(() => notificationUrl(item));
});
