// The bridge's own OpenBot account session, used to reach the account's other servers
// through OpenBot's relay. `openbot-wow login` makes it with an email code, as signing in
// on a new device does; it shows in the account's sessions and can be revoked there.
// The token is kept in ~/.config/openbot-wow/account.json, mode 0600.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from './paths.js';

export const API_URL = process.env.OPENBOT_API_URL || 'https://api.openbot.run';
export const ACCOUNT_FILE = path.join(CONFIG_DIR, 'account.json');

export function readAccount() {
  try {
    const a = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    return typeof a.sessionToken === 'string' && a.sessionToken ? a : null;
  } catch {
    return null;
  }
}

export function saveAccount(account) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = ACCOUNT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(account), { mode: 0o600 });
  fs.renameSync(tmp, ACCOUNT_FILE);
}

async function post(pathname, body, token) {
  const res = await fetch(new URL(pathname, API_URL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(20000),
  });
  const value = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(value?.message || value?.error || `OpenBot's account service answered HTTP ${res.status}`);
  return value;
}

// Sends the sign-in code to `email`; returns the challenge to verify.
export async function startSignIn(email) {
  const start = await post('/v1/auth/email/start', { email });
  if (typeof start.challengeId !== 'string') throw new Error("OpenBot didn't start the sign-in.");
  return start.challengeId;
}

export async function finishSignIn(email, challengeId, code) {
  const done = await post('/v1/auth/email/verify', { challengeId, code });
  if (typeof done.sessionToken !== 'string') throw new Error("OpenBot didn't return a session.");
  saveAccount({ sessionToken: done.sessionToken, email, at: new Date().toISOString() });
}

// Ends the session at OpenBot, then forgets it here.
export async function signOut() {
  const a = readAccount();
  if (a) await post('/v1/auth/logout', {}, a.sessionToken).catch(() => {});
  fs.rmSync(ACCOUNT_FILE, { force: true });
}
