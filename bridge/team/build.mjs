// Builds dist/team.mjs: the bridge's client for OpenBot servers, made from OpenBot's own client
// code (packages/team-client and what it needs) at a pinned commit, plus team/src.
//
//   npm install && npm run build:team
//
// OPENBOT_SRC points at an OpenBot checkout; without it the pinned commit is fetched into
// ~/.cache/openbot-wow/openbot-src/<commit>. OpenBot's code is under the PolyForm Noncommercial
// License 1.0.0 (team/OPENBOT-LICENSE, team/OPENBOT-NOTICE), and so is the bundle that holds it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const OPENBOT_COMMIT = "e6ed1ce1a918ca45ef19ec7db60eae3c29c1da8d";
const PACKAGES = ["contracts", "team-client", "i18n", "user-errors", "logging"];
const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.resolve(here, "..");

function source() {
  if (process.env.OPENBOT_SRC) return path.resolve(process.env.OPENBOT_SRC);
  const dir = path.join(os.homedir(), ".cache/openbot-wow/openbot-src", OPENBOT_COMMIT.slice(0, 7));
  if (fs.existsSync(path.join(dir, "packages/team-client/package.json"))) return dir;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-src-"));
  const git = (...args) => execFileSync("git", ["-C", tmp, ...args], { stdio: "inherit" });
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/nightly-labs/openbot.git");
  git("fetch", "-q", "--depth", "1", "origin", OPENBOT_COMMIT);
  git("checkout", "-q", "FETCH_HEAD");
  fs.mkdirSync(path.join(dir, "packages"), { recursive: true });
  for (const p of PACKAGES) fs.cpSync(path.join(tmp, "packages", p), path.join(dir, "packages", p), { recursive: true });
  for (const f of ["LICENSE", "NOTICE", "tsconfig.base.json"]) fs.copyFileSync(path.join(tmp, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "COMMIT"), OPENBOT_COMMIT + "\n");
  fs.rmSync(tmp, { recursive: true, force: true });
  return dir;
}

const src = source();
const scope = path.join(bridge, "node_modules/@openbot");
fs.mkdirSync(scope, { recursive: true });
for (const p of PACKAGES) {
  const link = path.join(scope, p);
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(path.join(src, "packages", p), link);
}
fs.copyFileSync(path.join(src, "LICENSE"), path.join(here, "OPENBOT-LICENSE"));
fs.copyFileSync(path.join(src, "NOTICE"), path.join(here, "OPENBOT-NOTICE"));

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node-datachannel", "node-datachannel/*"],
  nodePaths: [path.join(bridge, "node_modules")],
  banner: {
    js: [
      `// Built by team/build.mjs from OpenBot ${OPENBOT_COMMIT} (PolyForm Noncommercial 1.0.0, see team/OPENBOT-LICENSE) and team/src.`,
      "import { createRequire as __obCreateRequire } from 'node:module'; const require = __obCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
  legalComments: "none",
};
const entries = { team: "team/src/index.ts" };
for (const [name, entry] of Object.entries(entries)) {
  if (!fs.existsSync(path.join(bridge, entry))) continue;
  await build({ ...common, entryPoints: [path.join(bridge, entry)], outfile: path.join(bridge, "dist", `${name}.mjs`) });
  console.log(`built dist/${name}.mjs`);
}
