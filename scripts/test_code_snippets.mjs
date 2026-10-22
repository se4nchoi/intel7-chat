// Run: node --experimental-vm-modules scripts/test_code_snippets.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('../app/static/js/code_snippets.js', import.meta.url), 'utf8');
const { parseCodeSnippets, splitShellCommands } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const example = String.raw`sudo apt update
sudo apt install -y git curl ffmpeg build-essential cmake \
pkg-config python3-dev libevdev-dev v4l-utils usbutils tree
# 시리얼(dialout) · 카메라(video) 권한
sudo usermod -aG dialout,video,plugdev $USER
# 로봇 보드(1a86) · 카메라 노드를 누구나 읽고 쓰게
echo 'SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", MODE="0666"' | \
sudo tee /etc/udev/rules.d/99-so101-cameras.rules
echo 'SUBSYSTEM=="video4linux", MODE="0666"' | \
sudo tee -a /etc/udev/rules.d/99-so101-cameras.rules
sudo udevadm control --reload-rules && sudo udevadm trigger`;

test('instructor shell paste preserves exact text, comments, quotes and continuations', () => {
  const blocks = parseCodeSnippets(example);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].language, 'bash');
  assert.equal(blocks[0].code, example);
  assert.equal(blocks[0].detected, true);
});
test('each complete command is separately copyable, with multiline commands intact', () => {
  const rows = splitShellCommands(example);
  assert.equal(rows.map(row => row.text).join('\n'), example);
  const commands = rows.filter(row => row.type === 'command');
  assert.equal(commands.length, 6);
  assert.equal(commands[0].text, 'sudo apt update');
  assert.equal(commands[1].text, example.split('\n').slice(1, 3).join('\n'));
  assert.equal(commands[3].text, example.split('\n').slice(6, 8).join('\n'));
  assert.equal(commands[5].text, 'sudo udevadm control --reload-rules && sudo udevadm trigger');
});
test('surrounding explanations stay out of command payloads', () => {
  const blocks = parseCodeSnippets(`아래 명령을 실행하세요.\n\n${example}\n\n완료 후 다시 로그인하세요.`);
  assert.equal(blocks.filter(b => b.type === 'code').length, 1);
  assert.equal(blocks.find(b => b.type === 'code').code, example);
  assert.match(blocks.at(-1).text, /로그인/);
});
test('ordinary messages and their paragraph breaks are preserved', () => {
  for (const text of ['오늘 3시에 시작합니다.\n준비해 주세요.', '- 첫 번째\n- 두 번째',
    '> 설명\n> 인용', 'x = 3', '    들여쓴 설명\n    다음 설명',
    '함수 `print()`를 써 보세요.\nhttps://example.com', '# 오늘 수업\n설명입니다.']) {
    assert.equal(parseCodeSnippets(text).some(b => b.type === 'code'), false, text);
  }
  assert.equal(parseCodeSnippets('첫 문단\n\n둘째 문단')[0].text, '첫 문단\n\n둘째 문단');
});

test('Windows and Linux setup commands are detected by structure, without executable allowlists', () => {
  for (const command of [
    'winget install --id Docker.DockerDesktop -e',
    'wsl -d Ubuntu-24.04 -u root',
    'useradd -m -s /bin/bash jr',
    'passwd 변경할_사용자_ID',
    'wsl -d Ubuntu-24.04 -u jr(username 선택한걸로)',
    'classroom-tool --device robot',
    'another-tool ./config.json',
  ]) {
    const code = parseCodeSnippets(command).filter(part => part.type === 'code');
    assert.equal(code.length, 1, command);
    assert.equal(code[0].code, command);
  }
});

test('mixed Korean setup instructions stay separate from copyable commands', () => {
  const source = 'wsl 설치되었거나 계정이 이미 있던경우\n\nwsl -d Ubuntu-24.04 -u root\n\nuseradd -m -s /bin/bash jr\n\npasswd 변경할_사용자_ID\n\n로그인시\nwsl -d Ubuntu-24.04 -u jr(username 선택한걸로)';
  const parts = parseCodeSnippets(source);
  assert.deepEqual(parts.filter(part => part.type === 'code')
    .flatMap(part => splitShellCommands(part.code).filter(row => row.type === 'command').map(row => row.text)), [
      'wsl -d Ubuntu-24.04 -u root', 'useradd -m -s /bin/bash jr',
      'passwd 변경할_사용자_ID', 'wsl -d Ubuntu-24.04 -u jr(username 선택한걸로)',
    ]);
  assert.equal(parts[0].type, 'text');
  assert.match(parts.find(part => part.type === 'text' && part.text.includes('로그인시')).text, /로그인시/);
  for (const text of ['wsl 설치 방법', 'winget 설치 후 로그아웃', 'passwd 변경 방법', '아래 --id 옵션을 사용하세요.']) {
    assert.equal(parseCodeSnippets(text).some(part => part.type === 'code'), false, text);
  }
});

