import { randomBytes } from "node:crypto";
import { ChatGptWebAdapterError } from "./adapter-error";
import { namespacedToolName, type CodexParsedRequest, type CodexTool } from "../../types";
import type { ChatGptWebCapabilities } from "./model";
import type { BrokerToolRequest } from "./turn-broker";

export const CHATGPT_RESPONSES_TOOL_RELAY_OPEN = "<codex_native_tool_calls_json>";
export const CHATGPT_RESPONSES_TOOL_RELAY_CLOSE = "</codex_native_tool_calls_json>";

export function responsesToolRelayEnabled(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
): boolean {
  return !parsed._compactionRequest
    && !capabilities.localToolsEnabled
    && (parsed.context.tools?.length ?? 0) > 0;
}

export function responsesToolRelayCatalog(tools: readonly CodexTool[]): string {
  return JSON.stringify({
    version: 1,
    tools: tools.map(tool => ({
      wire_name: namespacedToolName(tool.namespace, tool.name),
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.freeform ? { freeform: true } : {}),
      ...(tool.toolSearch ? { tool_search: true } : {}),
    })),
  });
}

interface RelayCall {
  name?: unknown;
  arguments?: unknown;
  input?: unknown;
}

interface RelayPayload {
  calls?: unknown;
}

function malformed(message: string): never {
  throw new ChatGptWebAdapterError(message, {
    status: 502,
    errorType: "server_error",
    code: "responses_tool_relay_malformed",
    retryable: false,
  });
}

function objectArguments(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    malformed(`ChatGPT Responses tool relay arguments for ${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export type ResponsesToolRelayResult =
  | { type: "answer"; answer: string }
  | { type: "tools"; requests: BrokerToolRequest[] };

export function parseResponsesToolRelayAnswer(
  answer: string,
  tools: readonly CodexTool[],
): ResponsesToolRelayResult {
  const trimmed = answer.trim();
  const hasOpen = trimmed.includes(CHATGPT_RESPONSES_TOOL_RELAY_OPEN);
  const hasClose = trimmed.includes(CHATGPT_RESPONSES_TOOL_RELAY_CLOSE);
  if (!hasOpen && !hasClose) return { type: "answer", answer };

  if (
    !trimmed.startsWith(CHATGPT_RESPONSES_TOOL_RELAY_OPEN)
    || !trimmed.endsWith(CHATGPT_RESPONSES_TOOL_RELAY_CLOSE)
  ) {
    malformed("ChatGPT mixed a Responses tool relay envelope with user-facing text");
  }

  const payloadText = trimmed.slice(
    CHATGPT_RESPONSES_TOOL_RELAY_OPEN.length,
    -CHATGPT_RESPONSES_TOOL_RELAY_CLOSE.length,
  ).trim();

  let payload: RelayPayload;
  try {
    payload = JSON.parse(payloadText) as RelayPayload;
  } catch {
    malformed("ChatGPT returned invalid JSON in the Responses tool relay envelope");
  }

  if (!Array.isArray(payload.calls) || payload.calls.length < 1 || payload.calls.length > 8) {
    malformed("ChatGPT Responses tool relay must contain between 1 and 8 calls");
  }

  const available = new Map(
    tools.map(tool => [namespacedToolName(tool.namespace, tool.name), tool] as const),
  );
  const requests: BrokerToolRequest[] = payload.calls.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      malformed(`ChatGPT Responses tool relay call ${index + 1} is not an object`);
    }
    const call = raw as RelayCall;
    if (typeof call.name !== "string" || !call.name) {
      malformed(`ChatGPT Responses tool relay call ${index + 1} has no tool name`);
    }
    const tool = available.get(call.name);
    if (!tool) {
      malformed(`ChatGPT requested an unavailable Codex tool through the Responses relay: ${call.name}`);
    }

    const callId = `call_${randomBytes(18).toString("base64url")}`;
    if (tool.freeform) {
      const object = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
        ? call.arguments as Record<string, unknown>
        : undefined;
      const input = typeof call.input === "string"
        ? call.input
        : typeof object?.input === "string"
          ? object.input
          : undefined;
      if (input === undefined) {
        malformed(`ChatGPT Responses tool relay freeform call ${call.name} requires a string input`);
      }
      return { callId, wireName: call.name, freeform: true, input };
    }

    return {
      callId,
      wireName: call.name,
      freeform: false,
      arguments: objectArguments(call.arguments, call.name),
    };
  });

  return { type: "tools", requests };
}
