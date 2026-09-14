import { describe, expect, test } from "bun:test";
import {
  chatGptDirectToolProtocolLines,
  parseChatGptDirectToolOutcome,
} from "../src/adapters/chatgpt-web/direct-tools";
import type { CodexParsedRequest, CodexTool } from "../src/types";

const tools: CodexTool[] = [
  {
    name: "read_file",
    description: "Read one file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "apply_patch",
    description: "Apply a patch",
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
    freeform: true,
  },
  {
    namespace: "mcp__python",
    name: "run_script",
    description: "Run Python",
    parameters: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  },
];

function request(overrides: Partial<CodexParsedRequest["options"]> = {}): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: { messages: [], tools },
    options: { toolChoice: "auto", parallelToolCalls: true, ...overrides },
  };
}

describe("ChatGPT Web direct tool protocol", () => {
  test("advertises exact native wire names and schemas without MCP capability handles", () => {
    const text = chatGptDirectToolProtocolLines(request()).join("\n");
    expect(text).toContain('"name":"read_file"');
    expect(text).toContain('"name":"mcp__python__run_script"');
    expect(text).toContain('"freeform":true');
    expect(text).toContain('"required":["path"]');
    expect(text).not.toContain("turn_token");
    expect(text).not.toContain("Codex Native2");
  });

  test("preserves the complete native description instead of inventing a second tool compressor", () => {
    const nativeExecDescription = `Run JavaScript with native Codex tools.\n${"nested-tool-contract ".repeat(300)}`;
    const parsed: CodexParsedRequest = {
      modelId: "gpt-5.6-sol",
      stream: true,
      context: {
        messages: [],
        tools: [{
          name: "exec",
          description: nativeExecDescription,
          parameters: {},
          freeform: true,
        }],
      },
      options: { toolChoice: "auto", parallelToolCalls: true },
    };
    const text = chatGptDirectToolProtocolLines(parsed).join("\n");
    expect(text).toContain(nativeExecDescription);
    expect(text).not.toContain("description truncated by browser transport");
    expect(text).not.toContain("omitted_native_tools");
    expect(text).not.toContain("exec_gateway");
  });

  test("keeps only an explicitly selected tool visible when Codex supplies tool_choice", () => {
    const selected: CodexTool = {
      namespace: "mcp__github",
      name: "search_code",
      description: "Search code",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    };
    const parsed: CodexParsedRequest = {
      modelId: "gpt-5.6-sol",
      stream: true,
      context: {
        messages: [],
        tools: [
          { name: "exec", description: "gateway", parameters: {}, freeform: true },
          selected,
        ],
      },
      options: { toolChoice: { name: "mcp__github__search_code" }, parallelToolCalls: true },
    };
    const text = chatGptDirectToolProtocolLines(parsed).join("\n");
    expect(text).toContain('"name":"mcp__github__search_code"');
    expect(text).not.toContain('"name":"exec"');
  });

  test("makes the JSON-schema final contract explicit inside the transport envelope", () => {
    const text = chatGptDirectToolProtocolLines(request()).join("\n");
    expect(text).toContain("content must contain the complete serialized JSON value");
    expect(text).toContain("outer kind/content envelope is transport only");
  });

  test("parses a final envelope and tolerates one JSON fence", () => {
    expect(parseChatGptDirectToolOutcome(
      '```json\n{"kind":"final","content":"done"}\n```',
      request(),
      "round-a",
    )).toEqual({ kind: "final", content: "done" });
  });

  test("maps ordinary, freeform, and namespaced calls to native broker requests", () => {
    const outcome = parseChatGptDirectToolOutcome(JSON.stringify({
      kind: "tool_calls",
      tool_calls: [
        { id: "model_supplied_read", name: "read_file", arguments: { path: "README.md" } },
        { id: "model_supplied_patch", name: "apply_patch", arguments: { input: "*** Begin Patch\n*** End Patch" } },
        { id: "model_supplied_python", name: "mcp__python__run_script", arguments: { code: "print(1)" } },
      ],
    }), request(), "round-b");
    expect(outcome.kind).toBe("tool_calls");
    if (outcome.kind !== "tool_calls") return;
    expect(outcome.requests.map(call => ({
      wireName: call.wireName,
      freeform: call.freeform,
      ...(call.freeform ? { input: call.input } : { arguments: call.arguments }),
    }))).toEqual([
      { wireName: "read_file", freeform: false, arguments: { path: "README.md" } },
      { wireName: "apply_patch", freeform: true, input: "*** Begin Patch\n*** End Patch" },
      { wireName: "mcp__python__run_script", freeform: false, arguments: { code: "print(1)" } },
    ]);
    expect(outcome.requests.every(call => /^call_web_[a-f0-9]{24}$/.test(call.callId))).toBe(true);
    expect(new Set(outcome.requests.map(call => call.callId)).size).toBe(3);
    expect(outcome.requests.every(call => !call.callId.startsWith("model_supplied_"))).toBe(true);
  });

  test("derives call ids only from canonical round and call content, never browser-provided ids", () => {
    const first = parseChatGptDirectToolOutcome(
      '{"kind":"tool_calls","tool_calls":[{"id":"browser_a","name":"read_file","arguments":{"path":"README.md","mode":"text"}}]}',
      request(),
      "round-c",
    );
    const sameSemanticCall = parseChatGptDirectToolOutcome(
      '{"kind":"tool_calls","tool_calls":[{"id":"browser_b","name":"read_file","arguments":{"mode":"text","path":"README.md"}}]}',
      request(),
      "round-c",
    );
    const nextRound = parseChatGptDirectToolOutcome(
      '{"kind":"tool_calls","tool_calls":[{"id":"browser_a","name":"read_file","arguments":{"path":"README.md","mode":"text"}}]}',
      request(),
      "round-d",
    );
    expect(first.kind).toBe("tool_calls");
    expect(sameSemanticCall.kind).toBe("tool_calls");
    expect(nextRound.kind).toBe("tool_calls");
    if (first.kind !== "tool_calls" || sameSemanticCall.kind !== "tool_calls" || nextRound.kind !== "tool_calls") return;
    expect(first.requests[0]!.callId).toBe(sameSemanticCall.requests[0]!.callId);
    expect(first.requests[0]!.callId).not.toBe(nextRound.requests[0]!.callId);
  });

  test("rejects unavailable tools and tool_choice violations", () => {
    expect(() => parseChatGptDirectToolOutcome(
      '{"kind":"tool_calls","tool_calls":[{"name":"shell_everything","arguments":{}}]}',
      request(),
      "round-e",
    )).toThrow("unavailable Codex tool");
    expect(() => parseChatGptDirectToolOutcome(
      '{"kind":"tool_calls","tool_calls":[{"name":"apply_patch","arguments":{"input":"x"}}]}',
      request({ toolChoice: { name: "read_file" } }),
      "round-f",
    )).toThrow("unavailable Codex tool");
  });

  test("enforces required and non-parallel tool policies", () => {
    expect(() => parseChatGptDirectToolOutcome(
      '{"kind":"final","content":"done"}',
      request({ toolChoice: "required" }),
      "round-g",
    )).toThrow("requires a tool call");
    expect(() => parseChatGptDirectToolOutcome(JSON.stringify({
      kind: "tool_calls",
      tool_calls: [
        { name: "read_file", arguments: { path: "a" } },
        { name: "read_file", arguments: { path: "b" } },
      ],
    }), request({ parallelToolCalls: false }), "round-h")).toThrow("disabled parallel_tool_calls");
  });

  test("fails closed on prose-wrapped or malformed protocol output", () => {
    expect(() => parseChatGptDirectToolOutcome(
      'Here you go: {"kind":"final","content":"done"}',
      request(),
      "round-i",
    )).toThrow("not one complete JSON object");
    expect(() => parseChatGptDirectToolOutcome(
      '{"kind":"tool_calls","tool_calls":[]}',
      request(),
      "round-j",
    )).toThrow("at least one tool call");
  });
});
