import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const javascriptDirectory = path.join(repositoryRoot, 'app', 'static', 'js');
const files = (await readdir(javascriptDirectory))
  .filter((name) => name.endsWith('.js'))
  .sort();

const failures = [];
for (const name of files) {
  const filePath = path.join(javascriptDirectory, name);
  const content = await readFile(filePath, 'utf8');
  const result = spawnSync(process.execPath, ['--input-type=module', '--check', '-'], {
    cwd: repositoryRoot,
    input: content,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failures.push({ name, output: `${result.stdout || ''}${result.stderr || ''}`.trim() });
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`\nJavaScript syntax check failed: ${failure.name}`);
    console.error(failure.output);
  }
  process.exitCode = 1;
} else {
  console.log(`JavaScript syntax OK: ${files.length} modules`);
}
