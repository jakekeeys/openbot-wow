#!/usr/bin/env node
// openbot-wow: install and run the OpenBot bridge for World of Warcraft: Forever.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bridge, STATE_DIR, CONFIG_DIR, VERSION } from '../src/bridge.js';
import { OpenBotClient, databaseFile } from '../src/openbot.js';
import { readAccount, startSignIn, finishSignIn, signOut, API_URL } from '../src/account.js';
import { wanted } from '../src/servers.js';
import { findWowInstalls, addonsDir as addonsDirOf, findWowProcess } from '../src/wow.js';
import { SlotBank, ADDON, CTL_LONG } from '../src/slots.js';
import { StripCapture, SCREEN_PERMISSION_HELP } from '../src/capture.js';
import { decodeImage } from '../src/codec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, '..');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const MAC = process.platform === 'darwin';
const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'openbot-wow');
const BIN_LINK = path.join(os.homedir(), '.local/bin/openbot-wow');
const DEFAULT_SLOTS = 1200;

const C = process.stdout.isTTY
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` }
  : { b: String, g: String, y: String, r: String, d: String };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

// The addon ships next to the bridge (repo layout) or inside it (installed layout).
function addonSource() {
  for (const p of [path.join(BRIDGE_ROOT, '..', 'addon', ADDON), path.join(BRIDGE_ROOT, 'addon', ADDON)]) {
    if (fs.existsSync(path.join(p, `${ADDON}.toc`))) return p;
  }
  throw new Error('could not find the addon sources next to the bridge');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function resolveWowDir(args, cfg) {
  if (args.wow) {
    const dir = path.resolve(String(args.wow));
    if (fs.existsSync(path.join(dir, '_forever_'))) return path.join(dir, '_forever_');
    return dir;
  }
  if (cfg.wowDir && fs.existsSync(cfg.wowDir)) return cfg.wowDir;
  const { forever, wowOnly, prefixes } = findWowInstalls();
  if (forever.length > 1) console.log(C.y(`Found several WoW: Forever installs, using the first (pick one with --wow):\n  ${forever.join('\n  ')}`));
  if (forever.length) return forever[0];
  const where = '\nIf it\'s somewhere else, pass --wow "/path/to/World of Warcraft".';
  if (wowOnly.length) {
    throw new Error(`found World of Warcraft at ${wowOnly[0]}, but not WoW: Forever. Install Forever from Battle.net (it's a separate game version), launch it once, then run ./install.sh again.${where}`);
  }
  if (prefixes.length) {
    throw new Error(`found Battle.net (${prefixes[0]}) but no World of Warcraft. Install WoW: Forever from Battle.net, launch it once, then run ./install.sh again.${where}`);
  }
  if (MAC) throw new Error(`couldn't find World of Warcraft. Install Battle.net from blizzard.com, install WoW: Forever from it and launch it once, then run ./install.sh again.${where}`);
  throw new Error(`couldn't find Battle.net. On Omarchy, install it with omarchy-install-gaming-battlenet; on CachyOS, add Battle.net to Faugus Launcher or Lutris. Then install WoW: Forever from it, launch it once, and run ./install.sh again.${where}`);
}

// The bridge runs as a systemd user service on Linux and a launchd agent on macOS.
// Commands are quiet unless they fail (enabling prints "Created symlink …", which isn't news).
function quiet(cmd, args, { warn = true } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0 && warn) process.stderr.write(r.stderr || `${cmd} ${args.join(' ')} failed\n`);
  return r.status === 0;
}

// On macOS, the launch agent runs the `node` found on PATH, such as Homebrew's
// /opt/homebrew/bin/node, rather than the versioned folder that link points to.
// `brew upgrade node` deletes the old versioned folder, and the agent would then fail
// to start at the next login.
function bridgeCommand() {
  const linked = (process.env.PATH || '').split(':').map((dir) => path.join(dir, 'node')).find((p) => {
    try {
      return fs.realpathSync(p) === process.execPath;
    } catch {
      return false;
    }
  });
  return [(MAC && linked) || process.execPath, path.join(BRIDGE_ROOT, 'bin', 'openbot-wow.js'), 'run'];
}

