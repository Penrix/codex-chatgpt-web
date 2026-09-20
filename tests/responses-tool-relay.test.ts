import { expect, test } from "bun:test";
import {
  CHATGPT_RESPONSES_TOOL_RELAY_CLOSE,
  CHATGPT_RESPONSES_TOOL_RELAY_OPEN,
  parseResponsesToolRelayAnswer,
  responsesToolRelayCatalog,
  responsesToolRelayEnabled,
} from "../src/adapters/chatgpt-web/responses-tool-relay";
import { compileChatGptWebPrompt, chatGptReadOnlyContextWarning } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest, CodexTool } from "../src/types";

const shellTool: CodexTool = {
  name: "exec_command",
  description: "Run a local command",
  parameters: {
    type: "object",
    properties: { cmd: { type: "string" } },
    required: ["cmd"],
    additionalProperties: false,
  },
};

const patchTool: CodexTool = {
  name: "apply_patch",
  description: "Apply a patch",
  parameters: {},
  freeform: true,
};

function request(tools: CodexTool[] = [shellTool]): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["system"],
      messages: [{ role: "user", content: "inspect my computer", timestamp: 1 }],
      tools,
    },
    stream: true,
    options: { reasoning: "high" },
  };
}

const browserOnly = {
  localToolsEnabled: false,
  solAvailable: true,
  extraHighAvailable: true,
  proAvailable: false,
};

test("browser-only turns automatically expose Codex-advertised tools through the Responses relay", () => {
  const parsed = request();
  expect(responsesToolRelayEnabled(parsed, browserOnly)).toBe(false);
  expect(responsesToolRelayEnabled(parsed, browserOnly, true)).toBe(true);
  expect(chatGptReadOnlyContextWarning(parsed, browserOnly)).toStartWith("> **Local tools unavailable**");
  expect(chatGptReadOnlyContextWarning(parsed, browserOnly, true)).toBeUndefined();

  const compiled = compileChatGptWebPrompt(parsed, browserOnly, undefined, {
    responsesToolRelay: true,
  });
  expect(compiled.text).toContain("<codex_native_tools_json>");
  expect(compiled.text).toContain('"wire_name":"exec_command"');
  expect(compiled.text).toContain(CHATGPT_RESPONSES_TOOL_RELAY_OPEN);
  expect(compiled.text).toContain(CHATGPT_RESPONSES_TOOL_RELAY_CLOSE);
  expect(compiled.text).not.toContain("cannot access the local Codex computer in this turn");
});

test("retained relay continuation can omit the unchanged tool catalog without disabling relay instructions", () => {
  const parsed = request();
  const compiled = compileChatGptWebPrompt(parsed, browserOnly, undefined, {
    responsesToolRelay: true,
    responsesToolRelayCatalog: false,
  });
  expect(compiled.text).not.toContain("<codex_native_tools_json>");
  expect(compiled.text).not.toContain('"wire_name":"exec_command"');
  expect(compiled.text).toContain("unchanged Responses tool relay catalog already present earlier");
  expect(compiled.text).toContain(CHATGPT_RESPONSES_TOOL_RELAY_OPEN);
  expect(compiled.text).toContain(CHATGPT_RESPONSES_TOOL_RELAY_CLOSE);
});

test("relay catalog preserves namespaced wire names and tool kinds", () => {
  const catalog = JSON.parse(responsesToolRelayCatalog([
    { ...shellTool, name: "read", namespace: "mcp__files" },
    patchTool,
    { ...shellTool, name: "tool_search", toolSearch: true },
  ])) as { tools: Array<Record<string, unknown>> };

  expect(catalog.tools[0]?.wire_name).toBe("mcp__files__read");
  expect(catalog.tools[1]?.freeform).toBe(true);
  expect(catalog.tools[2]?.tool_search).toBe(true);
});

