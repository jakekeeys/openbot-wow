// One OpenBot server, reached through OpenBot's relay with OpenBot's own peer client
// (packages/team-client/src/remote-peer.ts). It hands the bridge the same shapes as this
// computer's client (src/openbot.js): agents as projects, each agent's main chat and open side
// threads as threads, and a per-thread projection.
//
// It loads what the phone app loads after connecting, then keeps it current from the server's
// events: streaming text is appended in place, and a chat or task list is read again only when
// an event says it changed.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { decodeTeamProtocolSupportV9 } from "@openbot/contracts/team-protocol/v9";
import {
  createRemoteTeamPeer,
  MOBILE_ATTACHMENT_BYTES,
  type RemoteTeamCommand,
  type RemoteTeamCommandResult,
  type RemoteTeamConnectionUpdate,
  type RemoteTeamPeerActions,
} from "@openbot/team-client/remote-peer";
import type { Directory, Host } from "./directory";
import * as S from "./shapes";

type Json = unknown;
type Rec = Record<string, Json>;
type Log = (line: string) => void;
export interface PeerLike {
  execute(command: RemoteTeamCommand): Promise<RemoteTeamCommandResult>;
  dispose(): Promise<void>;
}
type PeerFactory = (actions: { current: RemoteTeamPeerActions }, options: { waitForHost: boolean }) => PeerLike;

const PAGE = 30;
const SIDE_THREADS = 20;
const isRec = (v: Json): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export class TeamRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface Chat {
  messages: S.WireMessage[];
  activeTurnId: string | null;
  progress: string | null;
  unread: number | null;
}

interface Marks {
  settled: Record<string, string>;
  archived: Record<string, string>;
  visited: Record<string, string>;
}

export class TeamHostClient extends EventEmitter {
  state: "disconnected" | "connecting" | "connected" | "offline" = "disconnected";
  error: string | null = null;
  origin: string;
  threads = new Map<string, S.Thread>();
  projects = new Map<string, { id: string; title: string }>();
  agents = new Map<string, S.Agent>();
  models: S.ModelChoice[] = [];
  capabilities = new Set<string>();
  private hidden = new Set<string>();
  private chats = new Map<string, Chat>();
  private tasks = new Map<string, S.Task[]>();
  private taskProgress = new Map<string, string>();
  private taskRevs = new Map<string, number>();
  private taskUnread = new Map<string, number>();
  private pending = new Map<string, S.Pending>();
  private peer: PeerLike | null = null;
  private requests = 0;
  private stopped = true;
  private loaded = false;
  // Events can arrive before the first load ends; nothing is announced until it has.
  private ready = false;
  private sigs = new Map<string, string>();
  private dirtyChats = new Set<string>();
  private dirtyTasks = new Set<string>();
  private dirtyAgents = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 2000;
  private marks: Marks;

  constructor(
    private readonly input: { directory: Directory; host: Host; stateDir: string; config?: Record<string, unknown>; log?: Log; createPeer?: PeerFactory },
  ) {
    super();
    this.origin = `${input.host.name} (OpenBot relay)`;
    this.marks = this.loadMarks();
  }

  private log(line: string) {
    this.input.log?.(`${this.input.host.name}: ${line}`);
  }