const systemd = {
  name: 'openbot-wow.service',
  file: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user', 'openbot-wow.service'),
  kind: 'user service',
  install() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, [
      '[Unit]',
      'Description=OpenBot bridge for World of Warcraft',
      'After=graphical-session.target',
      '',
      '[Service]',
      `ExecStart=${bridgeCommand().join(' ')}`,
      'Restart=always',
      'RestartSec=3',
      `Environment=PATH=${process.env.PATH}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'));
    quiet('systemctl', ['--user', 'daemon-reload']);
    quiet('systemctl', ['--user', 'enable', this.name]);
    return quiet('systemctl', ['--user', 'restart', this.name]);
  },
  restart() {
    quiet('systemctl', ['--user', 'restart', this.name]);
  },
  remove() {
    quiet('systemctl', ['--user', 'disable', '--now', this.name], { warn: false });
    fs.rmSync(this.file, { force: true });
    quiet('systemctl', ['--user', 'daemon-reload'], { warn: false });
  },
};

const launchd = {
  name: 'openbot-wow',
  file: path.join(os.homedir(), 'Library/LaunchAgents/openbot-wow.plist'),
  kind: 'launch agent',
  target: () => `gui/${process.getuid()}`,
  install() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const str = (v) => `<string>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>`;
    fs.writeFileSync(this.file, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      `  <key>Label</key>${str(this.name)}`,
      `  <key>ProgramArguments</key><array>${bridgeCommand().map(str).join('')}</array>`,
      `  <key>EnvironmentVariables</key><dict><key>PATH</key>${str(process.env.PATH)}</dict>`,
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><true/>',
      '  <key>ThrottleInterval</key><integer>3</integer>',
      '  <key>ProcessType</key><string>Interactive</string>',
      `  <key>StandardOutPath</key>${str(path.join(STATE_DIR, 'bridge.log'))}`,
      `  <key>StandardErrorPath</key>${str(path.join(STATE_DIR, 'bridge.log'))}`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n'));
    // Reload so a changed plist (a new node path, say) takes effect.
    quiet('launchctl', ['bootout', `${this.target()}/${this.name}`], { warn: false });
    if (quiet('launchctl', ['bootstrap', this.target(), this.file], { warn: false })) return true;
    // bootout can still be finishing ("Bootstrap failed: 5"); only the retry's error is worth showing.
    spawnSync('sleep', ['1']);
    return quiet('launchctl', ['bootstrap', this.target(), this.file]);
  },
  restart() {
    quiet('launchctl', ['kickstart', '-k', `${this.target()}/${this.name}`]);
  },
  remove() {
    quiet('launchctl', ['bootout', `${this.target()}/${this.name}`], { warn: false });
    fs.rmSync(this.file, { force: true });
  },
};

const service = MAC ? launchd : systemd;

// Copy just the addon code (leaving Signals/ and generated media alone).
function syncAddon(addonsDir) {
  const src = addonSource();
  const dst = path.join(addonsDir, ADDON);
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'Signals') continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
  return dst;
}

async function cmdInstall(args) {
  const cfg = readConfig();
  const wowDir = resolveWowDir(args, cfg);
  const addonsDir = addonsDirOf(wowDir);
  console.log(`${C.b('World of Warcraft:')} ${wowDir}`);
  fs.mkdirSync(addonsDir, { recursive: true });

  // The game only discovers new addon folders and sound files when it starts.
  const freshAddon = !fs.existsSync(path.join(addonsDir, ADDON, `${ADDON}.toc`));
  const dst = syncAddon(addonsDir);
  console.log(`${C.g('✓')} Addon installed to ${dst}`);

  const slots = Number(args.slots || cfg.slots || DEFAULT_SLOTS);
  const bank = new SlotBank(addonsDir, { slots });
  const had = bank.installedSlotCount();
  const bellsMissing = !fs.existsSync(bank.sigFile(CTL_LONG));
  const { made, pruned } = bank.install();
  if (had > slots) bank.removeSlots(slots);
  console.log(`${C.g('✓')} ${slots} live-update slots ready ${C.d(`(${made} files written${pruned ? `, ${pruned} unused signal files removed` : ''})`)}`);

  const { signals: _legacySignals, ...rest } = cfg;
  const next = { ...rest, wowDir, addonsDir, slots };
  writeConfig(next);

  await checkOpenBot();

  if (!args['no-service']) {
    if (!service.install()) {
      console.log(C.r(`✗ The bridge's ${service.kind} didn't start (the error is above). Fix that, then run \`openbot-wow install\` again.`));
      process.exitCode = 1;
      return;
    }
    console.log(`${C.g('✓')} Bridge running as the ${service.name} ${service.kind}`);
    if (MAC) console.log(`${C.y('!')} The bridge reads the game's pixels, so macOS asks for Screen Recording permission the first time.`);
  }

  console.log('');
  await firstLaunch({
    restart: freshAddon || had < slots || bellsMissing,
    running: !!findWowProcess(),
    waiting: !args['no-service'] && process.stdin.isTTY && process.stdout.isTTY,
    since: Date.now(),
  });
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
}

