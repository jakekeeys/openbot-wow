import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startUpdateCheck } from '../src/update.js';
import { readBuild, versionOf } from '../src/version.js';

const COMMIT = 'd47b4c3b03aa38d8ac3017691ba3ca03b8d9b61a';
const answer = (status, body = {}) => async () => ({ ok: status < 400, status, json: async () => body });

test('the installed commit is compared with the branch on GitHub; new changes are its ahead_by', async () => {
  const urls = [];
  const changes = [];
  const u = startUpdateCheck({
    build: { commit: COMMIT },
    fetchImpl: async (url, init) => (urls.push([url, init.headers['user-agent']]), answer(200, { status: 'ahead', ahead_by: 3, behind_by: 0 })()),
    onChange: (s) => changes.push(s.available),
    firstMs: 1e9,
  });
  await u.check();
  assert.deepEqual(urls, [[`https://api.github.com/repos/jakekeeys/openbot-wow/compare/${COMMIT}...openbot`, 'openbot-wow']]);
  assert.equal(u.status().available, 3);
  assert.deepEqual(changes, [3]);
  await u.check();
  assert.deepEqual(changes, [3], 'no change, no event');
  u.stop();
});

test('a commit GitHub does not know is no news, and a failure keeps the last answer', async () => {
  let reply = answer(200, { ahead_by: 2 });
  const u = startUpdateCheck({ build: { commit: COMMIT }, fetchImpl: (...a) => reply(...a), firstMs: 1e9 });
  await u.check();
  reply = answer(500);
  await u.check();
  assert.equal(u.status().available, 2);
  assert.match(u.status().error, /HTTP 500/);
  reply = answer(404);
  await u.check();
  assert.equal(u.status().available, 0);
  assert.equal(u.status().error, null);
  u.stop();
});

test('no check when it is turned off or there is no installed commit', async () => {
  let calls = 0;
  const fetchImpl = async () => (calls++, answer(200, { ahead_by: 1 })());
  for (const u of [startUpdateCheck({ build: { commit: COMMIT }, config: { updateCheck: false }, fetchImpl, firstMs: 1 }), startUpdateCheck({ build: { commit: null }, fetchImpl, firstMs: 1 })]) {
    await new Promise((r) => setTimeout(r, 20));
    await u.check();
    assert.equal(u.status().enabled, false);
    u.stop();
  }
  assert.equal(calls, 0);
});

test('the version is package.json\'s, plus the installed commit when the installer stamped one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obwow-version-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  assert.equal(versionOf(readBuild(dir)), '0.1.0');
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ version: '0.1.0', commit: COMMIT, dirty: false }));
  assert.equal(versionOf(readBuild(dir)), '0.1.0+d47b4c3');
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ version: '0.1.0', commit: COMMIT, dirty: true }));
  assert.equal(versionOf(readBuild(dir)), '0.1.0+d47b4c3.dirty');
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ commit: 'not a commit' }));
  assert.equal(readBuild(dir).commit, null);
});
