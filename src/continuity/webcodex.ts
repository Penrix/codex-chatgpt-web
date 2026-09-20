import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomicWriteFile } from "../config";
import { SUMMARY_PREFIX } from "../responses/compaction";

const STATE_VERSION = 1;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_EXTERNAL_TASK_ID = 128;
const MAX_OBJECTIVE_BYTES = 8 * 1024;
const MAX_CHECKPOINT_BYTES = 2 * 1024;

export interface WebCodexContinuityConfig {
  baseUrl: string;
  token: string;
  project: string;
  statePath: string;
}

export interface WebCodexContinuityBinding {
  version: 1;
  externalTaskId: string;
  project: string;
  goalId: string;
  workflowSessionId: string;
  goalRevision: number;
  objective: string;
  createdAt: string;
  updatedAt: string;
  adoptedFromTaskId?: string;
}

interface WebCodexContinuityState {
  version: 1;
  bindings: Record<string, WebCodexContinuityBinding>;
}

interface RuntimeToolEnvelope {
  success?: boolean;
  output?: unknown;
  error?: unknown;
}

export interface WebCodexRecoverySnapshot {
  binding: WebCodexContinuityBinding;
  goal: unknown;
  handoff: unknown;
}

export class WebCodexContinuityError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid_config" | "runtime_error" | "outcome_unknown" | "state_error",
  ) {
    super(message);
    this.name = "WebCodexContinuityError";
  }
}

function boundedUtf8(value: string, maxBytes: number): string {
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
  let end = normalized.length;
  while (end > 0 && Buffer.byteLength(normalized.slice(0, end), "utf8") > maxBytes) end -= 1;
  return normalized.slice(0, end).trimEnd();
}

function exactTaskId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_EXTERNAL_TASK_ID || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new WebCodexContinuityError(
      "WebCodex continuity task id must be 1-128 characters using letters, digits, dot, underscore, colon, or dash",
      "state_error",
    );
  }
  return normalized;
}

function normalizedBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebCodexContinuityError("WebCodex continuity URL is invalid", "invalid_config");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new WebCodexContinuityError(
      "WebCodex continuity URL must be a plain http(s) origin/base path without credentials, query, or fragment",
      "invalid_config",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function stateKey(taskId: string): string {
  return taskId;
}

function stableKey(kind: string, taskId: string, suffix = ""): string {
  const digest = createHash("sha256").update(`${kind}\0${taskId}\0${suffix}`).digest("hex");
  return `cgw-${kind}-${digest.slice(0, 48)}`;
}

function outputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebCodexContinuityError("WebCodex returned an invalid tool output", "runtime_error");
  }
  return value as Record<string, unknown>;
}

function nestedObject(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : undefined;
}

function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current ? current : undefined;
}

function numberAt(value: unknown, ...path: string[]): number | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" && Number.isSafeInteger(current) && current > 0 ? current : undefined;
}

function sessionIdFromWorkOutput(output: unknown): string | undefined {
  return stringAt(output, "session", "session_id")
    ?? stringAt(output, "startup_brief", "session", "session_id");
}

function goalIdentity(output: unknown): { goalId: string; revision: number } {
  const goal = nestedObject(output, "goal");
  const summary = goal ? nestedObject(goal, "summary") : undefined;
  const goalId = summary ? stringAt(summary, "goal_id") : undefined;
  const revision = summary ? numberAt(summary, "revision") : undefined;
  if (!goalId || !revision) {
    throw new WebCodexContinuityError("WebCodex Goal response omitted goal_id or revision", "runtime_error");
  }
  return { goalId, revision };
}

