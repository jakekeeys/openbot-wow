// The account's other OpenBot servers, added to the fleet. Runs only when the bridge has
// its own account session (`openbot-wow login`) and dist/team.mjs is built: that bundle
// holds OpenBot's own client code, which reaches a server through OpenBot's relay.
//
// Each server gets a short code ("s1", "s2"…) kept in servers.json, so thread ids stay
// the same across restarts. The server whose agents are this computer's own is this computer:
// while the relay reaches it, the game uses it for this computer too, since through the relay
// side-thread replies, stop and answers work; otherwise the bridge reads this computer's
// database.

import fs from 'node:fs';
import path from 'node:path';
import { readAccount, API_URL } from './account.js';

const REFRESH_MS = 5 * 60 * 1000;
// How long the relay to this computer may be down before the game goes back to the database.
export const SELF_FALLBACK_MS = 60 * 1000;

export function wanted(host, config = {}) {
  const pick = config.servers;
  const hidden = (config.hideServers || []).map((s) => String(s).toLowerCase());
  if (hidden.includes(host.name.toLowerCase()) || hidden.includes(host.hostId)) return false;
  if (!Array.isArray(pick)) return true;
  return pick.some((s) => String(s).toLowerCase() === host.name.toLowerCase() || s === host.hostId);
}

export function startServers({ fleet, stateDir, config = {}, log = () => {}, loadTeam = () => import('../dist/team.mjs'), account: getAccount = readAccount, fallbackMs = SELF_FALLBACK_MS }) {
  const file = path.join(stateDir, 'servers.json');
  let saved = { codes: {}, self: [] };
  try {
    saved = { codes: {}, self: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {}
  const save = () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(saved, null, 1));
  };
  const status = { signedIn: false, error: null, servers: [] };
  let stopped = false;
  let timer = null;
  let directory = null;
  let team = null;
  let self = null; // { hostId, client, timer }

  const codeFor = (hostId) => {
    if (!saved.codes[hostId]) {
      const used = new Set(Object.values(saved.codes));
      let n = 1;
      while (used.has(`s${n}`)) n++;
      saved.codes[hostId] = `s${n}`;
      save();
    }
    return saved.codes[hostId];
  };

  // This computer through the relay while it's connected; its database after a longer outage.
  const adoptSelf = (hostId, client) => {
    const follow = (state) => {
      if (self?.client !== client) return;
      clearTimeout(self.timer);
      if (state === 'connected') fleet.useLocal(client);
      else if (fleet.local.client === client) self.timer = setTimeout(() => fleet.local.client === client && fleet.useLocal(null), fallbackMs);
    };
    self = { hostId, client, timer: null, follow };
    client.on('state', follow);
    follow(client.state);
  };

  const dropSelf = () => {
    if (!self) return;
    clearTimeout(self.timer);
    self.client.off('state', self.follow);
    self.client.stop();
    self = null;
    fleet.useLocal(null);
  };

  // A server that shows this computer's agents is this computer.
  const watchForSelf = (env) => {
    const check = () => {
      const local = fleet.database.projects;
      if (!local.size || !env.client.projects.size) return;
      env.client.off('change', check);
      if ([...env.client.projects.keys()].some((id) => local.has(id))) {
        log(`${env.label} is this computer; using the relay for it`);
        if (!saved.self.includes(env.id)) saved.self.push(env.id);
        save();
        fleet.remove(env.code, { stop: false });
        adoptSelf(env.id, env.client);
      }
    };
    env.client.on('change', check);
  };

  async function refresh() {
    if (stopped) return;
    const account = getAccount();
    status.signedIn = !!account;
    if (!account) {
      for (const env of fleet.envs.filter((e) => !e.local)) fleet.remove(env.code);
      dropSelf();
      status.servers = [];
      return;
    }
    try {
      team = team || (await loadTeam());
      directory = directory || team.createDirectory({ apiUrl: API_URL, sessionToken: account.sessionToken, configDir: path.dirname(file), log });
      const hosts = await directory.listHosts();
      status.error = null;
      status.servers = hosts.map((h) => ({ name: h.name, role: h.role, shown: saved.self.includes(h.hostId) ? 'this computer' : wanted(h, config) }));
      const keep = new Set();
      if (self && !hosts.some((h) => h.hostId === self.hostId)) dropSelf();
      for (const host of hosts) {
        if (saved.self.includes(host.hostId)) {
          if (!self) {
            const client = team.createHostClient({ directory, host, stateDir: path.join(stateDir, 'servers', codeFor(host.hostId)), config, log });
            adoptSelf(host.hostId, client);
            client.start();
          }
          continue;
        }
        if (!wanted(host, config)) continue;
        const code = codeFor(host.hostId);
        keep.add(code);
        if (fleet.envs.some((e) => e.code === code)) continue;
        const client = team.createHostClient({ directory, host, stateDir: path.join(stateDir, 'servers', code), config, log });
        const env = fleet.add({ code, id: host.hostId, label: host.name, local: false, client });
        watchForSelf(env);
        client.start();
        log(`server ${host.name} (${code}) added`);
      }
      for (const env of fleet.envs.filter((e) => !e.local && !keep.has(e.code))) {
        log(`server ${env.label} removed`);
        fleet.remove(env.code);
      }
    } catch (err) {
      status.error = err.code === 'ERR_MODULE_NOT_FOUND' ? 'The server client is not built (npm run build:team).' : err.message;
      log(`servers: ${status.error}`);
      if (/401|unauthor|session/i.test(err.message)) directory = null;
    }
  }

  const loop = async () => {
    await refresh();
    if (!stopped) timer = setTimeout(loop, REFRESH_MS);
  };
  loop();

  return {
    status: () => ({ ...status }),
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (self) {
        clearTimeout(self.timer);
        self.client.stop();
      }
    },
  };
}
