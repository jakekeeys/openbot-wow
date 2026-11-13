// The OpenBot side of the bridge.
//
// Reads come from OpenBot's own database, opened read-only: OpenBot has no API that
// lists chats or messages. Writes go through OpenBot's Local scripts API, the
// loopback API OpenBot runs while at least one agent has "Local scripts" on. Its
// address and token are files in OpenBot's `automation` folder, read again for every
// request because both change when OpenBot restarts.
//
// The bridge was written for T3 Code, so this hands it the same shapes T3's client
// did, and the snapshot, pacing and game side stay as they are:
//   project  an OpenBot agent
//   thread   an agent's main chat, or one of its side threads
//
// The database schema is OpenBot's internal one. Every query is in this file, and
// `checkSchema` names a missing table or column instead of failing somewhere later.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function openbotHome() {
  if (process.env.OPENBOT_HOME) return process.env.OPENBOT_HOME;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'OpenBot');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'OpenBot');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'OpenBot');
}

export function databaseFile() {
  return process.env.OPENBOT_DB || path.join(openbotHome(), 'openbot.db');
}

export function automationDir() {
  return process.env.OPENBOT_AUTOMATION_DIR || path.join(openbotHome(), 'automation');
}

// Where screenshots taken in game go, so the agent can open them: OpenBot's shared
// folder when there is one, since every agent can read it.
export function defaultScreenshotDir(stateDir) {
  const shared = path.join(os.homedir(), 'OpenBot', 'Shared');
  return fs.existsSync(shared) ? path.join(shared, 'wow-screenshots') : path.join(stateDir, 'screenshots');
}

// ---- thread helpers the bridge shares --------------------------------------------

// A main chat is open, working, waiting on you or failed. A side thread can also be closed:
// by OpenBot, or here only (see `close`). Waiting on you or running again comes first.
export function threadStatus(t) {
  if (t.pendingRuntimeRequest) return 'input';
  if (t.activityRunStatus) return 'working';
  if (t.closedAt && !t._main) return 'closed';
  if (t.lastError) return 'failed';
  return 'open';
}

export function isUnread(t) {
  const done = t.latestRunCompletedAt ? Date.parse(t.latestRunCompletedAt) : 0;
  const seen = t.lastVisitedAt ? Date.parse(t.lastVisitedAt) : 0;
  return done > seen;
}

export function effortOf(selection) {
  return selection?.options?.find((o) => o.id === 'reasoningEffort')?.value;
}

// ---- models ----------------------------------------------------------------------

const PROVIDER_NAMES = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  cline: 'Cline',
  pi: 'Pi',
  muse: 'Muse',
  inception: 'Inception',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  hermes: 'Hermes',
  acp: 'ACP',
  kimi: 'Kimi',
  devin: 'Devin',
  copilot: 'Copilot',
  mistral: 'Mistral',
};

export function providerName(id) {
  return PROVIDER_NAMES[id] || id;
}

