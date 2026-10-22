import test from 'node:test';
import assert from 'node:assert/strict';
import { questionFileError, mergeQuestionFiles, formatFileSize, insertCodeFence } from './composer.js';

test('question file selection enforces count and size before upload', () => {
  assert.equal(questionFileError([{ size: 1 }, { size: 10 * 1024 * 1024 }]), '');
  assert.match(questionFileError(Array.from({ length: 6 }, () => ({ size: 1 }))), /5개/);
  assert.match(questionFileError([{ size: 0 }]), /1바이트/);
  assert.match(questionFileError([{ size: 10 * 1024 * 1024 + 1 }]), /10MB/);
  assert.match(questionFileError([{ name: 'danger.EXE', size: 100 }]), /실행 파일/);
  assert.equal(questionFileError([{ name: 'ladder.gwx', size: 100 }]), '');
  assert.equal(formatFileSize(1000), '1 KB');
  assert.equal(formatFileSize(1024 * 1024), '1.0 MB');
  const file = { name: 'ladder.gwx', size: 100, lastModified: 42 };
  assert.deepEqual(mergeQuestionFiles([file], [{ ...file }]), [file]);
});

test('code helper keeps selected text and returns a selection inside the fence', () => {
  const result = insertCodeFence('앞 plc 코드 뒤', 2, 8);
  assert.equal(result.value, '앞 \n```\nplc 코드\n```\n 뒤');
  assert.equal(result.value.slice(result.start, result.end), 'plc 코드');
  const empty = insertCodeFence('', 0, 0);
  assert.equal(empty.value, '```\n코드를 입력하세요\n```');
});
