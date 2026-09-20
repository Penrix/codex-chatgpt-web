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
  configured = false,
): boolean {
  return configured
    && !parsed._compactionRequest
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

function relayDiagnostic(
  event: "answer" | "tools" | "malformed",
  details: Record<string, string | number | boolean | undefined> = {},
): void {
  const suffix = Object.entries(details)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const line = `[chatgpt-web] responses_tool_relay event=${event}${suffix ? ` ${suffix}` : ""}`;
  if (event === "malformed") console.warn(line);
  else console.info(line);
}

function malformed(
  message: string,
  reason = "invalid",
  details: Record<string, string | number | boolean | undefined> = {},
): never {
  relayDiagnostic("malformed", { reason, ...details });
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

/**
 * The browser returns Markdown, which can escape punctuation in plain text.
 * Remove only Markdown escapes used by the relay envelope and JSON structure.
 * Preserve even backslash runs, including ordinary JSON escaping.
 */
function unescapeRelayMarkdown(text: string): string {
  return text.replace(/(\\+)([_*<>\[\]])/g, (match, slashes: string, punctuation: string) =>
    slashes.length % 2 === 1 ? slashes.slice(1) + punctuation : match);
}

function unwrapRelayCodeFence(text: string): string {
  const match = /^\x60{3}(?:json|text)?\r?\n([\s\S]*?)\r?\n\x60{3}$/.exec(text);
  return match ? match[1]!.trim() : text;
}

export type ResponsesToolRelayResult =
  | { type: "answer"; answer: string }
  | { type: "tools"; requests: BrokerToolRequest[] };

export function parseResponsesToolRelayAnswer(
  answer: string,
  tools: readonly CodexTool[],
): ResponsesToolRelayResult {
  const normalized = unescapeRelayMarkdown(answer);
  const normalizedMarkdown = normalized !== answer;
  const normalizedTrimmed = normalized.trim();
  const trimmed = unwrapRelayCodeFence(normalizedTrimmed);
  const fenced = trimmed !== normalizedTrimmed || normalizedTrimmed.includes("```");
  const openIndex = normalized.indexOf(CHATGPT_RESPONSES_TOOL_RELAY_OPEN);
  const closeIndex = openIndex >= 0
    ? normalized.indexOf(CHATGPT_RESPONSES_TOOL_RELAY_CLOSE, openIndex + CHATGPT_RESPONSES_TOOL_RELAY_OPEN.length)
    : -1;
  const hasOpen = openIndex >= 0;
  const hasClose = normalized.includes(CHATGPT_RESPONSES_TOOL_RELAY_CLOSE);

  // A damaged relay marker must never become visible as an ordinary answer.
  if (!hasOpen && !hasClose) {
    if (/codex_native_tool_calls_json/.test(normalized)) {
      malformed("ChatGPT returned an incomplete Responses tool relay marker", "incomplete_marker", {
        answerChars: answer.length,
        normalizedMarkdown,
        fenced,
      });
    }
    relayDiagnostic("answer", { answerChars: answer.length });
    return { type: "answer", answer };
  }

  if (!hasOpen || closeIndex < 0) {
    malformed("ChatGPT returned an incomplete Responses tool relay marker", "incomplete_marker", {
      answerChars: answer.length,
      normalizedMarkdown,
      fenced,
    });
  }

  const afterClose = closeIndex + CHATGPT_RESPONSES_TOOL_RELAY_CLOSE.length;
  if (
    normalized.indexOf(CHATGPT_RESPONSES_TOOL_RELAY_OPEN, openIndex + CHATGPT_RESPONSES_TOOL_RELAY_OPEN.length) >= 0
    || normalized.indexOf(CHATGPT_RESPONSES_TOOL_RELAY_CLOSE, afterClose) >= 0
  ) {
    malformed("ChatGPT returned more than one Responses tool relay envelope", "multiple_envelopes", {
      answerChars: answer.length,
      normalizedMarkdown,
      fenced,
    });
  }

  const prefix = normalized.slice(0, openIndex);
  const suffix = normalized.slice(afterClose);
  const surrounding = `${prefix}${suffix}`
    .replace(/```(?:json|text)?/g, "")
    .trim();
  const mixedTextChars = surrounding.length;

  const payloadText = normalized.slice(
    openIndex + CHATGPT_RESPONSES_TOOL_RELAY_OPEN.length,
    closeIndex,
  ).trim();

  let payload: RelayPayload;
  try {
    payload = JSON.parse(payloadText) as RelayPayload;
  } catch {
    malformed("ChatGPT returned invalid JSON in the Responses tool relay envelope", "invalid_json", {
      payloadChars: payloadText.length,
      normalizedMarkdown,
      fenced,
    });
  }

  let calls: unknown[];
  let normalizedSingleCall = false;
  if (Array.isArray(payload.calls)) {
    calls = payload.calls;
  } else if (payload.calls && typeof payload.calls === "object") {
    // Some ChatGPT Web renders collapse a one-item calls array into the object itself.
    // Accept that narrow compatibility shape and normalize it back to the canonical batch form.
    calls = [payload.calls];
    normalizedSingleCall = true;
  } else {
    malformed("ChatGPT Responses tool relay must contain a calls array or one call object", "invalid_calls_shape", {
      normalizedMarkdown,
      fenced,
    });
  }

  if (calls.length < 1 || calls.length > 8) {
    malformed("ChatGPT Responses tool relay must contain between 1 and 8 calls", "invalid_call_count", {
      callCount: calls.length,
      normalizedMarkdown,
      fenced,
    });
  }

  const available = new Map(
    tools.map(tool => [namespacedToolName(tool.namespace, tool.name), tool] as const),
  );
  const requests: BrokerToolRequest[] = calls.map((raw, index) => {
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

  relayDiagnostic("tools", {
    callCount: requests.length,
    wireNames: requests.map(request => request.wireName).join(","),
    normalizedMarkdown,
    normalizedSingleCall,
    fenced,
    mixedTextChars,
  });
  return { type: "tools", requests };
}