const EFFORT_LABELS = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
export const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// The models the game offers: those in the bridge's config (`models`, as
// [{ provider, model, name?, efforts? }]), then any model an agent runs on. OpenBot
// has no API that lists its models, so the config is where to add more.
export function modelChoices(agents = [], extra = []) {
  const out = [];
  const seen = new Set();
  const add = (provider, model, name, efforts) => {
    if (!provider || !model) return;
    const key = `${provider}\t${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    const levels = Array.isArray(efforts) ? efforts.filter((e) => typeof e === 'string') : DEFAULT_EFFORTS;
    out.push({
      instanceId: provider,
      model,
      name: name || model,
      provider: providerName(provider),
      effort: levels.length
        ? { id: 'reasoningEffort', options: levels.map((id) => ({ id, label: EFFORT_LABELS[id] || id })), default: levels.includes('high') ? 'high' : levels[0] }
        : undefined,
    });
  };
  for (const m of extra || []) add(m?.provider, m?.model, m?.name, m?.efforts);
  for (const a of agents) add(a.provider, a.model);
  return out;
}

export function agentSelection(agent) {
  if (!agent?.provider || !agent.model) return null;
  return {
    instanceId: agent.provider,
    model: agent.model,
    options: agent.reasoningEffort ? [{ id: 'reasoningEffort', value: agent.reasoningEffort }] : [],
  };
}

// ---- messages --------------------------------------------------------------------

const REPLY_TYPES = new Set(['agentMessage', 'final_answer', 'plan', 'question_prompt']);
const PROGRESS_TYPES = new Set(['agentMessage', 'commentary']);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstLineOf(text, max = 60) {
  const line = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const plain = line.replace(/[*_`#>]/g, '').trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + '…' : plain;
}

// One database row as a transcript message, or null for rows the game doesn't show
// (progress notes, system notices, subagent lists).
export function toMessage(row, agentName = (id) => id) {
  const m = parseJson(row.message_json) || {};
  const text = typeof m.text === 'string' ? m.text : '';
  if (!text.trim()) return null;
  const base = { id: row.message_id, createdAt: row.created_at, streaming: row.status === 'streaming' || undefined, turnId: row.turn_id };
  if (row.author === 'user') return { ...base, role: 'user', text };
  if (row.author === 'agent') {
    const from = m.senderAgentId ? agentName(m.senderAgentId) : 'another agent';
    return { ...base, role: 'user', text: `**From ${from}:** ${text}` };
  }
  if (row.author === 'assistant' && REPLY_TYPES.has(row.item_type || '')) return { ...base, role: 'assistant', text };
  return null;
}

// What a working thread is doing: the latest note the agent wrote in this run.
export function activityFrom(rows, activeTurnId) {
  if (!activeTurnId) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.turn_id !== activeTurnId || r.author !== 'assistant') continue;
    if (r.item_type === 'subagents') return 'Working with subagents';
    if (!PROGRESS_TYPES.has(r.item_type)) continue;
    const line = firstLineOf(parseJson(r.message_json)?.text);
    if (line) return line;
  }
  return 'Working';
}

// ---- pending prompts and approvals -------------------------------------------------

const APPROVAL_KINDS = { command: 'command', 'file-change': 'file-change', 'file-read': 'file-read', permissions: 'permission', permission: 'permission' };

// The pending request the bridge's `pendingRequest` reads, in T3's shape: a runtime
// request plus the turn item that describes it.
export function pendingParts(p) {
  if (!p) return { runtimeRequests: [], turnItems: [] };
  if (p.kind === 'prompt' && !p.requiresOpenBot && p.questions?.length) {
    return {
      runtimeRequests: [{ id: p.requestId, status: 'pending', kind: 'user_input' }],
      turnItems: [
        {
          type: 'user_input_request',
          requestId: p.requestId,
          questions: p.questions.map((q) => ({
            id: q.id,
            header: q.header || '',
            question: q.question || '',
            allowCustomAnswer: true,
            options: (q.options || []).map((o) => ({ label: o.label, description: o.description || '', value: o.label })),
          })),
        },
      ],
    };
  }
  if (p.kind === 'approval') {
    const a = p.approval || {};
    const detail = [a.reason, a.command, a.cwd ? `in ${a.cwd}` : null, a.grantRoot ? `grant ${a.grantRoot}` : null].filter(Boolean).join('\n');
    return {
      runtimeRequests: [{ id: p.requestId, status: 'pending', kind: APPROVAL_KINDS[a.kind] || a.kind || 'permission', nodeId: 'approval' }],
      turnItems: [{ nodeId: 'approval', type: 'dynamic_tool', toolName: null, title: null, input: detail }],
    };
  }
  // A prompt that only OpenBot may answer (a secret, private data) or a browser
  // takeover: shown, but answered in the app.
  const what = p.kind === 'takeover' ? 'Finish a browser step in OpenBot' : 'Answer in OpenBot';
  return {
    runtimeRequests: [{ id: p.requestId, status: 'pending', kind: what, nodeId: 'openbot-only' }],
    turnItems: [{ nodeId: 'openbot-only', type: 'dynamic_tool', input: p.kind === 'takeover' ? 'The agent needs you in its browser.' : 'This question asks for something only the OpenBot app takes, such as a password.' }],
  };
}