  private setState(state: TeamHostClient["state"], error: string | null = null) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.emit("state", state, error);
  }

  private has(capability: string) {
    return this.capabilities.has(capability);
  }

  // ---- connection ---------------------------------------------------------------------

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const { directory, host } = this.input;
    const actions: { current: RemoteTeamPeerActions } = {
      current: {
        getBootstrap: (hostId, key, existing) => directory.createBootstrap(hostId, key, existing),
        endSession: (sessionId) => directory.endSession(sessionId),
        onConnectionUpdate: async (update) => this.onConnectionUpdate(update),
        onTeamEvent: async (_hostId, event) => this.onEvent(event as unknown as Rec),
      },
    };
    const make: PeerFactory = this.input.createPeer ?? ((a, o) => createRemoteTeamPeer(a, o));
    this.peer = make(actions, { waitForHost: host.hosted === true });
    void this.connect();
  }

  stop() {
    this.stopped = true;
    for (const t of [this.flushTimer, this.retryTimer]) if (t) clearTimeout(t);
    const peer = this.peer;
    this.peer = null;
    void peer?.dispose().catch(() => undefined);
    this.setState("disconnected");
  }

  private async connect() {
    if (this.stopped || !this.peer) return;
    this.setState("connecting");
    try {
      const res = await this.peer.execute({ id: this.nextId(), type: "connect", hostId: this.input.host.hostId, hostPublicKey: this.input.host.devicePublicKey });
      if (!res.ok) throw new TeamRequestError(res.error ?? "No connection to the server.");
      await this.loadAll();
      this.backoff = 2000;
      this.setState("connected");
    } catch (err) {
      this.failed(err);
    }
  }

  private failed(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    this.log(message);
    this.setState("offline", message);
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 120_000);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private onConnectionUpdate(update: RemoteTeamConnectionUpdate) {
    if (update.state === "online") {
      if (update.resync) void this.loadAll().catch((err) => this.log(`resync: ${(err as Error).message}`));
      else if (this.loaded && this.state !== "connected") this.setState("connected");
      return;
    }
    if (update.state === "offline") {
      // The peer recovers on its own, except from these two.
      if (update.code === "session_revoked") this.stopped = true;
      this.setState("offline", update.message ?? "The server went offline.");
    }
  }

  private nextId() {
    return `wow-${++this.requests}`;
  }

  async request(method: string, pathname: string, body: Json = {}, extra: Partial<Extract<RemoteTeamCommand, { type: "request" }>> = {}): Promise<Json> {
    const peer = this.peer;
    if (!peer) throw new TeamRequestError("Not connected to the server.");
    const res = await peer.execute({ id: this.nextId(), type: "request", method, path: pathname, body: body as never, ...extra });
    if (!res.ok) throw new TeamRequestError(res.error ?? "The server didn't answer.");
    const status = res.status ?? 200;
    if (status >= 400) {
      const b = res.body as { error?: unknown } | null;
      throw new TeamRequestError(typeof b?.error === "string" ? b.error : `The server answered HTTP ${status}.`, status);
    }
    return res.body;
  }

  // ---- reading ------------------------------------------------------------------------

  // What the phone app reads after connecting, and again after a resync.
  async loadAll() {
    const support = decodeTeamProtocolSupportV9(await this.request("GET", TEAM_API_ROUTES.compatibility));
    const { minimum, maximum } = support.protocol;
    if (minimum > 3 || maximum < 3) throw new TeamRequestError("This server needs another OpenBot version.");
    this.capabilities = new Set(support.capabilities);
    await this.loadAgents();
    this.models = S.toModelChoices(await this.request("GET", TEAM_API_ROUTES.agents.models).catch(() => []));
    await this.loadReads();
    await mapLimit([...this.agents.keys()], 4, async (id) => {
      await this.loadChat(id);
      await this.loadTasks(id);
    });
    this.ready = true;
    this.rebuild();
  }

  private async loadAgents() {
    this.agents = new Map(S.toAgents(await this.request("GET", TEAM_API_ROUTES.agents.all)).map((a) => [a.id, a]));
    if (this.has("agent-hidden-v1")) {
      const body = await this.request("POST", "/v1/hidden-agents", {}).catch(() => null);
      const list = isRec(body) && Array.isArray(body.agents) ? body.agents : [];
      this.hidden = new Set(list.filter(isRec).map((h) => String(h.agentId)));
    }
    for (const id of [...this.chats.keys()]) if (!this.agents.has(id)) this.chats.delete(id);
    for (const id of [...this.tasks.keys()]) if (!this.agents.has(id)) this.tasks.delete(id);
  }

  private async loadReads() {
    const reads = await this.request("GET", TEAM_API_ROUTES.agents.conversationReads).catch(() => null);
    if (!isRec(reads)) return;
    for (const [agentId, r] of Object.entries(reads)) {
      const chat = this.chats.get(agentId);
      const unread = isRec(r) && typeof r.unreadCount === "number" ? r.unreadCount : null;
      if (chat) chat.unread = unread;
      else this.chats.set(agentId, { messages: [], activeTurnId: null, progress: null, unread });
    }
  }

  private async loadChat(agentId: string) {
    const page = await this.request("GET", `${TEAM_API_ROUTES.agent.conversationPage(agentId)}?limit=${PAGE}`);
    const chat = this.chats.get(agentId) ?? { messages: [], activeTurnId: null, progress: null, unread: null };
    chat.messages = S.toMessages(page);
    chat.activeTurnId = isRec(page) && typeof page.activeTurnId === "string" ? page.activeTurnId : null;
    if (!chat.activeTurnId) chat.progress = null;
    if (isRec(page) && isRec(page.readState) && typeof page.readState.unreadCount === "number") chat.unread = page.readState.unreadCount;
    this.chats.set(agentId, chat);
    const agent = this.agents.get(agentId);
    if (agent && isRec(page) && typeof page.threadId === "string") agent.threadId = page.threadId;
  }

  private async loadTasks(agentId: string) {
    if (!this.has("agent-tasks-v1")) return;
    const body = await this.request("POST", "/v1/agent-tasks/list", { agentId }).catch(() => null);
    if (body) this.tasks.set(agentId, S.toTasks(body));
    // OpenBot's own read marks of side threads (the host sends no event when one moves).
    if (this.has("agent-thread-reads-v1")) {
      const reads = await this.request("POST", "/v1/agent-threads/reads", { agentId }).catch(() => null);
      const list = isRec(reads) && Array.isArray(reads.reads) ? reads.reads.filter(isRec) : [];
      for (const r of list) if (typeof r.taskId === "string" && typeof r.unreadCount === "number") this.taskUnread.set(r.taskId, r.unreadCount);
    }
  }

  // Events mark what changed; one pass reads it shortly after.
  private schedule() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => void this.flush(), 300);
  }

  private async flush() {
    this.flushTimer = null;
    const agents = this.dirtyAgents;
    const chats = [...this.dirtyChats];
    const tasks = [...this.dirtyTasks];
    this.dirtyAgents = false;
    this.dirtyChats.clear();
    this.dirtyTasks.clear();
    try {
      if (agents) {
        await this.loadAgents();
        for (const id of this.agents.keys()) if (!this.chats.get(id)?.messages.length) chats.push(id);
      }
      await mapLimit([...new Set(chats)].filter((id) => this.agents.has(id)), 4, (id) => this.loadChat(id));
      await mapLimit([...new Set(tasks)].filter((id) => this.agents.has(id)), 4, (id) => this.loadTasks(id));
      if (chats.length) await this.loadReads();
    } catch (err) {
      this.log(`refresh: ${(err as Error).message}`);
    }
    this.rebuild();
  }

  private mainAgentFor(wireThreadId: Json, agentId: Json): string | null {
    const id = typeof agentId === "string" ? agentId : null;
    if (!id) return null;
    const agent = this.agents.get(id);
    return agent && (!wireThreadId || wireThreadId === agent.threadId) ? id : null;
  }

  private taskByWire(wireThreadId: Json): S.Task | null {
    if (typeof wireThreadId !== "string") return null;
    for (const list of this.tasks.values()) for (const t of list) if (t.threadId === wireThreadId) return t;
    return null;
  }

  onEvent(e: Rec) {
    const type = String(e.type ?? "");
    const agentId = typeof e.agentId === "string" ? e.agentId : null;
    switch (type) {
      case "agents-changed":
      case "hidden-agents-changed":
        this.dirtyAgents = true;
        break;
      case "conversation":
      case "conversation-page": {
        const snap = (isRec(e.snapshot) ? e.snapshot : isRec(e.page) ? e.page : null) as Rec | null;
        if (!snap) break;
        const main = this.mainAgentFor(snap.threadId, snap.agentId);
        const task = main ? null : this.taskByWire(snap.threadId);
        if (main) {
          const chat = this.chats.get(main) ?? { messages: [], activeTurnId: null, progress: null, unread: null };
          chat.messages = S.toMessages(snap).slice(-PAGE);
          chat.activeTurnId = typeof snap.activeTurnId === "string" ? snap.activeTurnId : null;
          this.chats.set(main, chat);
          this.rebuild();
        } else if (task) this.bumpTask(task);
        break;
      }
      case "conversation-delta": {
        const main = this.mainAgentFor(e.threadId, agentId);
        if (main) {
          const chat = this.chats.get(main);
          const m = chat?.messages.find((x) => x.id === e.messageId);
          if (m && typeof e.delta === "string") {
            m.text = (m.text ?? "") + e.delta;
            m.status = "streaming";
          } else if (agentId) this.dirtyChats.add(agentId);
          this.rebuild();
        } else {
          const task = this.taskByWire(e.threadId);
          if (task) this.bumpTask(task);
        }
        break;
      }
      case "conversation-invalidated":
        if (agentId) this.dirtyChats.add(agentId);
        break;
      case "turn-started":
      case "turn-completed": {
        const main = this.mainAgentFor(e.threadId, agentId);
        if (main) {
          const chat = this.chats.get(main);
          if (chat) {
            chat.activeTurnId = type === "turn-started" && typeof e.turnId === "string" ? e.turnId : null;
            if (!chat.activeTurnId) chat.progress = null;
          }
          this.dirtyChats.add(main);
          this.rebuild();
        } else if (agentId) this.dirtyTasks.add(agentId);
        break;
      }
      case "turn-progress": {
        const detail = typeof e.detail === "string" ? e.detail : null;
        const main = this.mainAgentFor(e.threadId, agentId);
        if (main) {
          const chat = this.chats.get(main);
          if (chat) chat.progress = detail;
        } else if (typeof e.threadId === "string" && detail) this.taskProgress.set(e.threadId, detail);
        this.rebuild();
        break;
      }
      case "agent-tasks-changed":
      case "agent-task-conversation":
      case "agent-task-conversation-delta": {
        const id = agentId ?? (isRec(e.task) && typeof e.task.agentId === "string" ? e.task.agentId : null);
        if (id) this.dirtyTasks.add(id);
        else for (const a of this.agents.keys()) this.dirtyTasks.add(a);
        const task = this.taskByWire(e.threadId ?? (isRec(e.conversation) ? e.conversation.threadId : undefined));
        if (task) this.bumpTask(task);
        break;
      }
      case "prompt": {
        const p = S.toPrompt(e);
        if (p) this.pending.set(String(p.requestId), p);
        this.rebuild();
        break;
      }
      case "approval": {
        const a = S.toApproval(e);
        if (a) this.pending.set(String(a.requestId), a);
        this.rebuild();
        break;
      }
      case "agent-input-resolved":
        this.pending.delete(String(e.requestId));
        this.rebuild();
        break;
      case "runtime-snapshot":
        this.applyRuntime(isRec(e.snapshot) ? e.snapshot : {});
        break;
      default:
        return;
    }
    this.schedule();
  }

  // The runtime snapshot says which chats are working and what waits for the user. It carries at
  // most four pending items; with `attentionComplete: false`, the ones from events stay too.
  private applyRuntime(snap: Rec) {
    const active = Array.isArray(snap.activeTurns) ? snap.activeTurns.filter(isRec) : [];
    for (const [id, chat] of this.chats) {
      const agent = this.agents.get(id);
      const turn = active.find((t) => t.agentId === id && (!agent?.threadId || t.threadId === agent.threadId));
      const next = turn && typeof turn.turnId === "string" ? turn.turnId : null;
      if (next !== chat.activeTurnId) {
        chat.activeTurnId = next;
        if (!next) chat.progress = null;
        this.dirtyChats.add(id);
      }
    }
    const prompts = (Array.isArray(snap.pendingPrompts) ? snap.pendingPrompts : []).map(S.toPrompt).filter((p): p is S.Prompt => !!p);
    const approvals = (Array.isArray(snap.pendingApprovals) ? snap.pendingApprovals : []).map(S.toApproval).filter((a): a is S.Approval => !!a);
    if (snap.attentionComplete !== false) this.pending.clear();
    for (const p of [...prompts, ...approvals]) this.pending.set(String(p.requestId), p);
    this.rebuild();
  }

  private bumpTask(task: S.Task) {
    this.taskRevs.set(task.id, (this.taskRevs.get(task.id) ?? 0) + 1);
    this.rebuild();
  }

  // ---- shapes for the bridge ------------------------------------------------------------

  private buildThreads(): S.Thread[] {
    const out: S.Thread[] = [];
    const visible = [...this.agents.values()].filter((a) => !this.hidden.has(a.id));
    for (const agent of visible) {
      const chat = this.chats.get(agent.id) ?? { messages: [], activeTurnId: null, progress: null, unread: null };
      const sum = S.summarize(chat.messages, chat.activeTurnId);
      const finished = sum.finishedAt;
      out.push(
        this.withMarks({
          id: `a:${agent.id}`,
          projectId: agent.id,
          title: agent.name,
          createdAt: chat.messages[0]?.createdAt ?? new Date(0).toISOString(),
          updatedAt: sum.lastAt ?? new Date(0).toISOString(),
          status: chat.activeTurnId ? "running" : sum.failed ? "failed" : "idle",
          activityRunStatus: chat.activeTurnId ? "running" : null,
          activeRunId: chat.activeTurnId,
          activityRunStartedAt: chat.activeTurnId ? sum.startedAt : null,
          latestRunStartedAt: sum.startedAt,
          latestRunCompletedAt: finished,
          // OpenBot's own read mark: with nothing unread, the last run counts as seen.
          lastVisitedAt: chat.unread === 0 ? finished : null,
          lastError: sum.failed ? "The run failed" : null,
          settledOverride: null,
          archivedAt: null,
          modelSelection: S.selectionOf(agent),
          latestVisibleMessage: sum.lastReply ? { role: "assistant", text: sum.lastReply.text } : null,
          pendingRuntimeRequest: null,
          _main: true,
          _agent: agent.id,
          _task: null,
          _wireThread: agent.threadId,
          _canReply: true,
          _canStop: !!chat.activeTurnId,
          _rev: sum.rev,
          _pending: null,
        }),
      );
      const tasks = (this.tasks.get(agent.id) ?? [])
        .filter((t) => t.state !== "closed")
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, SIDE_THREADS);
      for (const t of tasks) {
        const working = t.state === "running" || t.state === "queued";
        out.push(
          this.withMarks({
            id: `t:${t.id}`,
            projectId: agent.id,
            title: t.title,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            status: working ? "running" : t.outcome ?? "idle",
            activityRunStatus: working ? "running" : null,
            activeRunId: t.activeTurnId,
            activityRunStartedAt: working ? t.updatedAt : null,
            latestRunStartedAt: t.createdAt,
            latestRunCompletedAt: working ? null : t.updatedAt,
            lastVisitedAt: !working && this.taskUnread.get(t.id) === 0 ? t.updatedAt : null,
            lastError: t.outcome === "failed" ? t.error || "The task failed" : null,
            settledOverride: null,
            archivedAt: null,
            modelSelection: S.selectionOf(agent),
            latestVisibleMessage: null,
            pendingRuntimeRequest: null,
            _main: false,
            _agent: agent.id,
            _task: t.id,
            _wireThread: t.threadId,
            _canReply: true,
            _canStop: working,
            _rev: `${t.updatedAt}:${t.state}:${this.taskRevs.get(t.id) ?? 0}`,
            _pending: null,
          }),
        );
      }
    }
    // Each prompt or approval goes on its chat, else on its agent's main chat.
    for (const p of this.pending.values()) {
      const t = out.find((x) => x._wireThread && x._wireThread === p.threadId) ?? out.find((x) => x._agent === p.agentId && x._main);
      if (!t || t._pending) continue;
      t._pending = p;
      t.pendingRuntimeRequest = { kind: p.kind === "prompt" && !p.questions.some((q) => q.isSecret) ? "user_input" : "approval" };
    }
    return out;
  }

  private rebuild() {
    if (!this.ready) return;
    const modelsBefore = JSON.stringify(this.models);
    const threads = new Map(this.buildThreads().map((t) => [t.id, t]));
    const projects = new Map([...this.agents.values()].filter((a) => !this.hidden.has(a.id)).map((a) => [a.id, { id: a.id, title: a.name }]));
    const projectsChanged = JSON.stringify([...projects.values()]) !== JSON.stringify([...this.projects.values()]);
    const prev = this.threads;
    this.threads = threads;
    this.projects = projects;
    if (!this.loaded) {
      this.loaded = true;
      for (const t of threads.values()) this.sigs.set(t.id, signature(t));
      this.emit("change", { kind: "snapshot" });
      this.emit("config");
      return;
    }
    for (const t of threads.values()) {
      const sig = signature(t);
      if (this.sigs.get(t.id) === sig) continue;
      this.sigs.set(t.id, sig);
      this.emit("change", { kind: "thread", id: t.id, prev: prev.get(t.id), thread: t });
    }
    for (const id of prev.keys()) {
      if (threads.has(id)) continue;
      this.sigs.delete(id);
      this.emit("change", { kind: "removed", id });
    }
    if (projectsChanged) this.emit("change", { kind: "project" });
    if (JSON.stringify(this.models) !== modelsBefore) this.emit("config");
  }

  async threadProjection(threadId: string) {
    const t = this.thread(threadId);
    let messages: S.WireMessage[];
    let progress: string | null = null;
    if (t._main) {
      await this.loadChat(t._agent);
      const chat = this.chats.get(t._agent);
      messages = chat?.messages ?? [];
      progress = chat?.progress ?? null;
    } else {
      messages = S.toMessages(await this.request("POST", "/v1/agent-tasks/read", { agentId: t._agent, taskId: t._task }));
      progress = (t._wireThread && this.taskProgress.get(t._wireThread)) || null;
    }
    const name = (id: string) => this.agents.get(id)?.name ?? "another agent";
    return {
      messages: S.toTranscript(messages, name),
      runs: [],
      activity: S.activityOf(messages, t.activeRunId, progress),
      ...S.pendingParts(t._pending),
    };
  }

  get config() {
    const providers = [...new Set([...this.agents.values()].map((a) => a.provider).filter(Boolean))].map((id) => ({ instanceId: id, displayName: S.providerName(id), enabled: true }));
    return { providers, environment: { label: this.input.host.name, serverVersion: undefined } };
  }

  modelGroups() {
    return [{ code: "", choices: this.models }];
  }

  apiStatus() {
    return { on: true, agents: [...this.agents.values()].map((a) => ({ name: a.name, localScripts: true })) };
  }

  defaultModelFor(agentId: string) {
    return S.selectionOf(this.agents.get(agentId));
  }

  // ---- writing ------------------------------------------------------------------------

  private thread(threadId: string) {
    const t = this.threads.get(threadId);
    if (!t) throw new Error("That thread is gone.");
    return t;
  }

  private clientId() {
    return this.has("message-client-id-v1") ? { clientMessageId: `wow-${randomUUID()}` } : {};
  }

  private async upload(attachments: S.Attachment[]): Promise<string[]> {
    const ids: string[] = [];
    for (const a of attachments.filter((x) => x?.type === "upload")) {
      const query = new URLSearchParams({ name: a.name, mime: a.mimeType });
      const draft = await this.request("POST", `${TEAM_API_ROUTES.attachments}?${query}`, {}, { upload: { name: a.name, mimeType: a.mimeType, base64: a.data.toString("base64"), maxBytes: MOBILE_ATTACHMENT_BYTES } });
      if (!isRec(draft) || typeof draft.id !== "string") throw new TeamRequestError("The server didn't take the screenshot.");
      ids.push(draft.id);
    }
    return ids;
  }

  async sendMessage(threadId: string, text: string, mode = "steer", attachments: S.Attachment[] = []) {
    const t = this.thread(threadId);
    const files = await this.upload(attachments);
    if (!t._main) {
      // A side thread: plain text through agent-tasks-v1, screenshots through agent-thread-files-v1.
      // (agent-thread-replies-v1 quotes a message and needs its id, so it's not for this.)
      if (files.length) {
        if (!this.has("agent-thread-files-v1")) throw new Error("This server takes screenshots only in an agent's main chat.");
        await this.request("POST", "/v1/agent-threads/send-with-files", { agentId: t._agent, taskId: t._task, text, attachmentDraftIds: files, ...this.clientId() });
      } else {
        await this.request("POST", "/v1/agent-tasks/send", { agentId: t._agent, taskId: t._task, text, ...this.clientId() });
      }
      this.dirtyTasks.add(t._agent);
      this.schedule();
      return;
    }
    const receipt = await this.request("POST", TEAM_API_ROUTES.agent.messages(t._agent), { text, ...(files.length ? { attachmentDraftIds: files } : {}), ...this.clientId() });
    // A message to a working agent waits in its queue; steering puts it into the current run.
    const turnId = this.chats.get(t._agent)?.activeTurnId;
    const delivery = isRec(receipt) && Array.isArray(receipt.deliveries) && isRec(receipt.deliveries[0]) ? receipt.deliveries[0].id : null;
    if (mode === "steer" && turnId && typeof delivery === "string") {
      await this.request("POST", TEAM_API_ROUTES.agent.queueSteer(t._agent), { deliveryId: delivery, expectedTurnId: turnId }).catch(() => undefined);
    }
    this.dirtyChats.add(t._agent);
    this.schedule();
  }

  async launchThread(agentId: string, text: string, attachments: S.Attachment[] = [], opts: { model?: { instanceId: string; model: string }; effort?: string } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error("That agent is gone.");
    if (opts.model || opts.effort) await this.updateModel(agent, opts.model?.instanceId, opts.model?.model, opts.effort);
    await this.sendMessage(`a:${agentId}`, text, "steer", attachments);
    return { threadId: `a:${agentId}` };
  }

  async uploadImage(_threadId: string, data: Buffer, name: string, mimeType: string): Promise<S.Attachment> {
    return { type: "upload", data, name, mimeType, sizeBytes: data.length };
  }

  async interrupt(threadId: string) {
    const t = this.thread(threadId);
    if (!t._main) await this.request("POST", "/v1/agent-tasks/stop", { agentId: t._agent, taskId: t._task });
    else {
      const turnId = this.chats.get(t._agent)?.activeTurnId;
      if (!turnId) throw new Error("Nothing is running in that chat.");
      await this.request("POST", TEAM_API_ROUTES.agent.interrupt(t._agent), { turnId });
    }
    this.dirtyChats.add(t._agent);
    this.dirtyTasks.add(t._agent);
    this.schedule();
  }

  private pendingFor(threadId: string, requestId: string) {
    const p = this.pending.get(String(requestId));
    if (!p) throw new Error("That request was already answered.");
    this.thread(threadId);
    return p;
  }

  async respondApproval(threadId: string, requestId: string, decision: string) {
    const p = this.pendingFor(threadId, requestId);
    await this.request("POST", TEAM_API_ROUTES.respond.approval, { requestId: p.requestId, decision: S.decisionOf(decision) });
    this.pending.delete(String(requestId));
    this.rebuild();
  }

  async respondAnswers(threadId: string, requestId: string, answers: Record<string, string | string[]>) {
    const p = this.pendingFor(threadId, requestId);
    if (p.kind === "prompt" && p.questions.some((q) => q.isSecret)) throw new Error("This question asks for a secret. Answer it in OpenBot.");
    try {
      await this.request("POST", TEAM_API_ROUTES.respond.prompt, { requestId: p.requestId, answers: S.answersBody(answers) });
    } catch (err) {
      // 409: someone answered it first.
      if (!(err instanceof TeamRequestError && err.status === 409)) throw err;
    }
    this.pending.delete(String(requestId));
    this.rebuild();
  }

  async setModel(threadId: string, provider: string, model: string, effort?: string) {
    const agent = this.agents.get(this.thread(threadId)._agent);
    if (!agent) throw new Error("That agent is gone.");
    await this.updateModel(agent, provider, model, effort);
  }

  private async updateModel(agent: S.Agent, provider?: string, model?: string, effort?: string) {
    const body: Rec = {};
    if (provider && model) Object.assign(body, { provider, model });
    if (effort) body.reasoningEffort = effort;
    if (!Object.keys(body).length) return;
    const updated = S.toAgents([await this.request("PATCH", TEAM_API_ROUTES.agent.one(agent.id), body)])[0];
    if (updated) this.agents.set(agent.id, { ...updated, threadId: updated.threadId ?? agent.threadId });
    this.rebuild();
  }

  // Settled and archived are the bridge's own marks, as for this computer. A read also moves
  // OpenBot's read mark of a main chat.
  settle(threadId: string) {
    this.mark("settled", threadId, true);
  }

  unsettle(threadId: string) {
    this.mark("settled", threadId, false);
  }

  archive(threadId: string) {
    this.mark("archived", threadId, true);
  }

  visit(threadId: string) {
    const t = this.thread(threadId);
    this.mark("visited", threadId, true);
    if (!t._main && this.has("agent-thread-reads-v1")) {
      void this.request("POST", "/v1/agent-tasks/read", { agentId: t._agent, taskId: t._task })
        .then((snap) => {
          const last = S.toMessages(snap).at(-1);
          if (!last) return;
          return this.request("POST", "/v1/agent-threads/read", { agentId: t._agent, taskId: t._task, throughMessageId: last.id }).then(() => {
            this.taskUnread.set(t._task as string, 0);
            this.rebuild();
          });
        })
        .catch(() => undefined);
    }
    if (t._main) {
      void this.request("POST", TEAM_API_ROUTES.agent.conversationRead(t._agent), { throughMessageId: null })
        .then(() => {
          const chat = this.chats.get(t._agent);
          if (chat) chat.unread = 0;
          this.rebuild();
        })
        .catch(() => undefined);
    }
  }

  private mark(kind: keyof Marks, threadId: string, on: boolean) {
    this.thread(threadId);
    if (on) this.marks[kind][threadId] = new Date().toISOString();
    else delete this.marks[kind][threadId];
    this.saveMarks();
    this.rebuild();
  }

  // A new run clears settled and archived.
  private withMarks(t: S.Thread): S.Thread {
    const started = t.latestRunStartedAt ? Date.parse(t.latestRunStartedAt) : 0;
    const holds = (iso?: string) => !!iso && started <= Date.parse(iso);
    const visited = [this.marks.visited[t.id], t.lastVisitedAt].filter((x): x is string => !!x).sort().at(-1) ?? null;
    return {
      ...t,
      settledOverride: holds(this.marks.settled[t.id]) ? "settled" : null,
      archivedAt: holds(this.marks.archived[t.id]) ? this.marks.archived[t.id] : null,
      lastVisitedAt: visited,
    };
  }

  private marksFile() {
    return path.join(this.input.stateDir, "threads.json");
  }

  private loadMarks(): Marks {
    try {
      const d = JSON.parse(fs.readFileSync(this.marksFile(), "utf8"));
      return { settled: d.settled ?? {}, archived: d.archived ?? {}, visited: d.visited ?? {} };
    } catch {
      return { settled: {}, archived: {}, visited: {} };
    }
  }

  private saveMarks() {
    fs.mkdirSync(this.input.stateDir, { recursive: true });
    fs.writeFileSync(this.marksFile(), JSON.stringify(this.marks));
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

function signature(t: S.Thread) {
  return JSON.stringify([t.title, t.status, t.activeRunId, t.latestRunCompletedAt, t.lastError, t.settledOverride, t.archivedAt, t.lastVisitedAt, t._rev, t._pending?.requestId, t.modelSelection]);
}

export function createHostClient(input: ConstructorParameters<typeof TeamHostClient>[0]) {
  return new TeamHostClient(input);
}