// OpenBot's side: the bridge reads chats from its database and sends through Local
// scripts. Say what works now and what to switch on.
async function checkOpenBot() {
  const file = databaseFile();
  if (!fs.existsSync(file)) {
    console.log(C.r(`✗ OpenBot's database isn't at ${file}. Install and open OpenBot first (or set OPENBOT_HOME).`));
    process.exitCode = 1;
    return;
  }
  console.log(`${C.g('✓')} OpenBot found ${C.d(`(chats are read from ${file}, read-only)`)}`);
  const ob = new OpenBotClient({ stateDir: STATE_DIR });
  await ob.open();
  if (!ob.db) {
    console.log(C.r(`✗ ${ob.error}`));
    process.exitCode = 1;
    return;
  }
  ob.reload();
  await ob.refreshApi();
  const agents = ob.apiStatus().agents;
  const on = agents.filter((a) => a.localScripts).map((a) => a.name);
  const off = agents.filter((a) => !a.localScripts).map((a) => a.name);
  ob.stop();
  if (on.length) console.log(`${C.g('✓')} Local scripts on for ${on.join(', ')} ${C.d('(you can message and answer these from the game)')}`);
  if (off.length) {
    console.log(`${C.y('!')} Local scripts off for ${off.join(', ')}: you can read these in game, but not message them.`);
    console.log(C.d('  To message an agent from the game: OpenBot > the agent\'s settings > turn on Local scripts.'));
    console.log(C.d('  Each message from the game counts toward the agent\'s Local scripts limit (30 an hour unless you raise it).'));
  }
}

