export declare const CHATGPT_WEB_BACKEND_MODEL: "gpt-5.6-sol";
export declare const CHATGPT_WEB_LUNA_BACKEND_MODEL: "gpt-5.6-luna";

export type ManagedChatGptWebModel =
  | typeof CHATGPT_WEB_BACKEND_MODEL
  | typeof CHATGPT_WEB_LUNA_BACKEND_MODEL;

export type ManagedChatGptWebEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

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

export interface ManagedChatGptWebLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  solAvailable: boolean;
  proAvailable: boolean;
}

export declare class ManagedChatGptWebTransport {
  constructor(options: ManagedChatGptWebTransportOptions);
  hasLogin(): boolean;
  login(timeoutMs?: number): Promise<ManagedChatGptWebLoginResult>;
  inspectSession(): Promise<ManagedChatGptWebSessionInfo>;
  run(turn: ManagedChatGptWebTurn): Promise<string>;
  close(): Promise<void>;
}