function parseState(raw: string, path: string): WebCodexContinuityState {
  if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) {
    throw new WebCodexContinuityError(`WebCodex continuity state exceeds ${MAX_STATE_BYTES} bytes: ${path}`, "state_error");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WebCodexContinuityError(`WebCodex continuity state is invalid JSON: ${path}`, "state_error");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebCodexContinuityError(`WebCodex continuity state is invalid: ${path}`, "state_error");
  }
  const root = value as Record<string, unknown>;
  if (root.version !== STATE_VERSION || !root.bindings || typeof root.bindings !== "object" || Array.isArray(root.bindings)) {
    throw new WebCodexContinuityError(`WebCodex continuity state has an unsupported shape: ${path}`, "state_error");
  }
  const bindings: Record<string, WebCodexContinuityBinding> = {};
  for (const [key, rawBinding] of Object.entries(root.bindings as Record<string, unknown>)) {
    if (!rawBinding || typeof rawBinding !== "object" || Array.isArray(rawBinding)) {
      throw new WebCodexContinuityError(`WebCodex continuity binding is invalid: ${key}`, "state_error");
    }
    const binding = rawBinding as Record<string, unknown>;
    const externalTaskId = exactTaskId(String(binding.externalTaskId ?? ""));
    if (key !== stateKey(externalTaskId)) {
      throw new WebCodexContinuityError(`WebCodex continuity binding key mismatch: ${key}`, "state_error");
    }
    if (
      binding.version !== 1
      || typeof binding.project !== "string"
      || typeof binding.goalId !== "string"
      || typeof binding.workflowSessionId !== "string"
      || typeof binding.goalRevision !== "number"
      || !Number.isSafeInteger(binding.goalRevision)
      || binding.goalRevision < 1
      || typeof binding.objective !== "string"
      || typeof binding.createdAt !== "string"
      || typeof binding.updatedAt !== "string"
      || (binding.adoptedFromTaskId !== undefined && typeof binding.adoptedFromTaskId !== "string")
    ) {
      throw new WebCodexContinuityError(`WebCodex continuity binding has invalid fields: ${key}`, "state_error");
    }
    bindings[key] = binding as unknown as WebCodexContinuityBinding;
  }
  return { version: 1, bindings };
}

export function loadWebCodexContinuityConfig(
  statePath: string,
  env: NodeJS.ProcessEnv = process.env,
): WebCodexContinuityConfig | undefined {
  const baseUrl = env.CODEX_CHATGPT_WEB_WEBCODEX_URL?.trim();
  const token = env.CODEX_CHATGPT_WEB_WEBCODEX_TOKEN?.trim();
  const project = env.CODEX_CHATGPT_WEB_WEBCODEX_PROJECT?.trim();
  const present = [baseUrl, token, project].filter(Boolean).length;
  if (present === 0) return undefined;
  if (present !== 3) {
    throw new WebCodexContinuityError(
      "WebCodex continuity requires CODEX_CHATGPT_WEB_WEBCODEX_URL, CODEX_CHATGPT_WEB_WEBCODEX_TOKEN, and CODEX_CHATGPT_WEB_WEBCODEX_PROJECT together",
      "invalid_config",
    );
  }
  return {
    baseUrl: normalizedBaseUrl(baseUrl!),
    token: token!,
    project: project!,
    statePath: resolve(statePath),
  };
}

export class WebCodexContinuityBridge {
  private readonly baseUrl: string;
  private readonly statePath: string;

  constructor(
    readonly config: WebCodexContinuityConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = normalizedBaseUrl(config.baseUrl);
    if (!config.token.trim()) throw new WebCodexContinuityError("WebCodex continuity token is empty", "invalid_config");
    if (!config.project.trim()) throw new WebCodexContinuityError("WebCodex continuity project is empty", "invalid_config");
    this.statePath = resolve(config.statePath);
  }

  getBinding(externalTaskId: string): WebCodexContinuityBinding | undefined {
    const id = exactTaskId(externalTaskId);
    return this.loadState().bindings[stateKey(id)];
  }

