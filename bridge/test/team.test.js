// The client for other OpenBot servers (dist/team.mjs), against a fake peer that answers like
// an OpenBot host on protocol 9. Skipped when the bundle isn't built (npm run build:team).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pendingRequest, activityLabel, Bridge } from '../src/bridge.js';
import { Fleet } from '../src/fleet.js';
import { threadStatus, isUnread } from '../src/openbot.js';
import { SlotBank } from '../src/slots.js';

const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/team.mjs');
const built = fs.existsSync(bundle);
const team = built ? await import(bundle) : null;
const skip = !built && 'dist/team.mjs is not built';

const CAPS = ['agent-tasks-v1', 'agent-thread-replies-v1', 'agent-thread-files-v1', 'agent-thread-reads-v1', 'message-client-id-v1', 'conversation-pagination'];

// A host with two agents: Ada (working on her main chat, one side thread) and Bo (idle, unread).
function fakeHost({ channels = false } = {}) {
  const calls = [];
  const state = {
    channels: [
      { id: 'ch-web', name: 'Website', title: '', instructions: '', members: [{ agentId: 'ada' }, { agentId: 'bo' }], leadAgentId: null, archived: false, revision: 4, createdAt: '2026-11-10T00:00:00.000Z', unreadCount: 2, activeTasks: 1, lastMessage: { authorName: 'Ada', text: 'Placeholder is live', at: '2026-11-12T15:34:00.000Z' } },
      { id: 'ch-old', name: 'Old', title: '', instructions: '', members: [], leadAgentId: null, archived: true, revision: 1, createdAt: '2026-10-01T00:00:00.000Z', unreadCount: 0, activeTasks: 0, lastMessage: null },
    ],
    channelPages: {
      'ch-web': {
        throughSequence: 7,
        olderCursor: null,
        tasks: [
          { id: 'task-root', parentTaskId: null, ownerAgentId: 'ada', instruction: 'Ship the landing page\nwith copy', state: 'running' },
          { id: 'task-sub', parentTaskId: 'task-root', ownerAgentId: 'bo', instruction: 'Write copy', state: 'running' },
          { id: 'task-done', parentTaskId: null, ownerAgentId: 'bo', instruction: 'Old', state: 'completed' },
        ],
        messages: [
          { id: 'cm3', channelId: 'ch-web', sequence: 3, author: { kind: 'agent', id: 'ada', name: 'Ada' }, taskId: null, superseded: false, message: { id: 'x3', author: 'assistant', text: 'On it.', createdAt: '2026-11-12T15:01:00.000Z', status: 'completed' } },
          { id: 'cm1', channelId: 'ch-web', sequence: 1, author: { kind: 'member', id: 'member-me', name: 'Jake' }, taskId: null, superseded: false, message: { id: 'x1', author: 'user', text: 'Build the site', createdAt: '2026-11-12T15:00:00.000Z', status: 'completed' } },
          { id: 'cm2', channelId: 'ch-web', sequence: 2, author: { kind: 'member', id: 'member-sam', name: 'Sam' }, taskId: null, superseded: false, message: { id: 'x2', author: 'user', text: 'And a blog', createdAt: '2026-11-12T15:00:30.000Z', status: 'completed' } },
          { id: 'cm4', channelId: 'ch-web', sequence: 4, author: { kind: 'coordinator', id: 'coord', name: 'Coordinator' }, taskId: null, superseded: true, message: { id: 'x4', author: 'assistant', text: 'Old plan', createdAt: '2026-11-12T15:02:00.000Z', status: 'completed' } },
          { id: 'cm5', channelId: 'ch-web', sequence: 5, author: { kind: 'agent', id: 'bo', name: 'Bo' }, taskId: 'task-sub', superseded: false, message: { id: 'x5', author: 'assistant', itemType: 'commentary', text: 'thinking', createdAt: '2026-11-12T15:03:00.000Z', status: 'completed' } },
          { id: 'cm6', channelId: 'ch-web', sequence: 6, author: { kind: 'agent', id: 'bo', name: 'Bo' }, taskId: 'task-sub', superseded: false, message: { id: 'x6', author: 'assistant', text: 'Copy is', createdAt: '2026-11-12T15:04:00.000Z', status: 'streaming' } },
        ],
      },
    },
    agents: [
      { id: 'ada', name: 'Ada', provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', threadId: 'th-ada' },
      { id: 'bo', name: 'Bo', provider: 'codex', model: 'gpt-x', reasoningEffort: 'medium', threadId: 'th-bo' },
    ],
    pages: {
      ada: {
        agentId: 'ada', threadId: 'th-ada', activeTurnId: 'turn-a', revision: 3, pageInfo: { hasOlder: false, olderCursor: null },
        messages: [
          { id: 'm1', author: 'user', text: 'fix it', createdAt: '2026-11-12T10:00:00.000Z', status: 'completed', turnId: 'turn-a' },
          { id: 'm2', author: 'assistant', itemType: 'commentary', text: 'Reading the **log**', createdAt: '2026-11-12T10:00:05.000Z', status: 'completed', turnId: 'turn-a' },
          { id: 'm3', author: 'assistant', text: 'Half', createdAt: '2026-11-12T10:00:06.000Z', status: 'streaming', turnId: 'turn-a' },
        ],
      },
      bo: {
        agentId: 'bo', threadId: 'th-bo', activeTurnId: null, revision: 9, pageInfo: { hasOlder: true, olderCursor: 'c' },
        messages: [
          { id: 'b1', author: 'user', text: 'hello', createdAt: '2026-11-11T09:00:00.000Z', status: 'completed', turnId: 'turn-b' },
          { id: 'b2', author: 'assistant', text: 'Done. Here it is.', createdAt: '2026-11-11T09:01:00.000Z', status: 'completed', turnId: 'turn-b' },
          { id: 'b3', author: 'agent', senderAgentId: 'ada', text: 'ping', createdAt: '2026-11-11T09:02:00.000Z', status: 'completed' },
        ],
      },
    },
    reads: { ada: { unreadCount: 0 }, bo: { unreadCount: 2 } },
    tasks: {
      ada: [
        { id: 'task-1', agentId: 'ada', threadId: 'th-task-1', title: 'Fix | the build', state: 'idle', outcome: 'completed', activeTurnId: null, error: null, progress: null, createdAt: '2026-11-12T08:00:00.000Z', updatedAt: '2026-11-12T08:30:00.000Z' },
        { id: 'task-2', agentId: 'ada', threadId: 'th-task-2', title: 'Old', state: 'closed', outcome: 'completed', activeTurnId: null, error: null, progress: null, createdAt: '2026-11-01T08:00:00.000Z', updatedAt: '2026-11-01T08:30:00.000Z' },
      ],
      bo: [],
    },
  };
  const answer = (cmd) => {
    const { method, path: p, body } = cmd;
    const ok = (b, status = 200) => ({ commandId: cmd.id, ok: true, status, body: b });
    if (p === '/v1/compatibility') return ok({ appVersion: '0.69.0', protocol: { minimum: 1, maximum: 9 }, capabilities: channels ? [...CAPS, 'channel-chats-v1'] : CAPS });
    if (p === '/v1/me') return ok({ id: 'member-me', username: 'jake', email: null, name: 'Jake', avatarUrl: null, role: 'owner', createdAt: '2026-01-01T00:00:00.000Z', disabled: false });
    if (p === '/v1/channels') return ok(state.channels);
    if (p === '/v1/channels/read') return ok(state.channelPages[body.channelId]);
    if (p === '/v1/channels/commands') {
      const ch = state.channels.find((c) => c.id === body.channelId);
      if (body.type === 'read') ch.unreadCount = 0;
      return ok(ch);
    }
    if (p === '/v1/agents' && method === 'GET') return ok(state.agents);
    if (p === '/v1/agents/models') return ok([{ provider: 'claude', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', description: '', defaultReasoningEffort: 'high', supportedReasoningEfforts: ['low', 'high', 'max'] }]);
    if (p === '/v1/agents/conversation-reads') return ok(state.reads);
    let m = /^\/v1\/agents\/([^/]+)\/conversation-page\?limit=(\d+)$/.exec(p);
    if (m) return ok(state.pages[m[1]]);
    if (p === '/v1/agent-tasks/list') return ok({ agentId: body.agentId, tasks: state.tasks[body.agentId] || [], limit: 4 });
    if (p === '/v1/agent-tasks/read') return ok({ agentId: body.agentId, threadId: 'th-task-1', activeTurnId: null, revision: 1, messages: [{ id: 'x1', author: 'assistant', text: 'Task reply', createdAt: '2026-11-12T08:30:00.000Z', status: 'completed' }] });
    if (p.startsWith('/v1/attachments?')) return ok({ id: 'draft-1' });
    m = /^\/v1\/agents\/([^/]+)\/messages$/.exec(p);
    if (m) return ok({ messageId: 'new-msg', deliveries: [{ id: 'del-1', recipientAgentId: m[1], status: 'queued', position: 1 }] }, 202);
    if (p === '/v1/agent-tasks/close' || p === '/v1/agent-tasks/reopen') {
      const task = (state.tasks[body.agentId] || []).find((t) => t.id === body.taskId);
      if (!task) return ok({ error: 'not found' }, 404);
      if (p.endsWith('/close')) Object.assign(task, { state: 'closed', closedAt: new Date().toISOString() });
      else Object.assign(task, { state: 'idle', closedAt: null });
      return ok({}, 204);
    }
    if (/\/queue\/steer$/.test(p) || /\/interrupt$/.test(p) || p.startsWith('/v1/prompts/') || p.startsWith('/v1/approvals/') || p.startsWith('/v1/agent-tasks/stop') || p.endsWith('/conversation/read')) return ok({}, 204);
    // As the real host: a reply must quote a message, so a null replyToMessageId is refused.
    if (p === '/v1/agent-threads/send-reply') return typeof body.replyToMessageId === 'string' ? ok({ messageId: 'r', deliveries: [] }) : ok({ error: 'Invalid admin identifier.' }, 400);
    if (p === '/v1/agent-tasks/send' || p === '/v1/agent-threads/send-with-files') return ok({ messageId: 'r', deliveries: [] });
    if (p === '/v1/agent-threads/reads') return ok({ reads: body.agentId === 'ada' ? [{ taskId: 'task-1', unreadCount: state.taskUnread ?? 1, firstUnreadMessageId: 'x1', throughMessageId: null }] : [] });
    if (p === '/v1/agent-threads/read') return ok({ unreadCount: 0, firstUnreadMessageId: null, throughMessageId: body.throughMessageId });
    m = /^\/v1\/agents\/([^/]+)$/.exec(p);
    if (m && method === 'PATCH') {
      const a = state.agents.find((x) => x.id === m[1]);
      Object.assign(a, body);
      return ok({ ...a });
    }
    return ok({ error: `no route ${method} ${p}` }, 404);
  };
  let actions;
  const peer = {
    execute: async (cmd) => {
      calls.push(cmd);
      if (cmd.type === 'connect') return { commandId: cmd.id, ok: true };
      return answer(cmd);
    },
    dispose: async () => {},
  };
  const createPeer = (a) => {
    actions = a;
    return peer;
  };
  return { state, calls, createPeer, event: (e) => actions.current.onTeamEvent('host-1', e), update: (u) => actions.current.onConnectionUpdate({ hostId: 'host-1', message: null, ...u }) };
}

async function connected(fake, extra = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obwow-team-'));
  const host = { hostId: 'host-1', name: 'Homelab', role: 'owner', devicePublicKey: 'key', membershipId: 'm' };
  const client = team.createHostClient({ directory: {}, host, stateDir, createPeer: fake.createPeer, ...extra });
  const ready = new Promise((resolve) => client.once('change', resolve));
  client.start();
  await ready;
  return client;
}

const posted = (fake, p) => fake.calls.filter((c) => c.path === p).map((c) => c.body);
const tick = (ms = 350) => new Promise((r) => setTimeout(r, ms));

test('a server connects and shows its agents, main chats and open side threads', { skip }, async () => {
  const fake = fakeHost();
  const c = await connected(fake);
  assert.equal(c.state, 'connected');
  assert.deepEqual([...c.projects.values()].map((p) => p.title), ['Ada', 'Bo']);
  assert.deepEqual([...c.threads.keys()], ['a:ada', 't:task-1', 'a:bo'], 'closed side threads stay out');
  const ada = c.threads.get('a:ada');
  assert.equal(threadStatus(ada), 'working');
  assert.equal(ada.activityRunStartedAt, '2026-11-12T10:00:00.000Z');
  assert.equal(ada._canStop, true);
  const bo = c.threads.get('a:bo');
  assert.equal(threadStatus(bo), 'open');
  assert.equal(isUnread(bo), true, 'OpenBot says two unread');
  assert.equal(bo.latestVisibleMessage.text, 'Done. Here it is.');
  assert.equal(c.threads.get('t:task-1').title, 'Fix | the build');
  assert.equal(isUnread(c.threads.get('t:task-1')), true, 'OpenBot says the side thread has unread');
  c.visit('t:task-1');
  await tick(30);
  assert.deepEqual(posted(fake, '/v1/agent-threads/read'), [{ agentId: 'ada', taskId: 'task-1', throughMessageId: 'x1' }]);
  assert.equal(isUnread(c.threads.get('t:task-1')), false);
  assert.deepEqual(c.modelGroups()[0].choices.map((m) => [m.instanceId, m.model, m.effort.options.length]), [['claude', 'claude-opus-5-5', 3]]);
  c.stop();
});

test('a thread view shows replies, the run\'s activity, and streaming text as it arrives', { skip }, async () => {
  const fake = fakeHost();
  const c = await connected(fake);
  let p = await c.threadProjection('a:ada');
  assert.deepEqual(p.messages.map((m) => [m.role, m.text, !!m.streaming]), [['user', 'fix it', false], ['assistant', 'Half', true]]);
  assert.equal(activityLabel(p), 'Half', 'the newest note of the running turn');
  const changes = [];
  c.on('change', (e) => changes.push(e.id));
  fake.event({ type: 'conversation-delta', agentId: 'ada', threadId: 'th-ada', turnId: 'turn-a', messageId: 'm3', delta: ' done', createdAt: '', revision: 4 });
  assert.ok(changes.includes('a:ada'), 'a delta updates the thread right away');
  assert.equal(c.chats.get('ada').messages.at(-1).text, 'Half done');
  fake.event({ type: 'turn-progress', agentId: 'ada', threadId: 'th-ada', turnId: 'turn-a', detail: 'Running tests' });
  assert.equal(activityLabel(await c.threadProjection('a:ada')), 'Running tests', "the server's progress line wins");
  p = await c.threadProjection('t:task-1');
  assert.deepEqual(p.messages.map((m) => m.text), ['Task reply']);
  const bo = await c.threadProjection('a:bo');
  assert.equal(bo.messages.at(-1).text, '**From Ada:** ping');
  c.stop();
});

test('turn events move a chat between working and finished', { skip }, async () => {
  const fake = fakeHost();
  const c = await connected(fake);
  fake.state.pages.ada.activeTurnId = null;
  fake.event({ type: 'turn-completed', agentId: 'ada', threadId: 'th-ada', turnId: 'turn-a', status: 'completed' });
  assert.equal(threadStatus(c.threads.get('a:ada')), 'open');
  await tick();
  assert.equal(threadStatus(c.threads.get('a:ada')), 'open', 'the re-read page agrees');
  fake.event({ type: 'runtime-snapshot', snapshot: { activeTurns: [{ agentId: 'bo', threadId: 'th-bo', turnId: 'turn-z' }], pendingPrompts: [], pendingApprovals: [], attentionComplete: true } });
  assert.equal(threadStatus(c.threads.get('a:bo')), 'working');
  c.stop();
});

test('questions and approvals land on their chat and are answered over the relay', { skip }, async () => {
  const fake = fakeHost();
  const c = await connected(fake);
  fake.event({ type: 'prompt', requestId: 41, agentId: 'ada', threadId: 'th-task-1', turnId: 't', questions: [{ id: 'q1', header: 'Branch', question: 'Which?', isSecret: false, options: [{ label: 'main', description: '' }] }] });
  const task = c.threads.get('t:task-1');
  assert.equal(threadStatus(task), 'input');
  const pr = pendingRequest(await c.threadProjection('t:task-1'));
  assert.equal(pr.kind, 'question');
  assert.equal(pr.id, '41');
  await c.respondAnswers('t:task-1', '41', { q1: 'main' });
  assert.deepEqual(posted(fake, '/v1/prompts/respond'), [{ requestId: 41, answers: { q1: ['main'] } }], 'the original id type goes back');
  assert.equal(threadStatus(c.threads.get('t:task-1')), 'open');

  fake.event({ type: 'approval', approval: { requestId: 'ap-1', agentId: 'bo', threadId: 'th-bo', turnId: 't', kind: 'command', command: 'rm -rf build', cwd: '/repo', reason: null, grantRoot: null, permissions: null } });
  const ap = pendingRequest(await c.threadProjection('a:bo'));
  assert.equal(ap.what, 'Run a command');
  assert.equal(ap.detail, 'rm -rf build\nin /repo');
  await c.respondApproval('a:bo', 'ap-1', 'acceptForSession');
  assert.deepEqual(posted(fake, '/v1/approvals/respond'), [{ requestId: 'ap-1', decision: 'accept' }]);

  fake.event({ type: 'prompt', requestId: 'sec', agentId: 'bo', threadId: 'th-bo', turnId: 't', questions: [{ id: 'pw', question: 'Password?', isSecret: true, options: null }] });
  await assert.rejects(c.respondAnswers('a:bo', 'sec', { pw: 'x' }), /secret/);
  fake.event({ type: 'agent-input-resolved', kind: 'prompt', requestId: 'sec', agentId: 'bo' });
  assert.equal(c.threads.get('a:bo')._pending, null);
  c.stop();
});

test('messages, steering, screenshots, side-thread replies, stop and model changes', { skip }, async () => {
  const fake = fakeHost();
  const c = await connected(fake);
  const shot = await c.uploadImage('a:ada', Buffer.from('png'), 's.png', 'image/png');
  await c.sendMessage('a:ada', 'also this', 'steer', [shot]);
  const send = posted(fake, '/v1/agents/ada/messages')[0];
  assert.equal(send.text, 'also this');
  assert.deepEqual(send.attachmentDraftIds, ['draft-1']);
  assert.match(send.clientMessageId, /^wow-/);
  const upload = fake.calls.find((x) => x.path?.startsWith('/v1/attachments?'));
  assert.equal(upload.upload.base64, Buffer.from('png').toString('base64'));
  assert.deepEqual(posted(fake, '/v1/agents/ada/queue/steer'), [{ deliveryId: 'del-1', expectedTurnId: 'turn-a' }], 'a working agent is steered');

  await c.sendMessage('a:bo', 'hi', 'steer', []);
  assert.equal(posted(fake, '/v1/agents/bo/queue/steer').length, 0, 'an idle agent is not');

  await c.sendMessage('t:task-1', 'and the tests', 'steer', []);
  const reply = posted(fake, '/v1/agent-tasks/send')[0];
  assert.equal(reply.taskId, 'task-1');
  assert.equal(reply.text, 'and the tests');
  assert.equal(reply.replyToMessageId, undefined);
  await c.sendMessage('t:task-1', 'see this', 'steer', [shot]);
  assert.deepEqual(posted(fake, '/v1/agent-threads/send-with-files')[0].attachmentDraftIds, ['draft-1']);
  assert.equal(posted(fake, '/v1/agent-threads/send-reply').length, 0);

  await c.interrupt('a:ada');
  assert.deepEqual(posted(fake, '/v1/agents/ada/interrupt'), [{ turnId: 'turn-a' }]);
  await c.interrupt('t:task-1');
  assert.deepEqual(posted(fake, '/v1/agent-tasks/stop'), [{ agentId: 'ada', taskId: 'task-1' }]);

  await c.setModel('a:bo', 'claude', 'claude-opus-5-5', 'max');
  assert.deepEqual(fake.calls.find((x) => x.method === 'PATCH').body, { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'max' });
  assert.equal(c.threads.get('a:bo').modelSelection.model, 'claude-opus-5-5');

  const res = await c.launchThread('bo', 'new task', [], { effort: 'low' });
  assert.deepEqual(res, { threadId: 'a:bo' });
  c.visit('a:bo');
  await tick(20);
  assert.deepEqual(posted(fake, '/v1/agents/bo/conversation/read'), [{ throughMessageId: null }]);
  c.stop();
});

test('in the game, servers come with their codes and their runs can be stopped', { skip }, async () => {
  const fake = fakeHost();
  const remote = await connected(fake);
  const local = Object.assign(new (await import('node:events')).EventEmitter(), {
    state: 'connected', error: null, threads: new Map(), projects: new Map([['mine', { id: 'mine', title: 'Mine' }]]), config: { providers: [] },
    start() {}, stop() {}, apiStatus: () => ({ on: false, agents: [] }), modelGroups: () => [{ code: '', choices: [] }], defaultModelFor: () => null,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obwow-addons-'));
  fs.mkdirSync(path.join(dir, 'OpenBot'));
  new SlotBank(dir, { slots: 4 }).install();
  const b = new Bridge({ addonsDir: dir, config: { slots: 4 }, log: () => {}, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'obwow-state-')) });
  b.ob = new Fleet({ local });
  b.ob.add({ code: 's1', id: 'host-1', label: 'Homelab', client: remote });
  remote.emit('change', { kind: 'snapshot' });
  const snap = b.buildSnapshot();
  assert.deepEqual(snap.bridge.envs.map((e) => e.label), ['this computer', 'Homelab'], 'the server switcher lists both');
  const ada = snap.threads.find((t) => t.id === 's1~a:ada');
  assert.equal(ada.ks, true, 'a working run on a server can be stopped');
  assert.equal(ada.env, 'Homelab');
  assert.equal(snap.threads.find((t) => t.id === 's1~t:task-1').sd, undefined, 'its side threads take replies');
  const ada2 = snap.projects.find((p) => p.id === 's1~ada');
  assert.deepEqual([ada2.name, ada2.sv, ada2.env], ['Ada', 's1', 'Homelab'], 'plain name, with the server code to match on');
  assert.equal(snap.threads.find((t) => t.id === 's1~a:ada').sv, 's1');
  assert.deepEqual(snap.bridge.envs.map((e) => e.c), ['', 's1'], 'each server carries its code');
  b.servers = { status: () => ({ signedIn: true, error: null }), stop() {} };
  remote.setState('offline', 'The connection to the server was lost.');
  let bridge = b.buildSnapshot().bridge;
  assert.equal(bridge.relay, 'on');
  assert.equal(bridge.via, 'database');
  assert.deepEqual(bridge.envs.find((e) => e.label === 'Homelab'), { c: 's1', label: 'Homelab', state: 'offline', local: undefined, n: 3, err: 'The connection to the server was lost.' });
  b.servers = { status: () => ({ signedIn: false, error: null }), stop() {} };
  bridge = b.buildSnapshot().bridge;
  assert.equal(bridge.relay, 'off', 'not signed in');
  assert.ok(bridge.envs, 'two servers are listed even when signed out');
  b.ob.remove('s1');
  assert.equal(b.buildSnapshot().bridge.envs, undefined, 'signed out with only this computer: no server picker');
  b.servers = { status: () => ({ signedIn: true, error: null }), stop() {} };
  assert.deepEqual(b.buildSnapshot().bridge.envs.map((e) => [e.c, e.label]), [['', 'this computer']], 'signed in with one server: it is still named');
  remote.stop();
  b.stop();
});

test('a lost connection is tried again until it comes back', { skip }, async () => {
  const fake = fakeHost();
  const c = await connected(fake, { retryMs: 10 });
  const connects = () => fake.calls.filter((x) => x.type === 'connect').length;
  assert.equal(connects(), 1);
  await fake.update({ state: 'offline', message: "The connection's network path changed. Reconnecting." });
  assert.equal(c.state, 'offline');
  await tick(60);
  assert.equal(connects(), 2, 'it connected again');
  assert.equal(c.state, 'connected');
  assert.ok(c.threads.size > 0, 'and loaded the server again');
  c.stop();
});

test('a server that is off is waited for; an ended session starts a new one; a revoked sign-in stops', { skip }, async () => {
  const fake = fakeHost();
  let signedIn = true;
  const directory = { listHosts: async () => { if (!signedIn) throw Object.assign(new Error('Unauthorized'), { status: 401 }); return []; } };
  const c = await connected(fake, { retryMs: 10, directory });
  const connects = () => fake.calls.filter((x) => x.type === 'connect').length;
  await fake.update({ state: 'connecting', hostOffline: true });
  assert.match(c.error, /server is offline/);
  await tick(40);
  assert.equal(connects(), 1, 'the relay holds that attempt itself');
  // Another client of the same sign-in ended the session on this server.
  await fake.update({ state: 'offline', code: 'session_revoked', message: 'revoked' });
  assert.match(c.error, /Starting a new one/);
  await tick(150);
  assert.equal(connects(), 2, 'a new session');
  assert.equal(c.state, 'connected');
  // The sign-in itself was revoked in OpenBot.
  signedIn = false;
  await fake.update({ state: 'offline', code: 'session_revoked', message: 'revoked' });
  await tick(60);
  assert.match(c.error, /openbot-wow login/);
  assert.equal(connects(), 2, 'no more attempts');
  c.stop();
});

test('side threads close and reopen in OpenBot; a main chat can\'t be closed', { skip }, async () => {
  const fake = fakeHost();
  const c = await connected(fake);
  await assert.rejects(c.close('a:ada'), /main chat can't be closed/);
  assert.equal(posted(fake, '/v1/agent-tasks/close').length, 0);
  assert.equal(c.threads.has('t:task-2'), false, 'a task closed days ago is gone');
  await c.close('t:task-1');
  assert.deepEqual(posted(fake, '/v1/agent-tasks/close'), [{ agentId: 'ada', taskId: 'task-1' }]);
  assert.equal(threadStatus(c.threads.get('t:task-1')), 'closed', 'kept for a while, closed, so it can be reopened');
  await c.reopen('t:task-1');
  assert.deepEqual(posted(fake, '/v1/agent-tasks/reopen'), [{ agentId: 'ada', taskId: 'task-1' }]);
  assert.equal(threadStatus(c.threads.get('t:task-1')), 'open');
  // Closed, then it runs again (someone wrote to it on the desktop): it's back, and its run starts now.
  await c.close('t:task-1');
  const task = fake.state.tasks.ada.find((t) => t.id === 'task-1');
  const now = new Date().toISOString();
  Object.assign(task, { state: 'running', closedAt: null, updatedAt: now, activeTurnId: 'turn-t' });
  fake.event({ type: 'agent-tasks-changed', agentId: 'ada' });
  await tick();
  const t1 = c.threads.get('t:task-1');
  assert.equal(threadStatus(t1), 'working');
  assert.equal(t1.activityRunStartedAt, now, 'the run start is when it started running, not when the task was made');
  // The bridge keeps no settle or archive marks for the relay.
  c.visit('a:bo');
  const file = path.join(c.input.stateDir, 'threads.json');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['visited']);
  c.stop();
});

test('channels show as threads, read with each speaker named, and take messages, stops and read marks', { skip }, async () => {
  const fake = fakeHost({ channels: true });
  const c = await connected(fake);
  const t = c.threads.get('c:ch-web');
  assert.ok(t, 'a channel is a thread');
  assert.equal(c.threads.has('c:ch-old'), false, 'an archived channel is not');
  assert.deepEqual([t.title, t._channel, t.projectId, threadStatus(t), isUnread(t)], ['Website', 'ch-web', 'c:ch-web', 'working', true]);
  assert.equal(t.latestVisibleMessage.text, 'Ada: Placeholder is live');
  assert.deepEqual(c.projects.get('c:ch-web'), { id: 'c:ch-web', title: 'Website', channel: true });
  assert.equal(c.defaultModelFor('c:ch-web'), null, 'a channel has no model of its own');

  const p = await c.threadProjection('c:ch-web');
  assert.deepEqual(p.messages.map((m) => [m.role, m.who ?? 'me', m.text, !!m.streaming]), [
    ['user', 'me', 'Build the site', false],
    ['user', 'Sam', 'And a blog', false],
    ['assistant', 'Ada', 'On it.', false],
    ['assistant', 'Bo', 'Copy is', true],
  ], 'in order; yours unnamed, others named; superseded and progress notes left out');
  assert.equal(activityLabel(p), 'Ada: Ship the landing page');

  await c.sendMessage('c:ch-web', 'Use the new logo', 'steer', []);
  const send = posted(fake, '/v1/channels/commands').find((b) => b.type === 'send');
  assert.deepEqual({ ...send, operationId: undefined }, { operationId: undefined, channelId: 'ch-web', type: 'send', text: 'Use the new logo', recipientAgentId: null, replyToMessageId: null, attachmentDraftIds: [] });
  assert.match(send.operationId, /^wow-/);

  await c.interrupt('c:ch-web');
  const stops = posted(fake, '/v1/channels/commands').filter((b) => b.type === 'stop');
  assert.deepEqual(stops.map((b) => b.taskId), ['task-root'], 'the running root task; its subtask stops with it');

  c.visit('c:ch-web');
  await tick(30);
  assert.equal(posted(fake, '/v1/channels/commands').find((b) => b.type === 'read').throughSequence, 7);
  assert.equal(isUnread(c.threads.get('c:ch-web')), false);

  await assert.rejects(c.close('c:ch-web'), /channel can't be closed/);

  fake.state.channels[0].name = 'Website v2';
  fake.event({ type: 'channels-changed', channelId: 'ch-web', revision: 5 });
  await tick();
  assert.equal(c.threads.get('c:ch-web').title, 'Website v2', 'a change in OpenBot shows');
  c.stop();
});

test('in the game, a channel row is flagged and its messages carry their speaker', { skip }, async () => {
  const fake = fakeHost({ channels: true });
  const remote = await connected(fake);
  const local = Object.assign(new (await import('node:events')).EventEmitter(), {
    state: 'connected', error: null, threads: new Map(), projects: new Map(), config: { providers: [] },
    start() {}, stop() {}, apiStatus: () => ({ on: false, agents: [] }), modelGroups: () => [{ code: '', choices: [] }], defaultModelFor: () => null,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obwow-addons-'));
  fs.mkdirSync(path.join(dir, 'OpenBot'));
  new SlotBank(dir, { slots: 4 }).install();
  const b = new Bridge({ addonsDir: dir, config: { slots: 4 }, log: () => {}, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'obwow-state-')) });
  b.ob = new Fleet({ local });
  b.ob.add({ code: 's1', id: 'host-1', label: 'Homelab', client: remote });
  remote.emit('change', { kind: 'snapshot' });
  b.client = { session: 's', ui: 'u', seq: 1, ackedSeq: -1, flags: 'o', view: 's1~c:ch-web', slotNext: 1 };
  await b.refreshView('s1~c:ch-web', true);
  const snap = b.buildSnapshot();
  const row = snap.threads.find((t) => t.id === 's1~c:ch-web');
  assert.deepEqual([row.ch, row.mc, row.p], [true, undefined, 's1~c:ch-web']);
  assert.equal(snap.projects.find((p) => p.id === 's1~c:ch-web').ch, true);
  assert.deepEqual(snap.view.msgs.map((m) => [m.r, m.w]), [['u', undefined], ['u', 'Sam'], ['a', 'Ada'], ['a', 'Bo']]);
  remote.stop();
  b.stop();
});