test("relay answer parser converts JSON calls into broker requests", () => {
  const answer = [
    CHATGPT_RESPONSES_TOOL_RELAY_OPEN,
    JSON.stringify({
      calls: [
        { name: "exec_command", arguments: { cmd: "Get-Location" } },
        { name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      ],
    }),
    CHATGPT_RESPONSES_TOOL_RELAY_CLOSE,
  ].join("\n");

  const parsed = parseResponsesToolRelayAnswer(answer, [shellTool, patchTool]);
  expect(parsed.type).toBe("tools");
  if (parsed.type !== "tools") throw new Error("expected tool relay");
  expect(parsed.requests).toHaveLength(2);
  expect(parsed.requests[0]).toMatchObject({
    wireName: "exec_command",
    freeform: false,
    arguments: { cmd: "Get-Location" },
  });
  expect(parsed.requests[0]?.callId).toStartWith("call_");
  expect(parsed.requests[1]).toMatchObject({
    wireName: "apply_patch",
    freeform: true,
    input: "*** Begin Patch\n*** End Patch",
  });
});

test("single-call relay objects are normalized to one tool request", () => {
  const answer = [
    CHATGPT_RESPONSES_TOOL_RELAY_OPEN,
    JSON.stringify({
      calls: { name: "exec_command", arguments: { cmd: "Get-Location" } },
    }),
    CHATGPT_RESPONSES_TOOL_RELAY_CLOSE,
  ].join("\n");

  const parsed = parseResponsesToolRelayAnswer(answer, [shellTool]);
  expect(parsed.type).toBe("tools");
  if (parsed.type !== "tools") throw new Error("expected tool relay");
  expect(parsed.requests).toHaveLength(1);
  expect(parsed.requests[0]).toMatchObject({
    wireName: "exec_command",
    arguments: { cmd: "Get-Location" },
  });
});

test("Markdown-escaped relay envelopes and fenced JSON remain tool calls", () => {
  const cmd = 'Get-ChildItem | Where-Object { $_.Name -like "*test*" }';
  const envelope = [
    CHATGPT_RESPONSES_TOOL_RELAY_OPEN,
    JSON.stringify({ calls: [{ name: "exec_command", arguments: { cmd } }] }),
    CHATGPT_RESPONSES_TOOL_RELAY_CLOSE,
  ].join("\n");

  const escaped = envelope.replace(/([_*<>\[\]])/g, "\\$1");
  for (const answer of [
    escaped,
    [String.fromCharCode(96).repeat(3) + "json", envelope, String.fromCharCode(96).repeat(3)].join("\n"),
  ]) {
    const parsed = parseResponsesToolRelayAnswer(answer, [shellTool]);
    expect(parsed.type).toBe("tools");
    if (parsed.type !== "tools") throw new Error("expected tool relay");
    expect(parsed.requests[0]).toMatchObject({
      wireName: "exec_command",
      arguments: { cmd },
    });
  }
});

test("malformed Markdown relay text cannot leak as an ordinary answer", () => {
  const escapedOpen = CHATGPT_RESPONSES_TOOL_RELAY_OPEN.replaceAll("_", "\\_");
  const escapedClose = CHATGPT_RESPONSES_TOOL_RELAY_CLOSE.replaceAll("_", "\\_");
  expect(() => parseResponsesToolRelayAnswer(
    escapedOpen + '{"calls":[{"name":"exec_command","arguments":{"cmd":"broken "quote""}}]}' + escapedClose,
    [shellTool],
  )).toThrow("invalid JSON");
  expect(() => parseResponsesToolRelayAnswer(
    "codex_native_tool_calls_json",
    [shellTool],
  )).toThrow("incomplete");
});

test("ordinary final answers pass through unchanged", () => {
  expect(parseResponsesToolRelayAnswer("finished", [shellTool])).toEqual({
    type: "answer",
    answer: "finished",
  });
});

test("relay accepts harmless prose around one valid tool envelope", () => {
  const envelope = (payload: unknown) =>
    `${CHATGPT_RESPONSES_TOOL_RELAY_OPEN}\n${JSON.stringify(payload)}\n${CHATGPT_RESPONSES_TOOL_RELAY_CLOSE}`;

  const parsed = parseResponsesToolRelayAnswer(
    ["I will check that locally.", "", String.fromCharCode(96).repeat(3) + "json", envelope({ calls: [{ name: "exec_command", arguments: { cmd: "dir" } }] }), String.fromCharCode(96).repeat(3), "I will continue after the result."].join("\\n"),
    [shellTool],
  );
  expect(parsed.type).toBe("tools");
  if (parsed.type !== "tools") throw new Error("expected tool relay");
  expect(parsed.requests[0]).toMatchObject({
    wireName: "exec_command",
    arguments: { cmd: "dir" },
  });
});

test("relay rejects unknown tools, malformed arguments, duplicate envelopes, and empty batches", () => {
  const envelope = (payload: unknown) =>
    `${CHATGPT_RESPONSES_TOOL_RELAY_OPEN}\n${JSON.stringify(payload)}\n${CHATGPT_RESPONSES_TOOL_RELAY_CLOSE}`;

  expect(() => parseResponsesToolRelayAnswer(
    envelope({ calls: [{ name: "missing_tool", arguments: {} }] }),
    [shellTool],
  )).toThrow("unavailable");

  expect(() => parseResponsesToolRelayAnswer(
    envelope({ calls: [{ name: "exec_command", arguments: "dir" }] }),
    [shellTool],
  )).toThrow("JSON object");

  expect(() => parseResponsesToolRelayAnswer(
    envelope({ calls: [{ name: "exec_command", arguments: { cmd: "dir" } }] })
      + "\n"
      + envelope({ calls: [{ name: "exec_command", arguments: { cmd: "pwd" } }] }),
    [shellTool],
  )).toThrow("more than one");

  expect(() => parseResponsesToolRelayAnswer(envelope({ calls: [] }), [shellTool]))
    .toThrow("between 1 and 8");
});

test("relay stays disabled for compaction and official Full harness turns", () => {
  const compact = request();
  compact._compactionRequest = true;
  expect(responsesToolRelayEnabled(compact, browserOnly, true)).toBe(false);
  expect(responsesToolRelayEnabled(request(), {
    ...browserOnly,
    localToolsEnabled: true,
  }, true)).toBe(false);
});