  async bindTask(externalTaskId: string, instruction: string): Promise<WebCodexContinuityBinding> {
    const taskId = exactTaskId(externalTaskId);
    const objective = boundedUtf8(instruction, MAX_OBJECTIVE_BYTES);
    if (!objective) throw new WebCodexContinuityError("WebCodex continuity instruction is empty", "state_error");

    const state = this.loadState();
    const existing = state.bindings[stateKey(taskId)];
    if (existing) {
      if (existing.project !== this.config.project) {
        throw new WebCodexContinuityError("Existing continuity binding belongs to another WebCodex project", "state_error");
      }
      return existing;
    }

    const created = await this.callTool("create_goal", {
      title: boundedUtf8(`Codex Web task ${taskId}`, 200),
      objective,
      completion_conditions: [],
      steps: [],
      idempotency_key: stableKey("goal", taskId),
    }, "idempotent_effect");
    const { goalId, revision } = goalIdentity(created);

    const work = await this.callTool("work_on_project", {
      project: this.config.project,
      instruction: objective,
    }, "effect");
    const workflowSessionId = sessionIdFromWorkOutput(work);
    if (!workflowSessionId) {
      throw new WebCodexContinuityError("work_on_project response omitted Workflow Session identity", "runtime_error");
    }

    await this.callTool("associate_goal_workflow_session", {
      goal_id: goalId,
      session_id: workflowSessionId,
      idempotency_key: stableKey("goal-session", taskId, `${goalId}\0${workflowSessionId}`),
    }, "idempotent_effect");

    const now = new Date().toISOString();
    const binding: WebCodexContinuityBinding = {
      version: 1,
      externalTaskId: taskId,
      project: this.config.project,
      goalId,
      workflowSessionId,
      goalRevision: revision,
      objective,
      createdAt: now,
      updatedAt: now,
    };
    state.bindings[stateKey(taskId)] = binding;
    this.saveState(state);
    return binding;
  }

  adoptTask(newExternalTaskId: string, previousExternalTaskId: string): WebCodexContinuityBinding {
    const nextId = exactTaskId(newExternalTaskId);
    const previousId = exactTaskId(previousExternalTaskId);
    const state = this.loadState();
    const previous = state.bindings[stateKey(previousId)];
    if (!previous) {
      throw new WebCodexContinuityError(`No WebCodex continuity binding exists for ${previousId}`, "state_error");
    }
    const existing = state.bindings[stateKey(nextId)];
    if (existing) {
      if (existing.goalId !== previous.goalId || existing.workflowSessionId !== previous.workflowSessionId) {
        throw new WebCodexContinuityError(`Task ${nextId} is already bound to different durable work`, "state_error");
      }
      return existing;
    }
    const adopted: WebCodexContinuityBinding = {
      ...previous,
      externalTaskId: nextId,
      adoptedFromTaskId: previousId,
      updatedAt: new Date().toISOString(),
    };
    state.bindings[stateKey(nextId)] = adopted;
    this.saveState(state);
    return adopted;
  }

  async checkpointTask(externalTaskId: string, summary: string): Promise<WebCodexContinuityBinding> {
    const taskId = exactTaskId(externalTaskId);
    const checkpoint = boundedUtf8(summary, MAX_CHECKPOINT_BYTES);
    if (!checkpoint) throw new WebCodexContinuityError("WebCodex checkpoint summary is empty", "state_error");

    const state = this.loadState();
    const binding = state.bindings[stateKey(taskId)];
    if (!binding) throw new WebCodexContinuityError(`No WebCodex continuity binding exists for ${taskId}`, "state_error");

    const current = await this.callTool("get_goal", { goal_id: binding.goalId }, "read");
    const currentIdentity = goalIdentity(current);
    if (currentIdentity.goalId !== binding.goalId) {
      throw new WebCodexContinuityError("WebCodex returned the wrong Goal during checkpoint refresh", "runtime_error");
    }

    const checkpointed = await this.callTool("checkpoint_goal", {
      goal_id: binding.goalId,
      expected_revision: currentIdentity.revision,
      summary: checkpoint,
      idempotency_key: stableKey("checkpoint", taskId, `${currentIdentity.revision}\0${checkpoint}`),
    }, "idempotent_effect");
    const next = goalIdentity(checkpointed);
    const updated: WebCodexContinuityBinding = {
      ...binding,
      goalRevision: next.revision,
      updatedAt: new Date().toISOString(),
    };
    state.bindings[stateKey(taskId)] = updated;
    this.saveState(state);
    return updated;
  }