// After installing: say exactly what to do in the game, then wait (Enter skips) until
// the addon checks in, so you know it works before you go looking for it.
async function firstLaunch({ restart, running, waiting, since }) {
  let step;
  if (restart) step = running ? 'Quit World of Warcraft completely and start it again, then log in to a character.' : 'Start World of Warcraft: Forever and log in to a character.';
  else step = running ? 'Type /reload in game.' : 'Start World of Warcraft: Forever and log in to a character.';
  console.log(`${C.b('Next:')} ${step}`);
  if (restart && running) console.log(C.d('  The game only finds new addon files when it starts, so a /reload isn\'t enough this time.'));

  let connected = null;
  if (waiting) {
    let skipped = false;
    process.stdin.resume();
    process.stdin.once('data', () => {
      skipped = true;
    });
    let shown = '';
    const until = Date.now() + 20 * 60 * 1000;
    while (!skipped && Date.now() < until) {
      const st = readStatus();
      if (st?.addon && st.addon.lastSeen >= since) {
        connected = st;
        break;
      }
      const blocked = st?.capture?.state === 'error' && st.capture.lastError === SCREEN_PERMISSION_HELP;
      const msg = blocked
        ? 'Waiting for Screen Recording permission (see above)… (Enter to skip)'
        : st?.wow ? 'World of Warcraft is running. Waiting for you to log in… (Enter to skip)' : 'Waiting for World of Warcraft to start… (Enter to skip)';
      if (msg !== shown) {
        if (blocked) process.stdout.write(`\r\x1b[2K${C.y(SCREEN_PERMISSION_HELP)}\n`);
        process.stdout.write(`\r\x1b[2K${C.d(msg)}`);
        shown = msg;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    process.stdin.pause();
    process.stdout.write('\r\x1b[2K');
    if (connected) {
      // The first hello can arrive before the addon has its link keys; give it a moment.
      for (let i = 0; i < 8 && !readStatus()?.addon?.encrypted; i++) await new Promise((r) => setTimeout(r, 1000));
      const enc = readStatus()?.addon?.encrypted;
      console.log(`${C.g('✓')} Connected: the game and the bridge are talking${enc ? ' over an encrypted link' : ''}.`);
    } else if (!skipped) {
      console.log(C.y('The game hasn\'t checked in yet. Once you\'re in, `openbot-wow status` shows whether it connected.'));
    }
  }
  console.log(`
${C.b('In game')}
  /ob                       open or close OpenBot (or click its button on the minimap)
  both triggers + Back      open it from a controller
  /ob selftest              check the link step by step if something seems off

${C.b('From here')}
  openbot-wow status           what the bridge sees
  rerun the install command   update
  openbot-wow uninstall        remove everything`);
}

function cmdSync(args) {
  const cfg = readConfig();
  const addonsDir = cfg.addonsDir || addonsDirOf(resolveWowDir(args, cfg));
  // The game only discovers new addon folders and sound files when it starts.
  const freshAddon = !fs.existsSync(path.join(addonsDir, ADDON, `${ADDON}.toc`));
  const dst = syncAddon(addonsDir);
  console.log(`${C.g('✓')} Addon code copied to ${dst}. Type /reload in game.`);
}

async function cmdRun(args) {
  const cfg = readConfig();
  const addonsDir = cfg.addonsDir || addonsDirOf(resolveWowDir(args, cfg));
  const bridge = new Bridge({ addonsDir, config: { ...cfg, verbose: args.verbose || cfg.verbose } });
  const stop = () => {
    bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await bridge.start();
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

function cmdStatus(args) {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'status.json'), 'utf8'));
  } catch {
    console.log(C.r('The bridge has not run yet.'), 'Start it with `openbot-wow install` or `openbot-wow run`.');
    process.exitCode = 1;
    return;
  }
  if (args.json) return console.log(JSON.stringify(st, null, 2));
  const age = Date.now() - Date.parse(st.at);
  const alive = age < 10000;
  const ok = (b) => (b ? C.g('●') : C.r('●'));
  console.log(`${ok(alive)} Bridge ${st.version} ${alive ? `running (pid ${st.pid})` : `not running (last seen ${ago(age)})`}`);
  const up = st.update;
  if (up?.available) console.log(`${C.y('●')} Update available: ${up.available} new change${up.available === 1 ? '' : 's'} on GitHub ${C.d('(git pull && ./install.sh, then /reload in game)')}`);
  else if (up && !up.enabled) console.log(C.d('  Update check: off'));
  const ob = st.openbot || {};
  console.log(`${ok(ob.state === 'connected')} OpenBot: ${ob.state}${ob.error ? ` — ${ob.error}` : ''} ${C.d(`(${ob.threads ?? 0} threads; this computer ${ob.via === 'relay' ? 'through the OpenBot relay' : `from ${ob.database || 'its database'}`})`)}`);
  if (ob.account?.signedIn) {
    for (const sv of ob.servers || []) console.log(`${ok(sv.state === 'connected')} Server ${sv.label}: ${sv.state}${sv.error ? ` — ${sv.error}` : ''} ${C.d(`(${sv.threads} threads)`)}`);
    if (ob.account.error) console.log(`${ok(false)} Servers: ${ob.account.error}`);
    if (!(ob.servers || []).length && !ob.account.error) console.log(`${C.d('  No other servers to show (openbot-wow servers lists them).')}`);
  } else console.log(C.d('  Other OpenBot servers: not signed in (openbot-wow login)'));
  const ls = ob.localScripts;
  if (ls && ob.via === 'relay') console.log(C.d('  Local scripts: not needed while the bridge is signed in'));
  else if (ls) {
    const on = (ls.agents || []).filter((a) => a.localScripts).map((a) => a.name);
    console.log(`${ok(on.length > 0)} Local scripts: ${on.length ? `on for ${on.join(', ')}` : ls.error || 'off for every agent'}${on.length ? '' : C.d(' (turn it on in an agent\'s settings to message it from the game)')}`);
  }
  console.log(`${ok(!!st.wow)} WoW: ${st.wow ? `running (pid ${st.wow.pid})` : 'not running'}`);
  console.log(`${ok(st.capture.state === 'ok' || st.capture.state === 'idle')} Screen link: ${st.capture.state} via ${st.capture.backend} ${C.d(`(${st.capture.decoded} frames read, ${st.capture.rejected} rejected)`)}${st.capture.lastError ? `\n    ${C.y(st.capture.lastError)}` : ''}`);
  if (st.addon) {
    console.log(`${ok(true)} Addon ${st.addon.version}: last heard ${ago(Date.now() - st.addon.lastSeen)}; window ${st.addon.flags.includes('o') ? 'open' : 'closed'}`);
    console.log(`${ok(st.addon.encrypted)} Link ${st.addon.encrypted ? 'encrypted' : 'not encrypted yet (waiting for the addon to load its keys)'}${st.rejected?.forged ? C.d(` · ${st.rejected.forged} unauthenticated frames ignored`) : ''}`);
  } else {
    console.log(`${ok(false)} Addon: not heard from yet ${C.d('(log in, then /ob)')}`);
  }
  console.log(`  Live updates left this session: ${st.slots.remaining}/${st.slots.total} ${C.d(`· ${st.publishes} updates sent · update bell #${st.signals.next}`)}`);
  console.log(`  Speech: ${st.voice.tts || C.y('none')} · Dictation: ${st.voice.dictation || C.y('none')}`);
  if (st.voice.hint) console.log(`    ${C.d(st.voice.hint)}`);
  if (args.log || args.v) {
    console.log('');
    for (const l of st.log) console.log(C.d(l));
  }
}

async function cmdProbe() {
  const proc = findWowProcess();
  const cap = new StripCapture({});
  console.log(`backend: ${cap.resolveBackend()}; WoW pid: ${proc?.pid ?? 'not running'}`);
  const res = await cap.grab(proc?.pid);
  if (res.status !== 'ok') return console.log(`capture: ${res.status}`);
  const out = path.join(os.tmpdir(), 'openbot-wow-probe.ppm');
  const img = res.image;
  fs.writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${img.width} ${img.height}\n255\n`), Buffer.from(img.data)]));
  let png = out;
  try {
    execFileSync('magick', [out, out.replace(/\.ppm$/, '.png')]);
    png = out.replace(/\.ppm$/, '.png');
  } catch {}
  const dec = decodeImage(img, null, { searchY: res.searchY });
  console.log(`captured ${img.width}x${img.height} -> ${png}`);
  if (!dec) console.log('no strip visible (open the OpenBot window in game, or send something)');
  else if (dec.error) console.log(`strip found but unreadable: ${dec.error} (cell ${dec.geo.cell}px at ${dec.geo.ox},${dec.geo.oy})`);
  else console.log(`strip decoded: seq ${dec.seq}, ${dec.payload.length} bytes, cell ${dec.geo.cell}px at ${dec.geo.ox},${dec.geo.oy}`);
}

async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// Remove everything install put on this computer.
async function cmdUninstall(args) {
  const cfg = readConfig();
  if (!args.yes) {
    console.log('This removes OpenBot for World of Warcraft: the addon and its update folders, its settings in the game,');
    console.log('the bridge service and its files. OpenBot itself and your chats stay as they are.');
    if (!(await ask('Remove it? [y/N] '))) {
      console.log(process.stdin.isTTY ? 'Nothing removed.' : 'Nothing removed. Run `openbot-wow uninstall --yes` to remove without asking.');
      return;
    }
  }
  const done = (msg) => console.log(`${C.g('✓')} ${msg}`);
  const warn = (msg) => console.log(`${C.y('!')} ${msg}`);

  if (fs.existsSync(service.file)) {
    service.remove();
    done('Stopped and removed the bridge service');
  }

  let wowDir = cfg.wowDir;
  if (!wowDir) {
    try {
      wowDir = findWowInstalls().forever[0];
    } catch {}
  }
  const addonsDir = cfg.addonsDir || (wowDir && addonsDirOf(wowDir));
  if (addonsDir && fs.existsSync(addonsDir)) {
    const n = new SlotBank(addonsDir).removeSlots(0);
    fs.rmSync(path.join(addonsDir, ADDON), { recursive: true, force: true });
    done(`Removed the addon and ${n} update folders from the game`);
  }
  if (wowDir) {
    // The addon's saved settings (account-wide SavedVariables).
    let removed = 0;
    const accounts = path.join(wowDir, 'WTF', 'Account');
    try {
      for (const acct of fs.readdirSync(accounts)) {
        for (const f of [`${ADDON}.lua`, `${ADDON}.lua.bak`]) {
          const p = path.join(accounts, acct, 'SavedVariables', f);
          if (fs.existsSync(p)) {
            fs.rmSync(p);
            removed++;
          }
        }
      }
    } catch {}
    if (removed) done('Removed its saved settings from the game');
  }

  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  done('Removed the bridge\'s settings and state');

  try {
    if (fs.lstatSync(BIN_LINK).isSymbolicLink() && fs.readlinkSync(BIN_LINK).startsWith(DATA_DIR)) fs.rmSync(BIN_LINK);
  } catch {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  done('Removed the openbot-wow command and its files');

  if (findWowProcess()) console.log(`\nWorld of Warcraft is running: ${C.b('/reload')} or restart it to finish unloading OpenBot.`);
}

async function prompt(question) {
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

function restartIfInstalled() {
  if (fs.existsSync(service.file)) service.restart();
}

// The bridge's own OpenBot sign-in, for showing the account's other servers in game.
async function cmdLogin(args) {
  if (!process.stdin.isTTY) throw new Error('run `openbot-wow login` in a terminal: it asks for the code from your email');
  const email = String(args.email || (await prompt('OpenBot account email: ')));
  if (!email.includes('@')) throw new Error('that is not an email address');
  const challenge = await startSignIn(email);
  const code = await prompt(`Code from the email sent to ${email}: `);
  await finishSignIn(email, challenge, code);
  console.log(`${C.g('✓')} Signed in. The bridge has its own session on your account ${C.d('(revoke it in OpenBot, or run openbot-wow logout)')}.`);
  restartIfInstalled();
  console.log(`  Your servers show in game within a minute. ${C.d('openbot-wow servers lists them.')}`);
}

async function cmdLogout() {
  await signOut();
  console.log(`${C.g('✓')} Signed out. Only this computer's agents show in game now.`);
  restartIfInstalled();
}

async function cmdServers() {
  const account = readAccount();
  if (!account) {
    console.log('Not signed in, so only this computer\'s agents show in game. Sign in with `openbot-wow login`.');
    return;
  }
  let team;
  try {
    team = await import('../dist/team.mjs');
  } catch {
    throw new Error('the server client is not built: run `npm install && npm run build:team` in the bridge folder');
  }
  const directory = team.createDirectory({ apiUrl: API_URL, sessionToken: account.sessionToken, configDir: CONFIG_DIR });
  const hosts = await directory.listHosts();
  const cfg = readConfig();
  let self = [];
  try {
    self = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'servers.json'), 'utf8')).self || [];
  } catch {}
  console.log(`${C.b(account.email || 'OpenBot account')} ${C.d(`(${API_URL})`)}`);
  for (const h of hosts) {
    const note = self.includes(h.hostId) ? C.g('this computer, through the relay') : wanted(h, cfg) ? C.g('shown in game') : C.y('hidden (config)');
    console.log(`  ${h.name} ${C.d(`· ${h.role}${h.hosted ? ' · hosted' : ''}`)} — ${note}`);
  }
  if (!hosts.length) console.log(C.d('  No servers on this account.'));
}

