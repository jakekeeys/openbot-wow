#!/bin/bash
# Install or update OpenBot for World of Warcraft, from this checkout:
#
#   ./install.sh [--wow "/path/to/World of Warcraft"] [--slots N] [--no-service]
#
# Run it again to update. It copies the bridge and addon to ~/.local/share/openbot-wow,
# puts `openbot-wow` on your PATH, then runs `openbot-wow install`, which installs the
# addon into the game, checks OpenBot, starts the bridge as a user service and walks you
# through the first launch.
set -euo pipefail

dest="${XDG_DATA_HOME:-$HOME/.local/share}/openbot-wow"
bin="$HOME/.local/bin"

if ! command -v node >/dev/null 2>&1; then
  if [[ $(uname -s) == "Darwin" ]]; then
    echo "OpenBot for World of Warcraft needs Node.js 22.13 or newer: brew install node (or mise use -g node@lts)." >&2
  else
    echo "OpenBot for World of Warcraft needs Node.js 22.13 or newer: mise use -g node@lts (or pacman -S nodejs)." >&2
  fi
  exit 1
fi
# The bridge reads OpenBot's database with node:sqlite (Node 22.13 and later).
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; then
  echo "OpenBot for World of Warcraft needs Node.js 22.13 or newer; found $(node --version)." >&2
  exit 1
fi

# KDE Plasma doesn't need grim: the bridge reads the game through KWin's D-Bus API.
if [[ ${XDG_SESSION_TYPE:-} == "wayland" && :${XDG_CURRENT_DESKTOP:-}: != *:KDE:* ]] && ! command -v grim >/dev/null 2>&1; then
  echo "Note: install grim so the bridge can see the game (pacman -S grim)." >&2
fi

# Install from this checkout.
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -d "$src/bridge" || ! -d "$src/addon" ]]; then
  echo "Run install.sh from an openbot-wow checkout (it needs bridge/ and addon/ next to it)." >&2
  exit 1
fi

# The client for OpenBot's relay (bridge/dist/team.mjs) is built from OpenBot's own client code at a
# pinned commit, fetched from GitHub, so it isn't in this repository. Build it once, or after an
# update that changes bridge/team/. Without it, the bridge reads this computer's OpenBot only.
if [[ ! -f "$src/bridge/dist/team.mjs" || -n "$(find "$src/bridge/team" -newer "$src/bridge/dist/team.mjs" -type f -print -quit)" ]]; then
  echo "Building the client for OpenBot's relay (fetches OpenBot's client code once)…"
  if ! (cd "$src/bridge" && npm install --no-audit --no-fund --loglevel=error >/dev/null && npm run --silent build:team); then
    echo "Note: couldn't build it, so only this computer's agents will show. Run 'npm install && npm run build:team' in bridge/ to see why." >&2
  fi
fi

mkdir -p "$dest" "$bin"
rm -rf "$dest/bridge.new" "$dest/addon.new"
mkdir -p "$dest/bridge.new"
# The checkout's node_modules holds build tools; the installed copy gets only what it runs with.
tar -C "$src/bridge" --exclude=./node_modules --exclude=./dist/spike.mjs -cf - . | tar -C "$dest/bridge.new" -xf -
cp -r "$src/addon" "$dest/addon.new"
# Stamp the version with the commit this comes from, so the bridge can tell when GitHub has newer
# changes, and the addon when it's not the bridge's version (a /reload away).
base="$(node -p 'require(process.argv[1]).version' "$src/bridge/package.json")"
commit="$(git -C "$src" rev-parse HEAD 2>/dev/null || true)"
dirty=false
if [[ -n $commit && -n "$(git -C "$src" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then dirty=true; fi
version="$base"
if [[ -n $commit ]]; then
  version="$base+${commit:0:7}"
  if [[ $dirty == true ]]; then version="$version.dirty"; fi
  printf '{"version":"%s","commit":"%s","dirty":%s}\n' "$base" "$commit" "$dirty" > "$dest/bridge.new/build.json"
fi
node -e 'const fs = require("fs"); const [file, v] = process.argv.slice(1); fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^## Version: .*$/m, `## Version: ${v}`))' "$dest/addon.new/OpenBot/OpenBot.toc" "$version"
# Other OpenBot servers need WebRTC (node-datachannel, a prebuilt native module). Without it the
# bridge still shows this computer's agents.
if [[ -f "$dest/bridge.new/dist/team.mjs" ]]; then
  if ! (cd "$dest/bridge.new" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1); then
    echo "Note: couldn't install node-datachannel, so only this computer's agents will show (npm install failed)." >&2
  fi
fi
rm -rf "$dest/bridge" "$dest/addon"
mv "$dest/bridge.new" "$dest/bridge"
mv "$dest/addon.new" "$dest/addon"
chmod +x "$dest/bridge/bin/openbot-wow.js"
ln -sf "$dest/bridge/bin/openbot-wow.js" "$bin/openbot-wow"
if [[ ":$PATH:" != *":$bin:"* ]]; then
  echo "Note: $bin isn't on your PATH, so run openbot-wow as $bin/openbot-wow (or add $bin to PATH in your shell profile)." >&2
fi

node "$dest/bridge/bin/openbot-wow.js" install "$@"
