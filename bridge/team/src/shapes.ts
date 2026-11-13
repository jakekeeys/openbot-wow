// Pure mapping from OpenBot's team API (protocol 9, as remote-peer decodes it) to the shapes the
// bridge reads: T3-style threads, projections and pending requests, as src/openbot.js makes them
// for this computer. No I/O here, so it can be tested without a server.

export type Json = unknown;
type Rec = Record<string, Json>;

export interface Agent {
  id: string;
  name: string;
  provider: string;
  model: string;
  reasoningEffort: string | null;
  threadId: string | null;
}

export interface WireMessage {
  id: string;
  author: "user" | "assistant" | "agent" | "system";
  text: string;
  createdAt: string;
  status: "streaming" | "completed" | "failed" | "interrupted";
  turnId?: string;
  itemType?: string;
  senderAgentId?: string;
  questionPrompt?: { requestId: string | number; resolution: Json | null };
}

export interface Task {
  id: string;
  agentId: string;
  threadId: string | null;
  title: string;
  state: "running" | "queued" | "idle" | "closed";
  outcome: "completed" | "failed" | "interrupted" | null;
  activeTurnId: string | null;
  error: string | null;
  progress: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Prompt {
  kind: "prompt";
  requestId: string | number;
  agentId: string;
  threadId: string | null;
  questions: { id: string; header?: string; question?: string; isSecret?: boolean; multiSelect?: boolean; options?: { label: string; description?: string }[] | null }[];
}

export interface Approval {
  kind: "approval";
  requestId: string | number;
  agentId: string;
  threadId: string | null;
  approval: { kind?: string; command?: string | null; cwd?: string | null; reason?: string | null; grantRoot?: string | null };
}

export type Pending = Prompt | Approval;

export interface ModelChoice {
  instanceId: string;
  model: string;
  name: string;
  provider: string;
  effort?: { id: string; options: { id: string; label: string }[]; default: string };
}

export type Attachment = { type: "upload"; data: Buffer; name: string; mimeType: string; sizeBytes: number };

// What the bridge reads from a thread (see threadStatus and buildSnapshot in src/).
export interface Thread {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  activityRunStatus: "running" | null;
  activeRunId: string | null;
  activityRunStartedAt: string | null;
  latestRunStartedAt: string | null;
  latestRunCompletedAt: string | null;
  lastVisitedAt: string | null;
  lastError: string | null;
  // A side thread that OpenBot closed: it leaves the list, and comes back when it's reopened or
  // runs again. Never set on a main chat.
  closedAt: string | null;
  modelSelection: { instanceId: string; model: string; options: { id: string; value: string }[] } | null;
  latestVisibleMessage: { role: "assistant"; text: string } | null;
  pendingRuntimeRequest: { kind: string } | null;
  _main: boolean;
  _agent: string;
  _task: string | null;
  _wireThread: string | null;
  _canReply: boolean;
  _canStop: boolean;
  _rev: string;
  _pending: Pending | null;
}

const isRec = (v: Json): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: Json): string | null => (typeof v === "string" ? v : null);

export function toAgents(body: Json): Agent[] {
  const list = Array.isArray(body) ? body : isRec(body) && Array.isArray(body.agents) ? body.agents : [];
  return list.filter(isRec).flatMap((a) => {
    const id = str(a.id);
    if (!id) return [];
    return [{ id, name: str(a.name) || "Agent", provider: str(a.provider) || "", model: str(a.model) || "", reasoningEffort: str(a.reasoningEffort), threadId: str(a.threadId) }];
  });
}

export function toTasks(body: Json): Task[] {
  const list = isRec(body) && Array.isArray(body.tasks) ? body.tasks : [];
  return list.filter(isRec).flatMap((t) => {
    const id = str(t.id);
    const agentId = str(t.agentId);
    if (!id || !agentId) return [];
    const state = (["running", "queued", "idle", "closed"] as const).find((s) => s === t.state) ?? "idle";
    const outcome = (["completed", "failed", "interrupted"] as const).find((s) => s === t.outcome) ?? null;
    return [{ id, agentId, threadId: str(t.threadId), title: str(t.title) || "Side thread", state, outcome, activeTurnId: str(t.activeTurnId), error: str(t.error), progress: str(t.progress), createdAt: str(t.createdAt) || "", updatedAt: str(t.updatedAt) || str(t.createdAt) || "", closedAt: str(t.closedAt) }];
  });
}

