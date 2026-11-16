import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Fleet } from '../src/fleet.js';
import { startServers, wanted } from '../src/servers.js';

// A client with OpenBotClient's interface and canned data.
class FakeClient extends EventEmitter {
  constructor(agents = [], threads = []) {
    super();
    this.state = 'connected';
    this.error = null;
    this.projects = new Map(agents.map((a) => [a.id, { id: a.id, title: a.name }]));
    this.threads = new Map(threads.map((t) => [t.id, t]));
    this.calls = [];
    this.started = 0;
    this.stopped = 0;
    this.config = { providers: [{ instanceId: 'claude', enabled: true }] };
  }
  start() {
    this.started++;
  }
  stop() {
    this.stopped++;
  }
  apiStatus() {
    return { on: false, agents: [] };
  }
  modelGroups() {
    return [{ code: '', choices: [{ instanceId: 'claude', model: 'm', name: 'M', provider: 'Claude' }] }];
  }
  defaultModelFor(id) {
    return { instanceId: 'claude', model: `for-${id}` };
  }
  async sendMessage(...a) {
    this.calls.push(['send', ...a]);
  }
  async launchThread(...a) {
    this.calls.push(['new', ...a]);
    return { threadId: `${a[0]}-main` };
  }
  async threadProjection(id) {
    return { id };
  }
}

const thread = (id, projectId) => ({ id, projectId, title: id });

test('servers get prefixed ids; calls go to the server that owns the thread', async () => {
  const local = new FakeClient([{ id: 'a1', name: 'Local' }], [thread('t1', 'a1')]);
  const remote = new FakeClient([{ id: 'r1', name: 'Remote' }], [thread('t9', 'r1')]);
  const fleet = new Fleet({ local });
  fleet.add({ code: 's1', id: 'host-1', label: 'Homelab', client: remote });
  local.emit('change', { kind: 'snapshot' });
  remote.emit('change', { kind: 'snapshot' });
  assert.deepEqual([...fleet.threads.keys()].sort(), ['s1~t9', 't1']);
  assert.equal(fleet.threads.get('s1~t9').projectId, 's1~r1');
  assert.equal(fleet.threads.get('s1~t9')._env.label, 'Homelab');
  assert.equal(fleet.projects.get('s1~r1').title, 'Remote');

  await fleet.sendMessage('s1~t9', 'hi', 'steer', []);
  await fleet.sendMessage('t1', 'yo', 'steer', []);
  assert.deepEqual(remote.calls[0], ['send', 't9', 'hi', 'steer', []]);
  assert.deepEqual(local.calls[0], ['send', 't1', 'yo', 'steer', []]);
  const res = await fleet.launchThread('s1~r1', 'go', [], {});
  assert.equal(res.threadId, 's1~r1-main', 'a new thread id comes back prefixed');
  assert.deepEqual(fleet.defaultModelFor('s1~r1'), { instanceId: 'claude', model: 'for-r1' });
  assert.deepEqual(fleet.modelGroups().map((g) => g.code), ['', 's1']);
  assert.deepEqual(fleet.environments().map((e) => [e.code, e.label, e.threads]), [['', 'this computer', 1], ['s1', 'Homelab', 1]]);
});

test('a server that goes offline takes its threads; removing it stops it', () => {
  const local = new FakeClient();
  const remote = new FakeClient([{ id: 'r1', name: 'R' }], [thread('t9', 'r1')]);
  const fleet = new Fleet({ local });
  fleet.add({ code: 's1', id: 'h', label: 'Homelab', client: remote });
  remote.emit('change', { kind: 'snapshot' });
  assert.equal(fleet.threads.size, 1);
  remote.state = 'offline';
  remote.emit('state', 'offline', 'lost');
  assert.equal(fleet.threads.size, 0);
  // Back again, with the same threads (its client reports no changes for them).
  remote.state = 'connected';
  remote.emit('state', 'connected');
  assert.equal(fleet.threads.size, 1, 'its threads come back on reconnect');
  remote.state = 'offline';
  remote.emit('state', 'offline', 'lost');
  fleet.remove('s1');
  assert.equal(remote.stopped, 1);
  assert.equal(fleet.envs.length, 1);
});

