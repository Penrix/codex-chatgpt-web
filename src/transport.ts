import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  browserLoginStateExists,
  inspectBrowserLoginCapabilities,
  loginToChatGpt,
  storedBrowserLoginCapabilities,
  type BrowserLoginConfig,
  type BrowserLoginResult,
} from "./browser-login";
import {
  defaultChromeExecutable,
  expandUserPath,
} from "./config";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  type ChatGptWebAdapterEffort,
  type ChatGptWebAutomaticBackendModel,
} from "./chatgpt-web-models";
import {
  ChatGptBrowserWorker,
  type ResolvedBrowserConfig,
} from "./adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "./adapters/chatgpt-web/adapter-error";
import type { ChatGptWebCapabilities } from "./adapters/chatgpt-web/model";

export {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
} from "./chatgpt-web-models";

export type ManagedChatGptWebModel = ChatGptWebAutomaticBackendModel;
export type ManagedChatGptWebEffort = ChatGptWebAdapterEffort;

export interface ManagedChatGptWebTransportOptions {
  storageStatePath: string;
  chromeExecutablePath?: string;
  headed?: boolean;
  turnTimeoutMs?: number;
  browserDiagnosticsPath?: string;
}

export interface ManagedChatGptWebTurn {
  model: ManagedChatGptWebModel;
  effort?: ManagedChatGptWebEffort;
  prompt: string;
  signal?: AbortSignal;
  traceId?: string;
  onHeartbeat?: () => void;
  onReasoningSummary?: (text: string, continuation?: boolean) => void;
  onCommentary?: (text: string, continuation?: boolean) => void;
  onTextDelta?: (text: string) => void;
}

export interface ManagedChatGptWebSessionInfo {
  authenticated: true;
  temporary: true;
  url: string;
  solAvailable: boolean;
  proAvailable: boolean;
}

type SubmissionPhase = "prepared" | "send_activated" | "submitted";

function managedConfig(options: ManagedChatGptWebTransportOptions): ResolvedBrowserConfig {
  const storageStatePath = resolve(expandUserPath(options.storageStatePath));
  const chromeExecutablePath = resolve(expandUserPath(
    options.chromeExecutablePath?.trim() || defaultChromeExecutable(),
  ));
  return {
    appName: "ChatGPT Web Transport",
    browserHost: "managed-chrome",
    storageStatePath,
    chromeExecutablePath,
    headed: options.headed !== false,
    autoApproveToolCalls: false,
    ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    ...(options.browserDiagnosticsPath
      ? { browserDiagnosticsPath: resolve(expandUserPath(options.browserDiagnosticsPath)) }
      : {}),
  };
}

function submittedTurnFailure(phase: SubmissionPhase, error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (normalized instanceof DOMException && normalized.name === "AbortError") return normalized;
  if (normalized instanceof ChatGptWebAdapterError) return normalized;
  if (phase === "prepared") return normalized;
  const ambiguous = phase === "send_activated";
  return new ChatGptWebAdapterError(
    ambiguous
      ? "ChatGPT did not confirm that the prompt was sent. Check the ChatGPT tab before continuing."
      : "ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.",
    {
      status: 502,
      errorType: "server_error",
      code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
      retryable: false,
      cause: normalized,
    },
  );
}

/**
 * Reusable ChatGPT Web browser transport with no Codex route, Responses server, MCP tunnel,
 * or desktop Launcher dependency. The caller owns conversation history and tool execution.
 */
export class ManagedChatGptWebTransport {
  private readonly config: ResolvedBrowserConfig;
  private readonly worker: ChatGptBrowserWorker;
  private capabilities?: ChatGptWebCapabilities;

  constructor(options: ManagedChatGptWebTransportOptions) {
    this.config = managedConfig(options);
    this.worker = ChatGptBrowserWorker.create(this.config);
  }

  private loginConfig(): BrowserLoginConfig {
    return {
      storageStatePath: this.config.storageStatePath,
      chromeExecutablePath: this.config.chromeExecutablePath,
    };
  }

  hasLogin(): boolean {
    return browserLoginStateExists(this.loginConfig());
  }

  async login(timeoutMs?: number): Promise<BrowserLoginResult> {
    await this.worker.close();
    const result = await loginToChatGpt(
      this.loginConfig(),
      timeoutMs === undefined ? {} : { timeoutMs },
    );
    this.capabilities = {
      localToolsEnabled: false,
      solAvailable: result.solAvailable,
      proAvailable: result.proAvailable,
    };
    return result;
  }

  async inspectSession(): Promise<ManagedChatGptWebSessionInfo> {
    try {
      const inspected = await this.worker.inspectSession(true);
      if (typeof inspected.solAvailable !== "boolean" || typeof inspected.proAvailable !== "boolean") {
        throw new Error("ChatGPT session inspection did not report model capabilities");
      }
      this.capabilities = {
        localToolsEnabled: false,
        solAvailable: inspected.solAvailable,
        proAvailable: inspected.proAvailable,
      };
      return {
        authenticated: true,
        temporary: true,
        url: inspected.url,
        solAvailable: inspected.solAvailable,
        proAvailable: inspected.proAvailable,
      };
    } finally {
      // Managed-Chrome session inspection uses the worker's maintenance browser.
      // Close it so a later real turn cannot open a second managed browser while
      // the maintenance browser remains orphaned.
      await this.worker.close();
    }
  }

  async run(turn: ManagedChatGptWebTurn): Promise<string> {
    if (turn.model !== CHATGPT_WEB_BACKEND_MODEL && turn.model !== CHATGPT_WEB_LUNA_BACKEND_MODEL) {
      throw new Error(`Unsupported managed ChatGPT Web model: ${turn.model}`);
    }
    const capabilities = this.capabilities ?? await this.loadCapabilities();
    let phase: SubmissionPhase = "prepared";
    try {
      return await this.worker.run({
        traceId: turn.traceId ?? `managed_${randomUUID().replaceAll("-", "")}`,
        modelId: turn.model,
        ...(turn.effort ? { reasoning: turn.effort } : {}),
        capabilities,
        prepare: async () => ({
          text: turn.prompt,
          images: [],
          release: () => {},
        }),
        ...(turn.signal ? { abortSignal: turn.signal } : {}),
        ...(turn.onHeartbeat ? { onHeartbeat: turn.onHeartbeat } : {}),
        onSendActivated: () => {
          phase = "send_activated";
        },
        onSubmitted: () => {
          phase = "submitted";
        },
        ...(turn.onReasoningSummary ? { onReasoningSummary: turn.onReasoningSummary } : {}),
        ...(turn.onCommentary ? { onCommentary: turn.onCommentary } : {}),
        onTextDelta: delta => {
          turn.onTextDelta?.(delta);
        },
      });
    } catch (error) {
      throw submittedTurnFailure(phase, error);
    }
  }

  async close(): Promise<void> {
    await this.worker.close();
  }

  private async loadCapabilities(): Promise<ChatGptWebCapabilities> {
    const config = this.loginConfig();
    const stored = storedBrowserLoginCapabilities(config);
    if (typeof stored.solAvailable === "boolean" && typeof stored.proAvailable === "boolean") {
      return {
        localToolsEnabled: false,
        solAvailable: stored.solAvailable,
        proAvailable: stored.proAvailable,
      };
    }
    const inspected = await inspectBrowserLoginCapabilities(config);
    return {
      localToolsEnabled: false,
      solAvailable: inspected.solAvailable,
      proAvailable: inspected.proAvailable,
    };
  }
}