export function toMessages(body: Json): WireMessage[] {
  const list = isRec(body) && Array.isArray(body.messages) ? body.messages : [];
  return list.filter((m): m is Rec => isRec(m) && typeof m.id === "string" && typeof m.author === "string").map((m) => m as unknown as WireMessage);
}

const PROVIDER_NAMES: Record<string, string> = { codex: "Codex", claude: "Claude", grok: "Grok", opencode: "OpenCode", cursor: "Cursor", gemini: "Gemini", copilot: "Copilot", kimi: "Kimi", deepseek: "DeepSeek", openrouter: "OpenRouter", mistral: "Mistral" };
const EFFORT_LABELS: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };

export function providerName(id: string) {
  return PROVIDER_NAMES[id] ?? id;
}

export function toModelChoices(body: Json): ModelChoice[] {
  const list = Array.isArray(body) ? body : [];
  return list.filter(isRec).flatMap((m) => {
    const provider = str(m.provider);
    const id = str(m.id);
    if (!provider || !id) return [];
    const efforts = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.filter((e): e is string => typeof e === "string") : [];
    const def = str(m.defaultReasoningEffort);
    return [{
      instanceId: provider,
      model: id,
      name: str(m.name) || id,
      provider: providerName(provider),
      ...(efforts.length ? { effort: { id: "reasoningEffort", options: efforts.map((e) => ({ id: e, label: EFFORT_LABELS[e] ?? e })), default: def && efforts.includes(def) ? def : efforts[0] } } : {}),
    }];
  });
}

export function selectionOf(agent: Agent | undefined) {
  if (!agent?.provider || !agent.model) return null;
  return { instanceId: agent.provider, model: agent.model, options: agent.reasoningEffort ? [{ id: "reasoningEffort", value: agent.reasoningEffort }] : [] };
}

// Rows the game shows: what people and agents said. Progress notes, system rows, subagent
// lists and memory notes stay out, as for this computer.
const HIDDEN_TYPES = new Set(["commentary", "subagents", "memory-changes", "context-reset", "instructions-change"]);
const PROGRESS_TYPES = new Set(["commentary", "agentMessage", undefined, ""]);

export function toTranscript(messages: WireMessage[], agentName: (id: string) => string) {
  const out: { id: string; role: "user" | "assistant"; text: string; createdAt: string; streaming?: true; turnId?: string }[] = [];
  for (const m of messages) {
    if (typeof m.text !== "string" || !m.text.trim()) continue;
    const base = { id: m.id, createdAt: m.createdAt, ...(m.status === "streaming" ? { streaming: true as const } : {}), ...(m.turnId ? { turnId: m.turnId } : {}) };
    if (m.author === "user") out.push({ ...base, role: "user", text: m.text });
    else if (m.author === "agent") out.push({ ...base, role: "user", text: `**From ${m.senderAgentId ? agentName(m.senderAgentId) : "another agent"}:** ${m.text}` });
    else if (m.author === "assistant" && !HIDDEN_TYPES.has(m.itemType ?? "")) out.push({ ...base, role: "assistant", text: m.text });
  }
  return out;
}