test('servers can be picked or hidden in the config', () => {
  const h = { name: 'Homelab', hostId: 'h1' };
  assert.equal(wanted(h, {}), true);
  assert.equal(wanted(h, { servers: ['homelab'] }), true);
  assert.equal(wanted(h, { servers: ['Other'] }), false);
  assert.equal(wanted(h, { hideServers: ['h1'] }), false);
});

test('signed-in servers join the fleet with stable codes, and this computer is skipped', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obwow-servers-'));
  const local = new FakeClient([{ id: 'mine', name: 'Mine' }]);
  const fleet = new Fleet({ local });
  const clients = {};
  const hosts = [
    { hostId: 'h-homelab', name: 'Homelab', role: 'owner', devicePublicKey: 'k' },
    { hostId: 'h-self', name: 'Desk', role: 'owner', devicePublicKey: 'k' },
  ];
  const team = {
    createDirectory: () => ({ listHosts: async () => hosts.map((h) => ({ ...h })) }),
    createHostClient: ({ host }) => {
      const c = new FakeClient(host.hostId === 'h-self' ? [{ id: 'mine', name: 'Mine' }] : [{ id: 'y1', name: 'Y' }]);
      clients[host.hostId] = c;
      return c;
    },
  };
  const servers = startServers({ fleet, stateDir, loadTeam: async () => team, account: () => ({ sessionToken: 'tok' }), fallbackMs: 20 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(servers.status().signedIn, true);
  assert.deepEqual(fleet.envs.map((e) => e.label), ['this computer', 'Homelab', 'Desk']);
  assert.equal(clients['h-homelab'].started, 1);
  clients['h-self'].emit('change', { kind: 'snapshot' });
  assert.deepEqual(fleet.envs.map((e) => e.label), ['this computer', 'Homelab'], 'the server with our agents is this computer');
  assert.equal(fleet.local.client, clients['h-self'], 'this computer now goes through the relay');
  assert.equal(fleet.local.via, 'relay');
  assert.equal(clients['h-self'].stopped, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'servers.json'), 'utf8'));
  assert.deepEqual(saved.codes, { 'h-homelab': 's1', 'h-self': 's2' });
  assert.deepEqual(saved.self, ['h-self']);

  // A renamed server shows its new name on the next server list.
  hosts[0].name = 'Home Bot';
  await servers.refresh();
  assert.deepEqual(fleet.envs.map((e) => e.label), ['this computer', 'Home Bot']);
  assert.equal(fleet.envs[1].code, 's1', 'same code');

  // The relay drops: the game keeps it for a moment, then reads the database again.
  clients['h-self'].state = 'offline';
  clients['h-self'].emit('state', 'offline', 'lost');
  assert.equal(fleet.local.via, 'relay');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fleet.local.client, local);
  clients['h-self'].state = 'connected';
  clients['h-self'].emit('state', 'connected');
  assert.equal(fleet.local.via, 'relay', 'and back once it reconnects');
  servers.stop();
  assert.equal(clients['h-self'].stopped, 1);

  // Next start: the known host is this computer straight away.
  const fleet2 = new Fleet({ local: new FakeClient([{ id: 'mine', name: 'Mine' }]) });
  const again = startServers({ fleet: fleet2, stateDir, loadTeam: async () => team, account: () => ({ sessionToken: 'tok' }) });
  await new Promise((r) => setTimeout(r, 30));
  again.stop();
  assert.deepEqual(fleet2.envs.map((e) => e.label), ['this computer', 'Home Bot']);
  assert.equal(fleet2.local.via, 'relay');
});

test('signed out, no servers are asked for', async () => {
  const fleet = new Fleet({ local: new FakeClient() });
  let loaded = false;
  const servers = startServers({ fleet, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'obwow-servers-')), loadTeam: async () => ((loaded = true), {}), account: () => null });
  await new Promise((r) => setTimeout(r, 10));
  servers.stop();
  assert.equal(servers.status().signedIn, false);
  assert.equal(loaded, false);
  assert.equal(fleet.envs.length, 1);
});