test('command families keep unflagged lines and inline comments inside one snippet', () => {
  const commands = 'cd ~/physical-ai-studio/application/docker\ndocker compose pull\ndocker compose up -d\ndocker compose ps # STATUS = Up (healthy)\ndocker compose logs -f # 로그 보기 (Ctrl+C로 빠져나오기)';
  const source = '24슬라이드 오타있습니다 수정된 내용 공유드릴게요\n' + commands;
  const parts = parseCodeSnippets(source);
  const blocks = parts.filter(part => part.type === 'code');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].code, commands);
  assert.equal(splitShellCommands(blocks[0].code).filter(row => row.type === 'command').length, 5);
  assert.equal(parts[0].text, '24슬라이드 오타있습니다 수정된 내용 공유드릴게요');
  for (const executable of ['classroom-tool', 'git', 'podman']) {
    const source = `${executable} status\n${executable} start --device robot\n${executable} stop # 완료`;
    assert.equal(parseCodeSnippets(source)[0].code, source);
  }
  const mixed = parseCodeSnippets('wsl -d Ubuntu-24.04 -u root\nwsl 설치 방법은 아래 설명을 참고하세요\nwsl 설치 후 다시 로그인');
  assert.equal(mixed.filter(part => part.type === 'code').length, 1);
  assert.equal(mixed[0].code, 'wsl -d Ubuntu-24.04 -u root');
});
test('Python indentation, blank lines, CRLF and tabs survive parsing', () => {
  const python = 'def hello(name):\n    print(name)\n\nhello("학생")';
  assert.equal(parseCodeSnippets(python)[0].code, python);
  assert.equal(parseCodeSnippets('```sh\r\n\techo "$USER"\r\n```')[0].code, '\techo "$USER"');
});
test('fences support nesting, multiple snippets, literal HTML, and missing closing fences', () => {
  const blocks = parseCodeSnippets('앞 설명\n````html\n<script>alert("example")</script>\n```\n````\n뒤 설명\n~~~bash\nsudo apt update');
  const code = blocks.filter(b => b.type === 'code');
  assert.equal(code.length, 2);
  assert.equal(code[0].detected, false);
  assert.equal(code[0].code, '<script>alert("example")</script>\n```');
  assert.equal(code[1].language, 'bash');
});
test('quoted operators do not join independent commands', () => {
  assert.deepEqual(splitShellCommands('echo "text | &&"\nsudo apt update').map(row => row.text),
    ['echo "text | &&"', 'sudo apt update']);
});
test('pipelines, AND continuations, multiline quotes and heredocs stay together', () => {
  for (const command of ['echo "hi" |\nsudo tee /tmp/example',
    'sudo apt update &&\nsudo apt install git', "echo 'first\nsecond'", 'cat <<EOF\nhello\nEOF',
    "cat <<'EOF'\nhello\n EOF\nEOF", 'cat <<-"EOF"\n\thello\n\tEOF']) {
    const rows = splitShellCommands(command + '\nsudo apt update');
    assert.equal(rows[0].text, command);
    assert.equal(rows[1].text, 'sudo apt update');
  }
});
test('comments alone do not produce command copy buttons', () => {
  assert.equal(splitShellCommands('# 설명\n\n# 다음 설명').some(row => row.type === 'command'), false);
});
test('selection guard blocks actions during drag and selected text but leaves copy buttons usable', async () => {
  const source = await readFile(new URL('../app/static/js/message_selection.js', import.meta.url), 'utf8');
  const events = new Map(), classes = new Set();
  let selection = { isCollapsed: true };
  const context = vm.createContext({
    window: { getSelection: () => selection, addEventListener: (name, fn) => events.set(name, fn) },
    document: { body: { classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } },
      addEventListener: (name, fn) => events.set(name, fn) },
  });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => { throw new Error('Unexpected dependency'); }); await module.evaluate();
  module.namespace.initMessageSelectionGuard();
  const text = { closest: selector => selector === '.msg-bubble' ? {} : null };
  events.get('pointerdown')({ button: 0, target: text });
  assert.equal(module.namespace.messageActionsBlocked(), true);
  selection = { isCollapsed: false, anchorNode: { parentElement: text } };
  events.get('pointerup')();
  assert.equal(module.namespace.messageActionsBlocked(), true);
  selection = { isCollapsed: true }; events.get('selectionchange')();
  assert.equal(classes.has('message-selection-active'), false);
  const button = { closest: selector => selector === '.msg-bubble' || selector.startsWith('button') ? {} : null };
  events.get('pointerdown')({ button: 0, target: button });
  assert.equal(module.namespace.messageActionsBlocked(), false);
});

test('format overrides persist per message and account, reset to automatic, and handle unavailable storage', async () => {
  const source = await readFile(new URL('../app/static/js/message_format.js', import.meta.url), 'utf8');
  const storage = new Map();
  let blocked = false;
  const context = vm.createContext({ localStorage: {
    getItem: key => storage.get(key) || null,
    setItem(key, value) { if (blocked) throw new Error('Storage unavailable'); storage.set(key, value); },
  } });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => { throw new Error('Unexpected dependency'); }); await module.evaluate();
  const { getMessageFormat, setMessageFormat } = module.namespace;
  const message = { message_id: 'public:1', content: 'docker run hello-world' };
  assert.equal(getMessageFormat(message, 1), 'auto');
  assert.equal(setMessageFormat(message, 1, 'code'), true);
  assert.equal(getMessageFormat(message, 1), 'code');
  assert.equal(getMessageFormat(message, 2), 'auto');
  assert.equal(getMessageFormat({ message_id: 'dm:1' }, 1), 'auto');
  assert.equal(setMessageFormat(message, 1, 'auto'), true);
  assert.equal(getMessageFormat(message, 1), 'auto');
  storage.set('bamboochat_message_formats_v1_1', '{broken');
  assert.equal(getMessageFormat(message, 1), 'auto');
  blocked = true;
  assert.equal(setMessageFormat(message, 1, 'commands'), false);
  assert.equal(getMessageFormat(message, 1), 'commands');
  assert.equal(message.content, 'docker run hello-world');
  assert.equal(setMessageFormat(message, 1, 'unexpected'), false);
});
