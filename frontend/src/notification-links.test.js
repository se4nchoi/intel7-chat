import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationUrl, readAnswerTarget } from './notification-links.js';

test('notification URLs restore question and old message context', () => {
  assert.equal(notificationUrl({ kind: 'answer', cohort_slug: '수업 반', question_id: 105, answer_id: 42 }), '/hub/cohorts/%EC%88%98%EC%97%85%20%EB%B0%98/board?answer=42#post-105');
  assert.equal(notificationUrl({ kind: 'mention', cohort_slug: 'class-a', channel_id: 37, message_id: 1 }), '/hub/cohorts/class-a/chat?channel=37#message-1');
});
test('incomplete notification targets cannot create misleading navigation', () => {
  for (const item of [{}, { kind: 'answer', cohort_slug: 'a', question_id: -1, answer_id: 2 }, { kind: 'answer', cohort_slug: 'a', question_id: 1 }, { kind: 'mention', cohort_slug: 'a', channel_id: 1, message_id: 'javascript:bad' }]) assert.throws(() => notificationUrl(item));
});

test('question links remain valid without an answer target, and malformed IDs are ignored', () => {
  assert.deepEqual(readAnswerTarget('', '#post-105'), { questionId: 105, answerId: null });
  assert.deepEqual(readAnswerTarget('?answer=42', '#post-105'), { questionId: 105, answerId: 42 });
  assert.deepEqual(readAnswerTarget('?answer=javascript:bad', '#post-105'), { questionId: 105, answerId: null });
  assert.deepEqual(readAnswerTarget('?answer=42', '#post-999999999999999999999'), { questionId: null, answerId: null });
});
