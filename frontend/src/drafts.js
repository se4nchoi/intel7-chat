// A tab's drafts are isolated by account, cohort, conversation kind and target.
export class DraftStore {
  constructor(storage) { this.storage = storage; this.memory = new Map(); }
  key(account, cohort, kind, target) {
    return account && cohort && target ? `madi-draft:${account}:${cohort}:${kind}:${target}` : null;
  }
  get(key) {
    if (!key) return '';
    try { return this.storage?.getItem(key) ?? this.memory.get(key) ?? ''; }
    catch { return this.memory.get(key) ?? ''; }
  }
  set(key, text) {
    if (!key) return;
    this.memory.set(key, text);
    try { if (text) this.storage?.setItem(key, text); else this.storage?.removeItem(key); } catch { /* memory fallback */ }
  }
  clearIfUnchanged(key, sent) {
    if (this.get(key) === sent) this.set(key, '');
  }
}