// ---- database ----------------------------------------------------------------------

const REQUIRED = {
  projection_agents: ['agent_id', 'thread_id', 'agent_json'],
  projection_threads: ['thread_id', 'agent_id', 'title', 'active_turn_id', 'created_at', 'updated_at'],
  projection_agent_threads: ['thread_id', 'agent_id', 'title', 'error', 'archived_at', 'updated_at'],
  projection_thread_messages: ['thread_id', 'message_id', 'turn_id', 'author', 'status', 'item_type', 'created_at', 'ordinal', 'message_json', 'last_event_sequence'],
  projection_turns: ['turn_id', 'thread_id', 'status', 'started_at', 'completed_at'],
};

export function checkSchema(db) {
  for (const [table, cols] of Object.entries(REQUIRED)) {
    const have = new Set(db.prepare(`select name from pragma_table_info(?)`).all(table).map((r) => r.name));
    if (!have.size) return `OpenBot's database has no ${table} table. This bridge doesn't match your OpenBot version.`;
    const missing = cols.find((c) => !have.has(c));
    if (missing) return `OpenBot's database has no ${table}.${missing}. This bridge doesn't match your OpenBot version.`;
  }
  return null;
}

function hasTable(db, table) {
  return db.prepare(`select 1 from sqlite_master where type = 'table' and name = ?`).get(table) !== undefined;
}

// ---- the client ----------------------------------------------------------------------

export class OpenBotClient extends EventEmitter {
  constructor({ stateDir, config = {}, log = () => {}, dbFile = databaseFile(), automation = automationDir() } = {}) {
    super();
    this.stateDir = stateDir;
    this.cfg = config;
    this.log = log;
    this.dbFile = dbFile;
    this.automation = automation;
    this.db = null;
    this.q = null;
    this.state = 'disconnected';
    this.error = null;
    this.origin = null;
    this.threads = new Map();
    this.projects = new Map();
    this.agents = new Map(); // agentId -> agent record from OpenBot
    this.envs = [{ code: '', label: 'this computer', local: true }];
    this.api = { on: false, agents: new Set(), error: null, checkedAt: 0 };
    this.attention = new Map(); // agentId -> { prompts, approvals, browserTakeovers }
    this.sigs = new Map(); // threadId -> change signature
    this.dataVersion = null;
    this.loaded = false;
    this.stopped = true;
    this.local = this.loadLocal();
  }

  // ---- lifecycle ------------------------------------------------------------------