  async checkpointTaskFromCompaction(externalTaskId: string, replacementHistory: unknown[]): Promise<WebCodexContinuityBinding> {
    const summary = compactionSummaryFromReplacementHistory(replacementHistory);
    if (!summary) {
      throw new WebCodexContinuityError(
        "Compaction replacement history does not contain a readable checkpoint summary",
        "state_error",
      );
    }
    return this.checkpointTask(externalTaskId, summary);
  }

  async recoverTask(externalTaskId: string): Promise<WebCodexRecoverySnapshot> {
    const taskId = exactTaskId(externalTaskId);
    const state = this.loadState();
    const binding = state.bindings[stateKey(taskId)];
    if (!binding) throw new WebCodexContinuityError(`No WebCodex continuity binding exists for ${taskId}`, "state_error");

    const [goal, handoff] = await Promise.all([
      this.callTool("get_goal", { goal_id: binding.goalId }, "read"),
      this.callTool("session_handoff_summary", {
        session_id: binding.workflowSessionId,
        project: binding.project,
        include_workspace: true,
        include_checkpoints: false,
        include_validation: true,
        diagnostic: false,
      }, "read"),
    ]);
    const identity = goalIdentity(goal);
    if (identity.goalId !== binding.goalId) {
      throw new WebCodexContinuityError("WebCodex returned the wrong Goal during recovery", "runtime_error");
    }
    if (identity.revision !== binding.goalRevision) {
      const updated = { ...binding, goalRevision: identity.revision, updatedAt: new Date().toISOString() };
      state.bindings[stateKey(taskId)] = updated;
      this.saveState(state);
      return { binding: updated, goal, handoff };
    }
    return { binding, goal, handoff };
  }

  private loadState(): WebCodexContinuityState {
    try {
      return parseState(readFileSync(this.statePath, "utf8"), this.statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, bindings: {} };
      throw error;
    }
  }

  private saveState(state: WebCodexContinuityState): void {
    const encoded = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_STATE_BYTES) {
      throw new WebCodexContinuityError("WebCodex continuity state exceeded its local size bound", "state_error");
    }
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    atomicWriteFile(this.statePath, encoded);
  }

  private async callTool(
    tool: string,
    params: Record<string, unknown>,
    effect: "read" | "effect" | "idempotent_effect",
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/tools/call`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ tool, params }),
      });
    } catch (error) {
      const suffix = error instanceof Error ? `: ${error.message}` : "";
      throw new WebCodexContinuityError(
        effect === "read"
          ? `WebCodex ${tool} request failed${suffix}`
          : `WebCodex ${tool} response was lost; reconcile durable state before retrying${suffix}`,
        effect === "read" ? "runtime_error" : "outcome_unknown",
      );
    }

    let envelope: RuntimeToolEnvelope;
    try {
      envelope = await response.json() as RuntimeToolEnvelope;
    } catch {
      throw new WebCodexContinuityError(
        effect === "read"
          ? `WebCodex ${tool} returned invalid JSON`
          : `WebCodex ${tool} returned an unreadable post-dispatch response; reconcile durable state before retrying`,
        effect === "read" ? "runtime_error" : "outcome_unknown",
      );
    }
    if (!response.ok || envelope.success !== true) {
      const detail = typeof envelope.error === "string" && envelope.error ? `: ${envelope.error}` : "";
      throw new WebCodexContinuityError(`WebCodex ${tool} failed${detail}`, "runtime_error");
    }
    return outputObject(envelope.output);
  }
}
