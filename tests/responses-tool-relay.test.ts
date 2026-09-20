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
  expect(responsesToolRelayEnabled(parsed, browserOnly)).toBe(true);
  expect(chatGptReadOnlyContextWarning(parsed, browserOnly)).toBeUndefined();

  const compiled = compileChatGptWebPrompt(parsed, browserOnly);
  expect(compiled.text).toContain("<codex_native_tools_json>");
  expect(compiled.text).toContain('"wire_name":"exec_command"');
  expect(compiled.text).toContain(CHATGPT_RESPONSES_TOOL_RELAY_OPEN);
  expect(compiled.text).toContain(CHATGPT_RESPONSES_TOOL_RELAY_CLOSE);
  expect(compiled.text).not.toContain("cannot access the local Codex computer in this turn");
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

test("ordinary final answers pass through unchanged", () => {
  expect(parseResponsesToolRelayAnswer("finished", [shellTool])).toEqual({
    type: "answer",
    answer: "finished",
  });
});

test("relay rejects mixed prose, unknown tools, malformed arguments, and empty batches", () => {
  const envelope = (payload: unknown) =>
    `${CHATGPT_RESPONSES_TOOL_RELAY_OPEN}\n${JSON.stringify(payload)}\n${CHATGPT_RESPONSES_TOOL_RELAY_CLOSE}`;

  expect(() => parseResponsesToolRelayAnswer(
    `I will run it.\n${envelope({ calls: [{ name: "exec_command", arguments: { cmd: "dir" } }] })}`,
    [shellTool],
  )).toThrow("mixed");

  expect(() => parseResponsesToolRelayAnswer(
    envelope({ calls: [{ name: "missing_tool", arguments: {} }] }),
    [shellTool],
  )).toThrow("unavailable");

  expect(() => parseResponsesToolRelayAnswer(
    envelope({ calls: [{ name: "exec_command", arguments: "dir" }] }),
    [shellTool],
  )).toThrow("JSON object");

  expect(() => parseResponsesToolRelayAnswer(envelope({ calls: [] }), [shellTool]))
    .toThrow("between 1 and 8");
});

test("relay stays disabled for compaction and official Full harness turns", () => {
  const compact = request();
  compact._compactionRequest = true;
  expect(responsesToolRelayEnabled(compact, browserOnly)).toBe(false);
  expect(responsesToolRelayEnabled(request(), {
    ...browserOnly,
    localToolsEnabled: true,
  })).toBe(false);
});