function help() {
  console.log(`${C.b('openbot-wow')} ${VERSION} — OpenBot inside World of Warcraft: Forever

  openbot-wow install [--wow DIR] [--slots N] [--no-service]
                     Install the addon, its live-update slots and the bridge service
  openbot-wow status [--log] [--json]
                     Show what the bridge sees
  openbot-wow sync        Re-copy the installed addon into the game (to update, rerun the install command)
  openbot-wow run [--verbose]
                     Run the bridge in the foreground (the service runs this)
  openbot-wow login       Sign the bridge in to your OpenBot account, to show your other servers too
  openbot-wow logout      Sign it out again (only this computer's agents show)
  openbot-wow servers     List your OpenBot servers and which show in game
  openbot-wow probe       Capture the corner of the game window and try to read the strip
  openbot-wow uninstall [--yes]
                     Remove the addon, its settings, the service and its files`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const commands = { login: cmdLogin, logout: cmdLogout, servers: cmdServers, install: cmdInstall, run: cmdRun, status: cmdStatus, sync: cmdSync, probe: cmdProbe, uninstall: cmdUninstall };
if (!cmd || args.help || !commands[cmd]) {
  help();
  if (cmd && !commands[cmd]) process.exitCode = 1;
} else {
  Promise.resolve(commands[cmd](args)).catch((err) => {
    console.error(C.r(`✗ ${err.message}`));
    process.exitCode = 1;
  });
}
