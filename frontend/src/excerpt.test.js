import test from 'node:test';
import assert from 'node:assert/strict';
import { plainExcerpt } from './excerpt.js';

test('plain excerpt keeps readable code and prose without raw formatting markers', () => {
  assert.equal(plainExcerpt('질문 **굵게** `code`\n```python\nprint("안녕")\n```'), '질문 굵게 code 코드 (python): print("안녕")');
  assert.equal(plainExcerpt('> [설명](https://example.com)\n- 다음 단계 @teacher'), '설명 다음 단계 @teacher');
  assert.equal(plainExcerpt('```sql\nSELECT * FROM t'), '코드: SELECT * FROM t');
});

test('plain excerpt is bounded text and does not interpret markup', () => {
  assert.equal(plainExcerpt('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  assert.equal(plainExcerpt('가'.repeat(200), 12), `${'가'.repeat(11)}…`);
});
