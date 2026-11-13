// Several OpenBot servers behind the single-client interface the bridge uses: this
// computer (read from its database, see openbot.js) and the account's other servers
// (over OpenBot's relay, see team/src). The game's agent filter lists each server, which
// is the server switcher.
//
// Ids stay unique across servers: this computer keeps raw ids, so saved state stays
// valid; another server's ids get its code as a prefix ("s1~<id>"). Every thread and
// agent handed out is a shallow copy with `id`/`projectId` rewritten and `_env` set.

import { EventEmitter } from 'node:events';

const SEP = '~';

export class Fleet extends EventEmitter {
  constructor({ local, log = () => {} }) {
    super();
    this.log = log;
    this.envs = [];
    this.threads = new Map();
    this.projects = new Map();
    // This computer's database client: what the game shows when the relay isn't in use.
    this.database = local;
    this.add({ code: '', id: 'local', label: 'this computer', local: true, client: local, via: 'database' });
  }

  // Show this computer through the relay (`client`, with full features), or with null from its
  // database again. Thread ids change with the switch, so callers switch rarely.
  useLocal(client) {
    const env = this.local;
    const next = client || this.database;
    if (env.client === next) return;
    env.off?.();
    env.client = next;
    env.via = client ? 'relay' : 'database';
    this.log(`this computer: ${client ? 'through the OpenBot relay' : 'from its database'}`);
    this.wire(env);
    this.rebuild(env);
    this.emit('change', { kind: 'snapshot', env });
    this.emit('config', env);
    this.emit('state', this.state, this.error, env);
  }

  // A server: { code, id, label, client }, where client has OpenBotClient's interface.
  add(env) {
    if (this.envs.some((e) => e.code === env.code)) throw new Error(`server code ${env.code} is taken`);
    this.envs.push(env);
    this.wire(env);
    return env;
  }

  // Takes a server out. With `stop: false` its client keeps running, for another use.
  remove(code, { stop = true } = {}) {
    const env = this.envs.find((e) => e.code === code && !e.local);
    if (!env) return;
    env.off?.();
    if (stop) env.client.stop();
    this.envs = this.envs.filter((e) => e !== env);
    this.drop(env);
    this.emit('change', { kind: 'snapshot', env });
    this.emit('config', env);
  }

  get local() {
    return this.envs[0];
  }

  key(env, id) {
    return env.code ? `${env.code}${SEP}${id}` : id;
  }

  split(key) {
    const k = String(key || '');
    const i = k.indexOf(SEP);
    if (i > 0) {
      const env = this.envs.find((e) => e.code === k.slice(0, i));
      if (env) return { env, id: k.slice(i + 1) };
    }
    return { env: this.local, id: k };
  }

  wrapThread(env, t) {
    return { ...t, id: this.key(env, t.id), projectId: this.key(env, t.projectId), _env: env };
  }

  wrapProject(env, p) {
    return { ...p, id: this.key(env, p.id), _env: env };
  }

  drop(env) {
    for (const [k, t] of this.threads) if (t._env === env) this.threads.delete(k);
    for (const [k, p] of this.projects) if (p._env === env) this.projects.delete(k);
  }

  rebuild(env) {
    this.drop(env);
    for (const t of env.client.threads.values()) {
      const w = this.wrapThread(env, t);
      this.threads.set(w.id, w);
    }
    for (const p of env.client.projects.values()) {
      const w = this.wrapProject(env, p);
      this.projects.set(w.id, w);
    }
  }

