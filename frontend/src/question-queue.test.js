import test from 'node:test';
import assert from 'node:assert/strict';
import { waitingAge, nextQueueQuestion } from './question-queue.js';

test('waiting age reports elapsed time without an urgency threshold', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  assert.equal(waitingAge('2026-10-22T11:59:45Z', now), '방금 등록');
  assert.equal(waitingAge('2026-10-22T11:01:00Z', now), '59분째 대기');
  assert.equal(waitingAge('2026-10-22T10:00:00Z', now), '2시간째 대기');
  assert.equal(waitingAge('2026-10-20T12:00:00Z', now), '2일째 대기');
  assert.equal(waitingAge('invalid', now), '');
});

test('next queue entry follows displayed order and recovers after current item leaves queue', () => {
  const questions = [{ id: 5 }, { id: 10 }, { id: 15 }];
  assert.equal(nextQueueQuestion(questions, 10).id, 15);
  assert.equal(nextQueueQuestion(questions, 15), null);
  assert.equal(nextQueueQuestion(questions, 99).id, 5);
});
