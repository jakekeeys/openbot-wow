// The bridge's version. The installer stamps build.json with the commit it installed from,
// so the version reads like 0.1.0+d47b4c3 (".dirty" when the checkout had uncommitted changes).
// Run from a checkout, there's no stamp and the version is package.json's.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readBuild(root = ROOT) {
  let base = '0.0.0';
  try {
    base = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || base;
  } catch {}
  try {
    const b = JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8'));
    const commit = typeof b.commit === 'string' && /^[0-9a-f]{7,40}$/.test(b.commit) ? b.commit : null;
    return { base, commit, dirty: commit ? b.dirty === true : false };
  } catch {
    return { base, commit: null, dirty: false };
  }
}

export function versionOf(build) {
  return build.commit ? `${build.base}+${build.commit.slice(0, 7)}${build.dirty ? '.dirty' : ''}` : build.base;
}

export const BUILD = readBuild();
export const VERSION = versionOf(BUILD);
