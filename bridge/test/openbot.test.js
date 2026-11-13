import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OpenBotClient, threadStatus, isUnread, toMessage, activityFrom, checkSchema, modelChoices } from '../src/openbot.js';
import { pendingRequest, activityLabel } from '../src/bridge.js';

// A database with the tables and columns the bridge reads, filled with two agents:
// "Ada" (main chat, plus a side thread that is working) and "Bo" (main chat only).
function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obwow-db-'));
  const file = path.join(dir, 'openbot.db');
  const db = new DatabaseSync(file);
  db.exec(`
    pragma journal_mode = wal;
    create table projection_agents (agent_id text primary key, thread_id text, model text, updated_at text, sort_order integer, agent_json text, last_event_sequence integer);
    create table projection_threads (thread_id text primary key, agent_id text, title text, active_turn_id text, created_at text, updated_at text, last_event_sequence integer);
    create table projection_agent_threads (thread_id text primary key, agent_id text, legacy_task_id text, origin text, title text, title_source text, outcome text, error text, created_at text, updated_at text, archived_at text, last_event_sequence integer, routine_id text);
    create table projection_thread_messages (thread_id text, message_id text, turn_id text, author text, status text, item_type text, created_at text, ordinal integer, message_json text, last_event_sequence integer, primary key (thread_id, message_id));
    create table projection_turns (turn_id text primary key, thread_id text, provider_session_id text, status text, started_at text, completed_at text, last_event_sequence integer);
    create table projection_deliveries (delivery_id text primary key, message_id text, recipient_agent_id text, status text, turn_id text, error text, created_at text, delivery_json text, last_event_sequence integer);
  `);
  const agent = (id, thread, name, order) =>
    db.prepare('insert into projection_agents values (?, ?, ?, ?, ?, ?, ?)').run(id, thread, 'm', 't', order, JSON.stringify({ id, name, provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', threadId: thread }), 1);
  agent('ada', 'ada-main', 'Ada', 1);
  agent('bo', 'bo-main', 'Bo', 2);
  const thread = (id, agentId, title, active, updated) => db.prepare('insert into projection_threads values (?, ?, ?, ?, ?, ?, ?)').run(id, agentId, title, active, '2026-11-01T00:00:00.000Z', updated, 1);
  thread('ada-main', 'ada', 'Main', null, '2026-11-10T00:00:00.000Z');
  thread('bo-main', 'bo', 'Main', null, '2026-11-09T00:00:00.000Z');
  thread('ada-side', 'ada', 'ignored', 'turn-3', '2026-11-11T00:00:00.000Z');
  db.prepare('insert into projection_agent_threads (thread_id, agent_id, origin, title, created_at, updated_at) values (?, ?, ?, ?, ?, ?)').run('ada-side', 'ada', 'user', 'Fix | the build', '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z');
  const turn = (id, thread, status, start, end) => db.prepare('insert into projection_turns values (?, ?, ?, ?, ?, ?, ?)').run(id, thread, 'p', status, start, end, 1);
  turn('turn-1', 'ada-main', 'completed', '2026-11-10T00:00:00.000Z', '2026-11-10T00:01:00.000Z');
  turn('turn-2', 'bo-main', 'failed', '2026-11-09T00:00:00.000Z', '2026-11-09T00:01:00.000Z');
  turn('turn-3', 'ada-side', 'running', '2026-11-11T00:00:00.000Z', null);
  db.prepare('insert into projection_deliveries (delivery_id, status, turn_id, error) values (?, ?, ?, ?)').run('d2', 'failed', 'turn-2', 'The provider refused');
  let n = 0;
  const msg = (thread, turnId, author, itemType, text, status = 'completed', extra = {}) =>
    db.prepare('insert into projection_thread_messages values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(thread, `m${++n}`, turnId, author, status, itemType, `2026-11-1${thread === 'ada-side' ? 1 : 0}T00:00:${String(n).padStart(2, '0')}.000Z`, n, JSON.stringify({ text, ...extra }), n);
  msg('ada-main', 'turn-1', 'user', '', 'hello');
  msg('ada-main', 'turn-1', 'assistant', 'commentary', 'thinking out loud');
  msg('ada-main', 'turn-1', 'assistant', 'agentMessage', 'Hi! Done.');
  msg('ada-main', 'turn-1', 'system', 'context-reset', 'New chat');
  msg('ada-main', 'turn-1', 'agent', 'agent-exchange', 'Ping from Bo', 'completed', { senderAgentId: 'bo' });
  msg('ada-side', 'turn-3', 'user', '', 'fix it');
  msg('ada-side', 'turn-3', 'assistant', 'agentMessage', "I'll read the **build log** first.\nThen more.");
  msg('ada-side', 'turn-3', 'assistant', 'question_prompt', 'Which branch?', 'completed', {
    questionPrompt: { requestId: 'req-1', questions: [{ id: 'q1', header: 'Branch', question: 'Which branch?', isSecret: false, options: [{ label: 'main', description: '' }, { label: 'dev', description: 'the dev one' }] }], resolution: null },
  });
  return { dir, file, db };
}

function client(file, extra = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obwow-state-'));
  const automation = fs.mkdtempSync(path.join(os.tmpdir(), 'obwow-auto-'));
  return new OpenBotClient({ stateDir, dbFile: file, automation, ...extra });
}

test('the schema check names what is missing', () => {
  const { db } = makeDb();
  assert.equal(checkSchema(db), null);
  db.exec('drop table projection_turns');
  assert.match(checkSchema(db), /no projection_turns table/);
});

test('agents become projects; main chats and side threads become threads', async () => {
  const { file } = makeDb();
  const c = client(file);
  await c.open();
  c.reload();
  assert.deepEqual([...c.projects.values()].map((p) => p.title), ['Ada', 'Bo']);
  const main = c.threads.get('ada-main');
  assert.equal(main.title, 'Ada', 'a main chat is named after its agent');
  assert.equal(main.projectId, 'ada');
  assert.equal(threadStatus(main), 'open');
  assert.equal(isUnread(main), true);
  assert.equal(main.latestVisibleMessage.text, 'Hi! Done.');
  assert.deepEqual(main.modelSelection, { instanceId: 'claude', model: 'claude-opus-5-5', options: [{ id: 'reasoningEffort', value: 'high' }] });
  const bo = c.threads.get('bo-main');
  assert.equal(threadStatus(bo), 'failed');
  assert.equal(bo.lastError, 'The provider refused');
  const side = c.threads.get('ada-side');
  assert.equal(side.title, 'Fix | the build');
  assert.equal(threadStatus(side), 'input', 'an open question in the running turn needs you');
  c.stop();
});

test('a thread view shows replies, not progress notes or system rows', async () => {
  const { file } = makeDb();
  const c = client(file);
  await c.open();
  c.reload();
  const p = await c.threadProjection('ada-main');
  assert.deepEqual(p.messages.map((m) => [m.role, m.text]), [
    ['user', 'hello'],
    ['assistant', 'Hi! Done.'],
    ['user', '**From Bo:** Ping from Bo'],
  ]);
  assert.equal(activityLabel(p), null, 'nothing running');
  const side = await c.threadProjection('ada-side');
  assert.equal(activityLabel(side), "I'll read the build log first.");
  const pending = pendingRequest(side);
  assert.equal(pending.kind, 'question');
  assert.equal(pending.id, 'db:req-1');
  assert.deepEqual(pending.questions[0].opts.map((o) => o.v), ['main', 'dev']);
  c.stop();
});

test('activity is the newest note of the running turn', () => {
  const rows = [
    { turn_id: 't1', author: 'assistant', item_type: 'agentMessage', message_json: JSON.stringify({ text: 'old run' }) },
    { turn_id: 't2', author: 'assistant', item_type: 'commentary', message_json: JSON.stringify({ text: '# Checking `the tests` now and then a very long tail that goes on and on and on' }) },
  ];
  assert.equal(activityFrom(rows, 't2'), 'Checking the tests now and then a very long tail that goes…');
  assert.equal(activityFrom(rows, 't3'), 'Working');
  assert.equal(activityFrom(rows, null), null);
  assert.equal(toMessage({ author: 'assistant', item_type: 'commentary', message_json: '{"text":"x"}' }), null);
});

test('a main chat can\'t be closed; a side thread closes in the game only, until it runs again', async () => {
  const { file, db } = makeDb();
  // An earlier version's settle and archive marks are ignored.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obwow-state-'));
  fs.writeFileSync(path.join(stateDir, 'threads.json'), JSON.stringify({ settled: { 'ada-main': '2099-01-01T00:00:00.000Z' }, archived: { 'bo-main': '2099-01-01T00:00:00.000Z' }, visited: {} }));
  const c = client(file, { stateDir });
  await c.open();
  c.reload();
  assert.equal(threadStatus(c.threads.get('ada-main')), 'open', 'an old settle mark is ignored');
  assert.equal(threadStatus(c.threads.get('bo-main')), 'failed', 'an old archive mark is ignored');
  assert.throws(() => c.close('ada-main'), /main chat can't be closed/);
  // Ada's side thread finishes its run.
  db.prepare("update projection_threads set active_turn_id = null where thread_id = 'ada-side'").run();
  db.prepare("update projection_turns set status = 'completed', completed_at = ? where turn_id = 'turn-3'").run('2026-11-11T00:05:00.000Z');
  c.reload();
  assert.equal(c.threads.get('ada-side')._closeLocal, true, 'Local scripts can\'t close it in OpenBot');
  c.close('ada-side');
  c.reload();
  assert.equal(threadStatus(c.threads.get('ada-side')), 'closed');
  c.reopen('ada-side');
  c.reload();
  assert.equal(threadStatus(c.threads.get('ada-side')), 'open');
  c.close('ada-side');
  const later = new Date(Date.now() + 60000).toISOString();
  db.prepare('insert into projection_turns values (?, ?, ?, ?, ?, ?, ?)').run('turn-9', 'ada-side', 'p', 'completed', later, later, 2);
  c.reload();
  assert.equal(threadStatus(c.threads.get('ada-side')), 'open', 'it ran again');
  c.visit('ada-main');
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'threads.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['closed', 'visited'], 'no settle or archive marks are written');
  assert.ok(saved.closed['ada-side']);
  c.stop();
});

test('the model list has configured models first and no duplicates', () => {
  const list = modelChoices([{ provider: 'claude', model: 'a' }, { provider: 'claude', model: 'a' }], [{ provider: 'codex', model: 'b', efforts: [] }]);
  assert.deepEqual(list.map((m) => [m.instanceId, m.model, !!m.effort]), [['codex', 'b', false], ['claude', 'a', true]]);
});

// A stand-in for OpenBot's Local scripts API, on loopback with a token file.
async function fakeApi(c, { allowed = ['ada'], pending = {} } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/v1/agents') return send(200, allowed.map((id) => ({ id, name: id, routines: [] })));
      const m = /^\/v1\/agents\/([^/]+)\/(.+)$/.exec(req.url);
      if (!m) return send(404, { error: 'not found' });
      if (!allowed.includes(m[1])) return send(403, { error: 'Local scripts are off for this agent.' });
      if (m[2] === 'pending') return send(200, pending[m[1]] || { prompts: [], approvals: [], browserTakeovers: [] });
      if (m[2] === 'messages') return send(202, { messageId: 'x', deliveries: [{ id: 'd', recipientAgentId: m[1], status: 'queued' }] });
      return send(200, { ok: true });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(c.automation, 'url'), `http://127.0.0.1:${server.address().port}`);
  fs.writeFileSync(path.join(c.automation, 'token'), 'secret-token\n');
  return { seen, close: () => server.close() };
}

test('messages go to an agent main chat through Local scripts', async () => {
  const { file } = makeDb();
  const c = client(file);
  await c.open();
  c.reload();
  const api = await fakeApi(c);
  await c.sendMessage('ada-main', 'hi there', 'steer', [{ type: 'path', path: '/tmp/shot.png' }]);
  const post = api.seen.find((r) => r.method === 'POST');
  assert.equal(post.url, '/v1/agents/ada/messages');
  assert.equal(post.auth, 'Bearer secret-token');
  assert.equal(post.body.text, 'hi there\n\nScreenshot from World of Warcraft: /tmp/shot.png');
  assert.match(post.body.clientMessageId, /^wow-/);
  await assert.rejects(c.sendMessage('ada-side', 'x'), /side threads aren't available.*Message Ada from its main chat/);
  await assert.rejects(c.sendMessage('bo-main', 'x'), /Turn on Local scripts for Bo/);
  const res = await c.launchThread('ada', 'new task', [], { model: { instanceId: 'claude', model: 'claude-x' }, effort: 'max' });
  assert.deepEqual(res, { threadId: 'ada-main' });
  const settings = api.seen.find((r) => r.url === '/v1/agents/ada/settings');
  assert.deepEqual(settings.body, { provider: 'claude', model: 'claude-x', reasoningEffort: 'max' });
  await assert.rejects(Promise.resolve().then(() => c.interrupt('ada-side')), /Stop it in OpenBot/);
  api.close();
  c.stop();
});

test('without Local scripts files, sending says what to turn on', async () => {
  const { file } = makeDb();
  const c = client(file);
  await c.open();
  c.reload();
  await assert.rejects(c.sendMessage('ada-main', 'x'), /no agent has Local scripts on/);
  c.stop();
});

test('prompts and approvals from Local scripts land on the thread and can be answered', async () => {
  const { file } = makeDb();
  const c = client(file);
  await c.open();
  c.reload();
  const api = await fakeApi(c, {
    pending: {
      ada: {
        prompts: [{ requestId: 'h-1', questions: [{ id: 'q1', header: 'Branch', question: 'Which branch?', options: [{ label: 'main' }] }], requiresOpenBot: false }],
        approvals: [],
        browserTakeovers: [],
      },
    },
  });
  await c.refreshApi();
  const side = c.threads.get('ada-side');
  assert.equal(side._pending.requestId, 'h-1', 'matched to the thread whose prompt has the same questions');
  const p = pendingRequest(await c.threadProjection('ada-side'));
  assert.equal(p.id, 'h-1');
  await c.respondAnswers('ada-side', 'h-1', { q1: 'main' });
  const answer = api.seen.find((r) => r.url === '/v1/agents/ada/prompts/h-1/answer');
  assert.deepEqual(answer.body, { answers: { q1: ['main'] } });

  await c.respondApproval('ada-side', 'a-1', 'acceptForSession');
  assert.deepEqual(api.seen.find((r) => r.url === '/v1/agents/ada/approvals/a-1/respond').body, { decision: 'accept' });
  await c.respondApproval('ada-side', 'a-2', 'decline');
  assert.deepEqual(api.seen.find((r) => r.url === '/v1/agents/ada/approvals/a-2/respond').body, { decision: 'decline' });
  api.close();
  c.stop();
});

test('an approval shows what it asks for', async () => {
  const { file } = makeDb();
  const c = client(file);
  await c.open();
  c.reload();
  const api = await fakeApi(c, {
    pending: { ada: { prompts: [], approvals: [{ requestId: 'a-1', threadId: 'ada-side', kind: 'command', command: 'rm -rf build', cwd: '/repo', reason: null }], browserTakeovers: [] } },
  });
  await c.refreshApi();
  const p = pendingRequest(await c.threadProjection('ada-side'));
  assert.equal(p.kind, 'approval');
  assert.equal(p.what, 'Run a command');
  assert.equal(p.detail, 'rm -rf build\nin /repo');
  api.close();
  c.stop();
});

test('screenshots are saved as files the agent can open', async () => {
  const { file } = makeDb();
  const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'obwow-shots-'));
  const c = client(file, { config: { screenshotDir: shots } });
  const a = await c.uploadImage('t', Buffer.from('png-bytes'), 's.png', 'image/png');
  assert.equal(a.type, 'path');
  assert.ok(a.path.startsWith(shots) && a.path.endsWith('.png'));
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'png-bytes');
  assert.equal(fs.statSync(a.path).mode & 0o777, 0o600);
});

test('the client notices new messages and reports thread changes', async () => {
  const { file, db } = makeDb();
  const c = client(file);
  const events = [];
  c.on('change', (e) => events.push(e.kind === 'thread' ? `thread:${e.id}` : e.kind));
  await c.open();
  c.reload();
  assert.deepEqual(events, ['snapshot']);
  db.prepare('insert into projection_thread_messages values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('bo-main', 'm99', 'turn-2', 'assistant', 'completed', 'agentMessage', '2026-11-12T00:00:00.000Z', 99, '{"text":"new"}', 99);
  c.reload();
  assert.deepEqual(events, ['snapshot', 'thread:bo-main']);
  c.stop();
});
