# OpenBot for World of Warcraft

Read, message and steer your [OpenBot](https://github.com/nightly-labs/openbot) agents without leaving the game. A native addon for **World of Warcraft: Forever**, plus a small bridge on your computer that connects it to OpenBot: this computer's agents and those on every OpenBot server you're a member of.

It's a port of Ryan Hughes's [T3 Code for World of Warcraft](https://github.com/ryanrhughes/t3code-wow) (v0.3.0). The addon, the screen link, the update slots, controller support and voice are his work. This fork replaces the T3 Code backend with OpenBot.

> [!WARNING]
> **Early and experimental.** Built and tested on **Omarchy** (Hyprland) with **OpenBot 0.66–0.69** and **WoW: Forever 1.60.x** under Proton. The original's macOS, KDE Plasma and Windows code is still in the bridge but hasn't been tried with this fork.

## What it does

- **OpenBot window** (`/ob`): every agent's main chat and its open side threads, grouped into Working, Open and Settled. Read a thread, message an agent, steer a working one, stop a run, answer its questions and approve its requests.
- **Server picker**: above the agent list, pick this computer, one of your OpenBot servers, or all of them. The agent list, the thread list and Message Agent then cover only that server. An offline server stays in the picker with its error. With all servers shown, agents on a server read "Name · Server"; the tracker and notices name the server whenever it isn't the one you picked.
- **Quest tracker**: what's running, what needs you and what just finished, under your quests.
- **Notices**: a toast, a sound and a chat line when an agent finishes or needs you. They wait until combat ends.
- **Models**: pick an agent's model and reasoning level from the server's own model list.
- **Screenshots**: attach what's on your screen to a message.
- **Controller support** and **voice** (dictation with Omarchy, replies read aloud), as in the original.
- **Usage**: your providers' limits, from Omarchy's Agents panel.

## How it reaches OpenBot

The bridge signs in to your OpenBot account as a device of its own (`openbot-wow login`, with an email code). It then uses OpenBot's own client code, the same code as OpenBot's phone and web apps, to reach every server on your account through OpenBot's relay, including this computer's OpenBot (listed as "Desktop"). That's the full feature set everywhere.

Without a sign-in, or while the relay to this computer has been down for a minute, the bridge reads this computer's OpenBot directly instead: its database, read-only, plus OpenBot's **Local scripts** API for sending. That mode is more limited:

| | Signed in (relay) | Not signed in (this computer only) |
| --- | --- | --- |
| Read chats and side threads | ✓ | ✓ |
| Message an agent's main chat | ✓ | ✓ with Local scripts on for that agent |
| Reply in a side thread | ✓ | — |
| Stop a run | ✓ | — |
| Answer questions and approvals | ✓ | ✓ with Local scripts on |
| Model list | ✓ server's list | — only models agents use, plus your config |
| Other OpenBot servers | ✓ | — |

Settled, archived and read-in-game marks are kept by the bridge. A new run brings a thread back.

## Requirements

- **OpenBot** on this computer (for this computer's agents), and an OpenBot account to sign the bridge in to.
- **World of Warcraft: Forever**, installed with Battle.net.
- **Node.js 22.13** or newer, and **git** (the first install fetches OpenBot's client code to build the relay client).
- **grim** on Hyprland, so the bridge can see the game.
- **Game sound on.** The addon learns about updates through silent sounds; with sound off it falls back to slower polling.

## Install

```bash
git clone https://github.com/jakekeeys/openbot-wow
cd openbot-wow
./install.sh
openbot-wow login
```

`install.sh` builds the relay client, finds WoW: Forever (for anything unusual, add `--wow "/path/to/World of Warcraft"`), installs the addon and its update folders into the game, and starts the bridge as the `openbot-wow` user service. `openbot-wow login` asks for your OpenBot email and the code it sends. Run it in a terminal.

The first time, **fully quit and restart World of Warcraft**: the game only finds new addon folders when it starts. After that, `/reload` is enough.

To update: `git pull && ./install.sh`, then `/reload`.

## Using it

- `/ob` opens the window. The minimap button and the game menu do too, and from a controller: hold both triggers and press Back.
- Pick a thread on the left to read it; type below to reply. A message to a working agent steers its current run.
- Pick a server at the top of the list, then an agent if you like. Your picks are kept.
- **Message Agent** writes to an agent's main chat on the picked server: the agent you filtered to, else the last one you messaged there. Pick another agent (and, if you like, its model) in the header.
- The ✕ next to Back stops the run you're reading.
- `/ob selftest` checks the link step by step; `/ob report` puts diagnostics and a screenshot into the message box.

## Commands

```
openbot-wow status [--log]   what the bridge sees: OpenBot, your servers, the game, the screen link, the addon
openbot-wow login            sign the bridge in to your OpenBot account (email code)
openbot-wow logout           end its session; only this computer's agents show
openbot-wow servers          your OpenBot servers and which show in game
openbot-wow probe            capture the corner of the game window and try to read the strip
openbot-wow uninstall        remove the addon, its settings, the service and the bridge's files
```

The bridge's session appears with your other OpenBot sign-ins, and you can revoke it there too.

### Settings

`~/.config/openbot-wow/config.json` (the installer writes the WoW paths):

- `servers`: show only these servers, by name, e.g. `["Homelab"]`.
- `hideServers`: hide these servers.
- `models`: extra models for the picker when not signed in, as `[{ "provider": "claude", "model": "claude-sonnet-5-5", "name": "Sonnet 5.5", "efforts": ["low", "high"] }]`.
- `screenshotDir`: where screenshots go when not signed in (default `~/OpenBot/Shared/wow-screenshots`, which agents can open).
- `sideThreads`: how many recent side threads per agent to show when not signed in (60).

## When something's wrong

1. `openbot-wow status --log`: is the bridge running, connected to OpenBot and your servers, and does it see the game?
2. In game, `/ob selftest` checks each step between the game and the bridge.
3. **"Bridge not responding"** while the window shows threads: the bridge can't read the strip in the top-left corner. Something drawn there, such as an FPS counter, hides it. Move or turn off that overlay.
4. A thread stuck on **Loading…** after the bridge restarted or switched between the relay and the database: pick it again from the list.

## How it works

Addons can't open network connections or read files, so the addon and the bridge talk through what the game allows:

| Direction | How |
| --- | --- |
| Game → bridge | A small strip of coloured squares in the top-left corner for about a second after you do something, encrypted and authenticated. The bridge reads it with a screen capture. |
| Bridge → game | Load-on-demand "slot" addons: the bridge writes a fresh snapshot into the next one the game will load. |
| "New data" signal | Large silent sound files the bridge fills or empties. The game re-reads big sounds every time it plays them, so the addon knows when to load the next slot. |

The bridge (`bridge/`) is Node. `src/fleet.js` puts this computer and your servers behind one interface; `team/src/` is the relay client, bundled with OpenBot's client code into `dist/team.mjs` by `npm run build:team`; `src/openbot.js` is the database and Local scripts fallback. Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Privacy notes:
- The slots hold the latest snapshot, including message text, as Lua files under the game's `Interface/AddOns/OpenBot_S###`.
- Screen streams and recordings show the strip, which is why it's encrypted.
- The addon never sends anything to Blizzard. The bridge doesn't read game memory or press keys.

Don't run it next to T3 Code for World of Warcraft: both draw their strip in the same corner.

## Development

```bash
cd bridge
npm install && npm run build:team   # the relay client (fetches OpenBot's code at the pinned commit)
npm test                            # bridge, protocol, crypto, relay client against a fake server
node ../tools/snapshot.mjs /tmp/obsnap.lua
lua5.1 ../tools/smoke.lua ../addon/OpenBot /tmp/obsnap.lua "$(cat /tmp/obsnap.view)"
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and, for coding agents, [AGENTS.md](AGENTS.md). The OpenBot commit is pinned in `bridge/team/build.mjs`; bump it when servers move to a newer protocol.

## Credits

- [Ryan Hughes](https://github.com/ryanrhughes) wrote [T3 Code for World of Warcraft](https://github.com/ryanrhughes/t3code-wow), which this is built from.
- [wow-ai](https://github.com/chelinho139/wow-ai) and [wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) measured how the Forever client loads files, plays sounds and handles the gamepad.
- The relay client uses [OpenBot](https://github.com/nightly-labs/openbot)'s own client packages.

## License

This repository is [MIT](LICENSE).

The relay client the installer builds (`bridge/dist/team.mjs`) bundles OpenBot's code, which is under the [PolyForm Noncommercial License 1.0.0](https://github.com/nightly-labs/openbot/blob/main/LICENSE). That code isn't in this repository: the build fetches it from OpenBot's repository at a pinned commit and puts its license and notice next to the build (`bridge/team/OPENBOT-LICENSE`, `OPENBOT-NOTICE`). Use the built client for noncommercial purposes only.

A fan project, not affiliated with or endorsed by Blizzard Entertainment or OpenBot. World of Warcraft is a trademark of Blizzard Entertainment.
