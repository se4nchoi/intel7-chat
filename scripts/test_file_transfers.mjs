// Run: node --experimental-vm-modules scripts/test_file_transfers.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('completed uploads update the composer and drain the queue after 100% progress', async () => {
  const source = await readFile(new URL('../app/static/js/chat.js', import.meta.url), 'utf8');
  const requests = [], sendButton = { disabled: false };
  let storageRefreshes = 0;
  class Request {
    constructor() {
      this.events = new Map();
      this.upload = { addEventListener: (name, callback) => this.events.set(`upload:${name}`, callback) };
      requests.push(this);
    }
    open() {} setRequestHeader() {} send() {}
    addEventListener(name, callback) { this.events.set(name, callback); }
    complete(status = 201) {
      this.status = status;
      this.responseText = JSON.stringify(status === 201
        ? { id: `file-${requests.indexOf(this)}`, url: '/api/files/test', size: 123, previewable: false }
        : { detail: '업로드 제한' });
      this.events.get('load')();
    }
  }
  const state = { activeRoom: { type: 'channel', id: 1 } };
  const context = vm.createContext({ console, XMLHttpRequest: Request,
    document: { addEventListener() {}, getElementById: id => id === 'send-btn' ? sendButton : null },
  });
  const module = new vm.SourceTextModule(source, { context });
  const dependencies = new Map([...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)]
    .map(match => [match[2], match[1].split(',').map(name => name.trim())]));
  await module.link(specifier => {
    const names = dependencies.get(specifier);
    return new vm.SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, name === 'state' ? state
        : name === 'refreshStorageWarning' ? () => { storageRefreshes++; } : () => {});
    }, { context });
  });
  await module.evaluate();
  const files = [1, 2, 3].map(id => ({ clientId: id, status: 'queued', file: { name: `lecture-${id}.pdf` } }));
  module.namespace.pendingAttachments.set('channel:1', files);
  module.namespace.processUploadQueue();
  assert.equal(requests.length, 2);
  assert.equal(sendButton.disabled, true);
  requests[0].events.get('upload:progress')({ lengthComputable: true, loaded: 123, total: 123 });
  assert.equal(files[0].progress, 100);
  assert.equal(files[0].status, 'uploading');
  requests[0].complete();
  assert.equal(requests.length, 3);
  assert.equal(files[0].status, 'ready');
  assert.equal(files[0].file, null);
  requests[1].complete();
  requests[2].complete(413);
  assert.equal(storageRefreshes, 2);
  assert.equal(files[2].status, 'error');
  assert.equal(sendButton.disabled, false);
});
