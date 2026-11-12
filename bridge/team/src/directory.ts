// The account's server list and session tickets, through OpenBot's own directory client.
import fs from "node:fs";
import path from "node:path";
import { runTeamEffect } from "@openbot/team-client";
import { verifyEd25519Base64Url } from "@openbot/team-client/ed25519";
import { RemoteTeamDirectoryClient, type RemoteTeamHost } from "@openbot/team-client/remote-directory";

export type Host = RemoteTeamHost;

export interface Directory {
  listHosts(): Promise<Host[]>;
  createBootstrap(hostId: string, clientPublicKey: string, existingSessionId: string | null): Promise<{ sessionId: string; signalUrl: string; ticket: string }>;
  endSession(sessionId: string): Promise<void>;
}

// Host keys are pinned on first use, as OpenBot's apps do, so a changed key is noticed.
function fileHostKeys(file: string) {
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  };
  return {
    get: async (hostId: string) => read()[hostId] ?? null,
    set: async (hostId: string, key: string) => {
      const all = read();
      all[hostId] = key;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(all, null, 1), { mode: 0o600 });
    },
  };
}

export function createDirectory(input: { apiUrl: string; sessionToken: string; configDir: string; log?: (line: string) => void }): Directory {
  const client = new RemoteTeamDirectoryClient({
    apiUrl: input.apiUrl,
    token: input.sessionToken,
    fetch: (url, init) => fetch(url, init),
    hostKeys: fileHostKeys(path.join(input.configDir, "host-keys.json")),
    verifyHostKeySignature: verifyEd25519Base64Url,
  });
  return {
    listHosts: () => runTeamEffect(client.listHosts()),
    createBootstrap: (hostId, key, existing) => runTeamEffect(client.createBootstrap(hostId, key, existing)),
    endSession: (sessionId) => runTeamEffect(client.endSession(sessionId)),
  };
}
