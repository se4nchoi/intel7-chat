import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster, credentialsCsv, rosterPreviewSummary } from './roster.js';

test('CSV preserves quoted names, BOM and multiline cells, with optional roles', () => {
  assert.deepEqual(parseRoster('\uFEFFusername,display_name,role\r\nstu01,"김, 학생",student\r\ninst01,"김 ""강사""",강사'), [
    { username: 'stu01', display_name: '김, 학생', role: 'student' },
    { username: 'inst01', display_name: '김 "강사"', role: 'instructor' },
  ]);
  assert.equal(parseRoster('username,display_name\nstu01,"김\n학생"')[0].role, 'student');
});
test('spreadsheet TSV uses named columns and skips blank lines', () => {
  assert.deepEqual(parseRoster('display_name\tusername\trole\r\n최학생\tstu01\t학생\r\n\t\t\r\n'), [{ display_name: '최학생', username: 'stu01', role: 'student' }]);
});
test('malformed and oversized imports fail before preview', () => {
  for (const bad of ['username,username\na,b', 'username,display_name,password\na,b,c', 'username,display_name\na', 'username,display_name\na,"b', 'username,display_name\na,"b"c', 'username,display_name', 'x'.repeat(100001), 'username,display_name\n' + 'aa,bb\n'.repeat(101)]) assert.throws(() => parseRoster(bad));
});
test('credential CSV escapes quotes and spreadsheet formulas', () => {
  const csv = credentialsCsv([{ username: 'stu01', display_name: '=HYPERLINK("x")', temporary_password: 'random-value' }]);
  assert(csv.startsWith('\uFEFF'));
  assert(csv.includes('"\'=HYPERLINK(""x"")"'));
  assert(csv.includes('"random-value"'));
});

test('copyable credentials preserve exact login strings, independently of CSV formula escaping', () => {
  const credentials = [{ username: '-learner', display_name: 'Learner', temporary_password: '-random-secret' }];
  const raw = credentialsCsv(credentials, { spreadsheetSafe: false });
  assert(raw.includes('"-learner"'));
  assert(raw.includes('"-random-secret"'));
  assert(credentialsCsv(credentials).includes('"\'-learner"'));
});


test('preview summary distinguishes valid actions from blocking rows', () => {
  const summary = rosterPreviewSummary({ cohort: { name: '파이썬 수업' }, total_rows: 3, invalid_rows: 1,
    counts: { create: 1, enroll: 0, unchanged: 1 } });
  assert.equal(summary, '파이썬 수업 · 검토한 3행 · 신규 1명 · 기존 계정 배정 0명 · 이미 배정 1명 · 오류 1행');
});

test('column errors count data records rather than physical CSV lines', () => {
  assert.throws(() => parseRoster('username,display_name\n\nstu01,"김\n학생"\n\nbroken'), /2번째 데이터 행.*제목 행 제외/);
});