function firstLine(text: string, max = 60) {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const plain = line.replace(/[*_`#>]/g, "").trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + "…" : plain;
}

// What a working thread is doing: the server's own progress line, else the agent's latest note.
export function activityOf(messages: WireMessage[], activeTurnId: string | null, progress?: string | null) {
  if (!activeTurnId) return null;
  if (progress) return firstLine(progress) ?? "Working";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.turnId !== activeTurnId || m.author !== "assistant") continue;
    if (m.itemType === "subagents") return "Working with subagents";
    if (!PROGRESS_TYPES.has(m.itemType)) continue;
    const line = firstLine(m.text ?? "");
    if (line) return line;
  }
  return "Working";
}

// The facts a thread row needs, from the newest messages of a chat.
export function summarize(messages: WireMessage[], activeTurnId: string | null) {
  const replies = messages.filter((m) => m.author === "assistant" && !HIDDEN_TYPES.has(m.itemType ?? "") && m.status !== "streaming" && m.text?.trim());
  const last = messages.at(-1);
  const lastReply = replies.at(-1) ?? null;
  const turnStart = activeTurnId ? messages.find((m) => m.turnId === activeTurnId)?.createdAt ?? null : null;
  const lastTurn = last?.turnId;
  const lastTurnStart = lastTurn ? messages.find((m) => m.turnId === lastTurn)?.createdAt ?? null : null;
  const failed = !activeTurnId && !!last && last.author === "assistant" && last.status === "failed";
  return {
    lastReply: lastReply ? { text: lastReply.text, at: lastReply.createdAt } : null,
    lastAt: last?.createdAt ?? null,
    startedAt: turnStart ?? lastTurnStart,
    finishedAt: activeTurnId ? null : (last?.createdAt ?? null),
    failed,
    rev: `${messages.length}:${last?.id ?? ""}:${last?.status ?? ""}:${last?.text?.length ?? 0}`,
  };
}

// The pending request in T3's shape, which the bridge's `pendingRequest` reads. Secret
// questions are answered in OpenBot, not typed into the game.
export function pendingParts(p: Pending | null) {
  if (!p) return { runtimeRequests: [], turnItems: [] };
  const id = String(p.requestId);
  if (p.kind === "prompt" && !p.questions.some((q) => q.isSecret)) {
    return {
      runtimeRequests: [{ id, status: "pending", kind: "user_input" }],
      turnItems: [{
        type: "user_input_request",
        requestId: id,
        questions: p.questions.map((q) => ({
          id: q.id,
          header: q.header ?? "",
          question: q.question ?? "",
          multiSelect: q.multiSelect || undefined,
          allowCustomAnswer: true,
          options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "", value: o.label })),
        })),
      }],
    };
  }
  if (p.kind === "approval") {
    const a = p.approval;
    const kinds: Record<string, string> = { command: "command", "file-change": "file-change", permissions: "permission" };
    const detail = [a.reason, a.command, a.cwd ? `in ${a.cwd}` : null, a.grantRoot ? `grant ${a.grantRoot}` : null].filter(Boolean).join("\n");
    return {
      runtimeRequests: [{ id, status: "pending", kind: kinds[a.kind ?? ""] ?? "permission", nodeId: "approval" }],
      turnItems: [{ nodeId: "approval", type: "dynamic_tool", input: detail }],
    };
  }
  return {
    runtimeRequests: [{ id, status: "pending", kind: "Answer in OpenBot", nodeId: "openbot-only" }],
    turnItems: [{ nodeId: "openbot-only", type: "dynamic_tool", input: "This question asks for a secret, so answer it in OpenBot." }],
  };
}

export function toPrompt(v: Json): Prompt | null {
  if (!isRec(v) || (typeof v.requestId !== "string" && typeof v.requestId !== "number") || !str(v.agentId) || !Array.isArray(v.questions)) return null;
  return { kind: "prompt", requestId: v.requestId, agentId: v.agentId as string, threadId: str(v.threadId), questions: v.questions.filter(isRec) as Prompt["questions"] };
}

export function toApproval(v: Json): Approval | null {
  const a = isRec(v) && isRec(v.approval) ? v.approval : v;
  if (!isRec(a) || (typeof a.requestId !== "string" && typeof a.requestId !== "number") || !str(a.agentId)) return null;
  return { kind: "approval", requestId: a.requestId, agentId: a.agentId as string, threadId: str(a.threadId), approval: a as Approval["approval"] };
}

export function answersBody(answers: Record<string, string | string[]>) {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(answers ?? {})) out[k] = ([] as string[]).concat(v).map(String);
  return out;
}

export function decisionOf(decision: string) {
  return String(decision || "").startsWith("accept") ? "accept" : "decline";
}
