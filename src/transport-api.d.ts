export declare const CHATGPT_WEB_BACKEND_MODEL: "gpt-5.6-sol";
export declare const CHATGPT_WEB_LUNA_BACKEND_MODEL: "gpt-5.6-luna";
export declare const CHATGPT_WEB_INSTANT_CONTEXT_WINDOW: number;
export declare const CHATGPT_WEB_MEDIUM_HIGH_CONTEXT_WINDOW: number;
export declare const CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW: number;
export declare const CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW: number;
export declare const CHATGPT_WEB_LUNA_CONTEXT_WINDOW: number;

export type ManagedChatGptWebModel =
  | typeof CHATGPT_WEB_BACKEND_MODEL
  | typeof CHATGPT_WEB_LUNA_BACKEND_MODEL;

export type ManagedChatGptWebEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ManagedChatGptWebLoginSource = "stored" | "reused" | "interactive";

export interface ManagedChatGptWebTransportOptions {
  storageStatePath: string;
  chromeExecutablePath?: string;
  headed?: boolean;
  turnTimeoutMs?: number;
  browserDiagnosticsPath?: string;
  loginProfileDir?: string;
  reusableLoginProfileDirs?: string[];
  allowInteractiveLogin?: boolean;
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

export interface ManagedChatGptWebLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  solAvailable: boolean;
  proAvailable: boolean;
}

export interface ManagedChatGptWebTransportApi {
  hasLogin(): boolean;
  ensureLogin(timeoutMs?: number): Promise<ManagedChatGptWebLoginSource>;
  login(timeoutMs?: number): Promise<ManagedChatGptWebLoginResult>;
  inspectSession(): Promise<ManagedChatGptWebSessionInfo>;
  run(turn: ManagedChatGptWebTurn): Promise<string>;
  close(): Promise<void>;
}

export declare class ManagedChatGptWebTransport implements ManagedChatGptWebTransportApi {
  constructor(options: ManagedChatGptWebTransportOptions);
  hasLogin(): boolean;
  ensureLogin(timeoutMs?: number): Promise<ManagedChatGptWebLoginSource>;
  login(timeoutMs?: number): Promise<ManagedChatGptWebLoginResult>;
  inspectSession(): Promise<ManagedChatGptWebSessionInfo>;
  run(turn: ManagedChatGptWebTurn): Promise<string>;
  close(): Promise<void>;
}