  wire(env) {
    const c = env.client;
    const onState = (s, e) => {
      if (!env.local) this.log(`${env.label}: ${s}${e ? ` (${e})` : ''}`);
      // A server that drops off takes its threads with it.
      if (!env.local && s !== 'connected') {
        this.drop(env);
        this.emit('change', { kind: 'snapshot', env });
      }
      this.emit('state', this.state, this.error, env);
    };
    const onConfig = () => this.emit('config', env);
    const onChange = (ev) => {
      if (ev.kind === 'thread') {
        const thread = this.wrapThread(env, ev.thread);
        this.threads.set(thread.id, thread);
        this.emit('change', { kind: 'thread', id: thread.id, thread, prev: ev.prev ? this.wrapThread(env, ev.prev) : undefined, env });
      } else if (ev.kind === 'removed') {
        this.threads.delete(this.key(env, ev.id));
        this.emit('change', { kind: 'removed', id: this.key(env, ev.id), env });
      } else {
        this.rebuild(env);
        this.emit('change', { kind: ev.kind, env });
      }
    };
    c.on('state', onState);
    c.on('config', onConfig);
    c.on('change', onChange);
    env.off = () => {
      c.off('state', onState);
      c.off('config', onConfig);
      c.off('change', onChange);
    };
  }

  start() {
    for (const env of this.envs) env.client.start();
    if (this.local.client !== this.database) this.database.start();
  }

  stop() {
    for (const env of this.envs) env.client.stop();
    if (this.local.client !== this.database) this.database.stop();
  }

  // This computer decides "connected" for the link indicator; servers report in
  // `environments()`.
  get state() {
    return this.local.client.state;
  }

  get error() {
    return this.local.client.error;
  }

  get origin() {
    return this.local.client.origin;
  }

  get config() {
    // Usage records are per provider, so every server's providers count.
    const providers = new Map();
    for (const env of this.envs) for (const p of env.client.config?.providers || []) providers.set(p.instanceId, p);
    return { ...this.local.client.config, providers: [...providers.values()] };
  }

  environments() {
    return this.envs.map((e) => ({
      code: e.code,
      label: e.label,
      local: e.local || undefined,
      via: e.local ? e.via : undefined,
      state: e.client.state,
      error: e.client.error || undefined,
      threads: e.client.threads.size,
    }));
  }

  // Local scripts are this computer's database side.
  apiStatus() {
    return this.database.apiStatus();
  }

  // ---- reads and writes, routed by id ------------------------------------------

  threadProjection(key) {
    const { env, id } = this.split(key);
    return env.client.threadProjection(id);
  }

  sendMessage(key, text, mode, attachments) {
    const { env, id } = this.split(key);
    return env.client.sendMessage(id, text, mode, attachments);
  }

  uploadImage(key, data, name, mime) {
    const { env, id } = this.split(key);
    return env.client.uploadImage(id, data, name, mime);
  }

  async launchThread(projectKey, text, attachments, opts) {
    const { env, id } = this.split(projectKey);
    const res = await env.client.launchThread(id, text, attachments, opts);
    if (res?.threadId) res.threadId = this.key(env, res.threadId);
    return res;
  }

  interrupt(key) {
    const { env, id } = this.split(key);
    return env.client.interrupt(id);
  }

  respondApproval(key, requestId, decision) {
    const { env, id } = this.split(key);
    return env.client.respondApproval(id, requestId, decision);
  }

  respondAnswers(key, requestId, answers) {
    const { env, id } = this.split(key);
    return env.client.respondAnswers(id, requestId, answers);
  }

  close(key) {
    const { env, id } = this.split(key);
    return env.client.close(id);
  }

  reopen(key) {
    const { env, id } = this.split(key);
    return env.client.reopen(id);
  }

  visit(key) {
    const { env, id } = this.split(key);
    return env.client.visit(id);
  }

  setModel(key, provider, model, effort) {
    const { env, id } = this.split(key);
    return env.client.setModel(id, provider, model, effort);
  }

  defaultModelFor(projectKey) {
    const { env, id } = this.split(projectKey);
    return env.client.defaultModelFor(id);
  }

  // Each server's models, keyed by its code ('' for this computer).
  modelGroups() {
    return this.envs.map((env) => ({ code: env.code, choices: env.client.modelGroups()[0]?.choices || [] }));
  }
}