  setState(state, error = null) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.emit('state', state, error);
  }

  start() {
    this.stopped = false;
    this.tick();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    try {
      this.db?.close();
    } catch {}
    this.db = null;
  }

  async tick() {
    if (this.stopped) return;
    let delay = 1000;
    try {
      if (!this.db) await this.open();
      if (this.db) {
        const version = this.db.prepare('pragma data_version').get().data_version;
        if (version !== this.dataVersion || this.kicked) {
          this.dataVersion = version;
          this.kicked = false;
          this.reload();
        }
        await this.refreshApi();
        if (this.state !== 'connected') this.setState('connected');
      } else delay = 5000;
    } catch (err) {
      this.log(`OpenBot: ${err.message}`);
      this.setState('offline', err.message);
      try {
        this.db?.close();
      } catch {}
      this.db = null;
      delay = 5000;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  // Read again on the next tick, without waiting for the database to change.
  kick() {
    this.kicked = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), 150);
  }

  async open() {
    if (!fs.existsSync(this.dbFile)) {
      this.setState('offline', `OpenBot's database isn't at ${this.dbFile}. Is OpenBot installed?`);
      return;
    }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(this.dbFile, { readOnly: true });
    db.exec('pragma busy_timeout = 2000');
    const problem = checkSchema(db);
    if (problem) {
      db.close();
      this.setState('offline', problem);
      return;
    }
    this.db = db;
    this.origin = this.dbFile;
    this.hasReads = hasTable(db, 'projection_thread_reads');
    this.hasDeliveries = hasTable(db, 'projection_deliveries');
    this.q = {
      agents: db.prepare('select agent_id, thread_id, agent_json from projection_agents order by sort_order, agent_id'),
      threads: db.prepare(`
        select t.thread_id, t.agent_id, t.title, t.active_turn_id, t.created_at, t.updated_at,
               x.thread_id as side, x.title as side_title, x.error as side_error, x.archived_at
        from projection_threads t
        left join projection_agent_threads x on x.thread_id = t.thread_id`),
      turns: db.prepare(`
        select thread_id, turn_id, status, started_at, completed_at from (
          select thread_id, turn_id, status, started_at, completed_at,
                 row_number() over (partition by thread_id order by started_at desc) as n
          from projection_turns)
        where n = 1`),
      lastReply: db.prepare(`
        select message_json, created_at from projection_thread_messages
        where thread_id = ? and author = 'assistant' and item_type in ('agentMessage', 'final_answer') and status != 'streaming'
        order by created_at desc, ordinal desc limit 1`),
      rev: db.prepare('select max(last_event_sequence) as rev, count(*) as n from projection_thread_messages where thread_id = ?'),
      messages: db.prepare(`
        select message_id, turn_id, author, status, item_type, created_at, message_json from projection_thread_messages
        where thread_id = ? order by created_at desc, ordinal desc limit 400`),
      runs: db.prepare('select turn_id, status, started_at, completed_at from projection_turns where thread_id = ? order by started_at desc limit 5'),
      openPrompts: db.prepare(`
        select message_json from projection_thread_messages
        where thread_id = ? and turn_id = ? and item_type = 'question_prompt'
          and json_extract(message_json, '$.questionPrompt.resolution') is null`),
      readAt: this.hasReads ? db.prepare('select max(updated_at) as at from projection_thread_reads where thread_id = ?') : null,
      turnError: this.hasDeliveries ? db.prepare('select error from projection_deliveries where turn_id = ? and error is not null limit 1') : null,
    };
    this.log(`OpenBot: reading ${this.dbFile}`);
  }

  // ---- reading ----------------------------------------------------------------------

  reload() {
    const q = this.q;
    const agents = new Map();
    for (const row of q.agents.all()) {
      const a = parseJson(row.agent_json) || {};
      if (a.hiddenAt) continue;
      agents.set(row.agent_id, { ...a, id: row.agent_id, threadId: row.thread_id, name: a.name || 'Agent' });
    }
    const configChanged = JSON.stringify(this.modelSource([...agents.values()])) !== JSON.stringify(this.modelSource([...this.agents.values()]));
    this.agents = agents;

    const latest = new Map(q.turns.all().map((r) => [r.thread_id, r]));
    const rows = q.threads.all().filter((r) => agents.has(r.agent_id) && (r.side || agents.get(r.agent_id).threadId === r.thread_id));
    // Main chats always; side threads that aren't archived, newest first.
    const main = rows.filter((r) => !r.side);
    const side = rows
      .filter((r) => r.side && !r.archived_at)
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .slice(0, this.cfg.sideThreads ?? 60);

    const threads = new Map();
    for (const r of [...main, ...side]) threads.set(r.thread_id, this.buildThread(r, agents.get(r.agent_id), latest.get(r.thread_id)));
    this.matchAttention(threads);

    const projects = new Map();
    for (const a of agents.values()) projects.set(a.id, { id: a.id, title: a.name });
    const projectsChanged = JSON.stringify([...projects.values()]) !== JSON.stringify([...this.projects.values()]);

    const prev = this.threads;
    this.threads = threads;
    this.projects = projects;
    if (!this.loaded) {
      this.loaded = true;
      for (const t of threads.values()) this.sigs.set(t.id, signature(t));
      this.emit('change', { kind: 'snapshot' });
      this.emit('config');
      return;
    }
    for (const t of threads.values()) {
      const sig = signature(t);
      if (this.sigs.get(t.id) !== sig) {
        this.sigs.set(t.id, sig);
        this.emit('change', { kind: 'thread', id: t.id, prev: prev.get(t.id), thread: t });
      }
    }
    for (const id of prev.keys()) {
      if (!threads.has(id)) {
        this.sigs.delete(id);
        this.emit('change', { kind: 'removed', id });
      }
    }
    if (projectsChanged) this.emit('change', { kind: 'project' });
    if (configChanged) this.emit('config');
  }

  buildThread(r, agent, turn) {
    const q = this.q;
    const id = r.thread_id;
    const isMain = !r.side;
    const reply = q.lastReply.get(id);
    const rev = q.rev.get(id);
    const running = !!r.active_turn_id;
    const startedAt = turn?.started_at || null;
    const finishedAt = !running && turn?.completed_at ? turn.completed_at : null;
    const failed = !running && turn?.status === 'failed';
    let lastError = null;
    if (failed) lastError = (turn && q.turnError?.get(turn.turn_id)?.error) || (isMain ? null : r.side_error) || 'The run failed';
    // A side thread closed from the game stays closed here until it runs again.
    const after = (iso) => iso && (!startedAt || Date.parse(startedAt) <= Date.parse(iso));
    const closedMark = isMain ? null : this.local.closed[id];
    const openbotRead = q.readAt?.get(id)?.at || null;
    const visited = [this.local.visited[id], openbotRead].filter(Boolean).sort().at(-1) || null;
    const updatedAt = [r.updated_at, reply?.created_at, turn?.completed_at, turn?.started_at].filter(Boolean).sort().at(-1) || r.created_at;
    return {
      id,
      projectId: agent.id,
      title: isMain ? agent.name : r.side_title || r.title || 'Side thread',
      createdAt: r.created_at,
      updatedAt,
      status: running ? 'running' : turn?.status || 'idle',
      activityRunStatus: running ? 'running' : null,
      activeRunId: r.active_turn_id || null,
      activityRunStartedAt: running ? startedAt : null,
      latestRunStartedAt: startedAt,
      latestRunCompletedAt: finishedAt,
      lastVisitedAt: visited,
      lastError,
      closedAt: after(closedMark) ? closedMark : null,
      modelSelection: agentSelection(agent),
      latestVisibleMessage: reply ? { role: 'assistant', text: parseJson(reply.message_json)?.text || '' } : null,
      pendingRuntimeRequest: null,
      _main: isMain,
      _agent: agent.id,
      // Local scripts can't close a side thread in OpenBot: closing one only hides it here.
      _closeLocal: !isMain,
      _rev: rev ? `${rev.rev}:${rev.n}` : '0',
    };
  }

  // Put each agent's open prompts and approvals on the thread they belong to.
  matchAttention(threads) {
    for (const t of threads.values()) t._pending = null;
    for (const agent of this.agents.values()) {
      const mine = [...threads.values()].filter((t) => t._agent === agent.id);
      const active = mine.filter((t) => t.activeRunId);
      const home = active[0] || mine.find((t) => t._main) || mine[0];
      if (!home) continue;
      const fromApi = this.api.on && this.api.agents.has(agent.id) ? this.attention.get(agent.id) : null;
      const pending = [];
      if (fromApi) {
        for (const p of fromApi.prompts || []) {
          const where = active.find((t) => this.promptIn(t, p)) || home;
          pending.push([where, { kind: 'prompt', requestId: p.requestId, questions: p.questions, requiresOpenBot: p.requiresOpenBot }]);
        }
        for (const a of fromApi.approvals || []) {
          const where = threads.get(a.threadId) || home;
          pending.push([where, { kind: 'approval', requestId: a.requestId, approval: a }]);
        }
        for (const b of fromApi.browserTakeovers || []) pending.push([home, { kind: 'takeover', requestId: b.requestId, requiresOpenBot: true }]);
      } else {
        // Without Local scripts the game can still say a thread needs you; answering
        // needs Local scripts on for that agent.
        for (const t of active) {
          for (const row of this.q.openPrompts.all(t.id, t.activeRunId)) {
            const qp = parseJson(row.message_json)?.questionPrompt;
            if (!qp?.requestId) continue;
            pending.push([t, { kind: 'prompt', requestId: `db:${qp.requestId}`, questions: (qp.questions || []).map(({ id, header, question, options }) => ({ id, header, question, options })), requiresOpenBot: (qp.questions || []).some((x) => x.isSecret), viaDb: true }]);
          }
        }
      }
      for (const [t, p] of pending) {
        if (t._pending) continue; // one at a time per thread, like the game shows it
        t._pending = p;
        t.pendingRuntimeRequest = { kind: p.kind === 'prompt' && !p.requiresOpenBot ? 'user_input' : 'approval' };
      }
    }
  }

  promptIn(thread, prompt) {
    const ids = (prompt.questions || []).map((x) => x.id).join('\n');
    if (!ids) return false;
    return this.q.openPrompts.all(thread.id, thread.activeRunId).some((row) => {
      const qp = parseJson(row.message_json)?.questionPrompt;
      return (qp?.questions || []).map((x) => x.id).join('\n') === ids;
    });
  }

  // The Local scripts API: which agents allow it, and their open prompts and
  // approvals. Only agents that are working can be waiting on you, so only those
  // are asked.
  async refreshApi() {
    const now = Date.now();
    if (now - this.api.checkedAt > 10000) {
      this.api.checkedAt = now;
      try {
        const list = await this.request('GET', '/v1/agents');
        const ids = new Set((Array.isArray(list) ? list : []).map((a) => a.id));
        const changed = !this.api.on || [...ids].join() !== [...this.api.agents].join();
        this.api = { ...this.api, on: true, agents: ids, error: null };
        if (changed) this.kicked = true;
      } catch (err) {
        if (this.api.on) this.kicked = true;
        this.api = { ...this.api, on: false, agents: new Set(), error: err.message };
      }
    }
    if (!this.api.on) {
      if (this.attention.size) {
        this.attention.clear();
        this.kicked = true;
      }
      return;
    }
    const working = new Set([...this.threads.values()].filter((t) => t.activeRunId).map((t) => t._agent));
    for (const id of [...this.attention.keys()]) {
      if (!working.has(id)) {
        this.attention.delete(id);
        this.kicked = true;
      }
    }
    for (const id of working) {
      if (!this.api.agents.has(id)) continue;
      try {
        const p = await this.request('GET', `/v1/agents/${encodeURIComponent(id)}/pending`);
        const before = JSON.stringify(this.attention.get(id) || null);
        const next = { prompts: p.prompts || [], approvals: p.approvals || [], browserTakeovers: p.browserTakeovers || [] };
        if (JSON.stringify(next) !== before) {
          this.attention.set(id, next);
          this.kicked = true;
        }
      } catch (err) {
        this.log(`OpenBot: pending requests for ${this.agents.get(id)?.name || id}: ${err.message}`);
      }
    }
    if (this.kicked && this.db) {
      this.kicked = false;
      this.reload();
    }
  }

  // ---- the shapes the bridge reads --------------------------------------------------

  get config() {
    const providers = [...new Set([...this.agents.values()].map((a) => a.provider).filter(Boolean))].map((id) => ({ instanceId: id, displayName: providerName(id), enabled: true }));
    return { providers, environment: { label: undefined, serverVersion: undefined } };
  }

  modelSource(agents) {
    return agents.map((a) => [a.provider, a.model]);
  }

  modelGroups() {
    return [{ code: '', choices: modelChoices([...this.agents.values()], this.cfg.models) }];
  }

  environments() {
    return [{ code: '', label: 'this computer', local: true, state: this.state, error: this.error || undefined, threads: this.threads.size }];
  }

  apiStatus() {
    return {
      on: this.api.on,
      error: this.api.error || undefined,
      agents: [...this.agents.values()].map((a) => ({ name: a.name, localScripts: this.api.agents.has(a.id) })),
    };
  }

  defaultModelFor(agentId) {
    return agentSelection(this.agents.get(agentId));
  }

  async threadProjection(threadId) {
    if (!this.db) throw new Error('not reading OpenBot yet');
    const t = this.threads.get(threadId);
    const rows = this.q.messages.all(threadId).reverse();
    const name = (id) => this.agents.get(id)?.name || 'another agent';
    const messages = rows.map((r) => toMessage(r, name)).filter(Boolean);
    const runs = this.q.runs
      .all(threadId)
      .reverse()
      .map((r) => ({ id: r.turn_id, status: r.status, startedAt: r.started_at, completedAt: r.completed_at || null }));
    return {
      messages,
      runs,
      activity: t?.activeRunId ? activityFrom(rows, t.activeRunId) : null,
      ...pendingParts(t?._pending),
    };
  }

  // ---- writing ----------------------------------------------------------------------

  connection() {
    let url;
    let token;
    try {
      url = fs.readFileSync(path.join(this.automation, 'url'), 'utf8').trim();
      token = fs.readFileSync(path.join(this.automation, 'token'), 'utf8').trim();
    } catch {
      throw new Error("OpenBot isn't running, or no agent has Local scripts on. Turn on Local scripts in the agent's settings in OpenBot.");
    }
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error(`OpenBot's Local scripts address looks wrong (${url}).`);
    return { url, token };
  }

  async request(method, pathname, body, { agentName } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { url, token } = this.connection();
      let res;
      try {
        res = await fetch(url + pathname, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        if (attempt === 0) continue; // OpenBot may have just restarted on a new port
        throw new Error("OpenBot doesn't answer. Is it running?");
      }
      const text = await res.text();
      const value = text ? parseJson(text) : null;
      if (res.ok) return value;
      if (res.status === 401 && attempt === 0) continue; // a new token after a restart
      if (res.status === 403) throw new Error(`Turn on Local scripts for ${agentName || 'this agent'} in OpenBot (the agent's settings), then try again.`);
      throw new Error((value && typeof value.error === 'string' && value.error) || `OpenBot answered HTTP ${res.status}`);
    }
    throw new Error("OpenBot doesn't answer. Is it running?");
  }

  agentFor(threadId) {
    const t = this.threads.get(threadId);
    if (!t) throw new Error('That thread is gone.');
    return { t, agent: this.agents.get(t._agent) };
  }

  async postMessage(agent, text) {
    const res = await this.request('POST', `/v1/agents/${encodeURIComponent(agent.id)}/messages`, { text, clientMessageId: `wow-${randomUUID()}` }, { agentName: agent.name });
    this.kick();
    return res;
  }

  withAttachments(text, attachments = []) {
    const files = attachments.filter((a) => a?.path).map((a) => `Screenshot from World of Warcraft: ${a.path}`);
    return files.length ? `${text}\n\n${files.join('\n')}` : text;
  }

  // The game's "send" in a thread. Local scripts can only reach an agent's main chat,
  // so a side thread says where to reply instead of sending somewhere unexpected.
  async sendMessage(threadId, text, _mode, attachments = []) {
    const { t, agent } = this.agentFor(threadId);
    if (!t._main) throw new Error(`Replies in side threads aren't available from the game yet. Message ${agent.name} from its main chat.`);
    return this.postMessage(agent, this.withAttachments(text, attachments));
  }

  // The game's "new thread": a message to the agent's main chat, after switching its
  // model when one was picked.
  async launchThread(agentId, text, attachments = [], opts = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('That agent is gone.');
    if (opts.model || opts.effort) await this.updateAgentModel(agent, opts.model?.instanceId, opts.model?.model, opts.effort);
    await this.postMessage(agent, this.withAttachments(text, attachments));
    return { threadId: agent.threadId };
  }

  async uploadImage(_key, data, name, mimeType) {
    const dir = this.cfg.screenshotDir || defaultScreenshotDir(this.stateDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ext = /jpe?g/.test(mimeType || '') ? 'jpg' : 'png';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `wow-${stamp}-${randomUUID().slice(0, 6)}.${ext}`);
    fs.writeFileSync(file, data, { mode: 0o600 });
    return { type: 'path', path: file, name, mimeType, sizeBytes: data.length };
  }

  interrupt() {
    throw new Error("Stopping a run isn't available from the game yet. Stop it in OpenBot.");
  }

  async respondApproval(threadId, requestId, decision) {
    const { t, agent } = this.agentFor(threadId);
    if (t._pending?.requiresOpenBot) throw new Error('Answer this one in OpenBot.');
    const value = String(decision || '').startsWith('accept') ? 'accept' : 'decline';
    await this.request('POST', `/v1/agents/${encodeURIComponent(agent.id)}/approvals/${encodeURIComponent(requestId)}/respond`, { decision: value }, { agentName: agent.name });
    this.attention.delete(agent.id);
    this.kick();
  }

  async respondAnswers(threadId, requestId, answers) {
    const { t, agent } = this.agentFor(threadId);
    if (String(requestId).startsWith('db:') || t._pending?.viaDb) {
      throw new Error(`Turn on Local scripts for ${agent.name} in OpenBot (the agent's settings) to answer from the game.`);
    }
    const body = {};
    for (const [k, v] of Object.entries(answers || {})) body[k] = [].concat(v).map(String);
    await this.request('POST', `/v1/agents/${encodeURIComponent(agent.id)}/prompts/${encodeURIComponent(requestId)}/answer`, { answers: body }, { agentName: agent.name });
    this.attention.delete(agent.id);
    this.kick();
  }

  // OpenBot keeps one model per agent, so this changes the agent, not just the thread.
  async setModel(threadId, provider, model, effort) {
    const { agent } = this.agentFor(threadId);
    await this.updateAgentModel(agent, provider, model, effort);
  }

  async updateAgentModel(agent, provider, model, effort) {
    const body = {};
    if (provider && model) {
      body.provider = provider;
      body.model = model;
    }
    if (effort) body.reasoningEffort = effort;
    if (!Object.keys(body).length) return;
    await this.request('POST', `/v1/agents/${encodeURIComponent(agent.id)}/settings`, body, { agentName: agent.name });
    this.kick();
  }

  // Without a sign-in the bridge reaches OpenBot through Local scripts, which can't close a side
  // thread. Closing one here only hides it in the game, until it runs again or is reopened.
  // An agent's main chat is its permanent conversation: it can't be closed.
  close(threadId) {
    if (this.threads.get(threadId)?._main) throw new Error("An agent's main chat can't be closed.");
    return this.mark('closed', threadId, true);
  }

  reopen(threadId) {
    if (this.threads.get(threadId)?._main) throw new Error("An agent's main chat can't be closed.");
    return this.mark('closed', threadId, false);
  }

  visit(threadId) {
    return this.mark('visited', threadId, true);
  }

  mark(kind, threadId, on) {
    if (!this.threads.has(threadId)) throw new Error('That thread is gone.');
    if (on) this.local[kind][threadId] = new Date().toISOString();
    else delete this.local[kind][threadId];
    this.saveLocal();
    this.kick();
  }

  localFile() {
    return this.stateDir ? path.join(this.stateDir, 'threads.json') : null;
  }

  loadLocal() {
    // Settled and archived marks from earlier versions are left out: OpenBot has no such states.
    const empty = { closed: {}, visited: {} };
    try {
      const data = JSON.parse(fs.readFileSync(this.localFile(), 'utf8'));
      return { closed: data.closed || {}, visited: data.visited || {} };
    } catch {
      return empty;
    }
  }

  saveLocal() {
    const file = this.localFile();
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(this.local));
    fs.renameSync(file + '.tmp', file);
  }
}

// What makes a thread worth a change event: the bridge refreshes its view and may
// announce it.
function signature(t) {
  return JSON.stringify([t.title, t.status, t.activeRunId, t.latestRunCompletedAt, t.lastError, t.closedAt, t.lastVisitedAt, t._rev, t._pending?.requestId, t.modelSelection]);
}
