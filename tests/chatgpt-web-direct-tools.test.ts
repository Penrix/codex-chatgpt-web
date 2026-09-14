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
  test("advertises exact wire names and schemas without MCP capability handles", () => {
    const text = chatGptDirectToolProtocolLines(request()).join("\n");
    expect(text).toContain('"name":"read_file"');
    expect(text).toContain('"name":"mcp__python__run_script"');
    expect(text).toContain('"freeform":true');
    expect(text).not.toContain("turn_token");
    expect(text).not.toContain("Codex Native2");
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
        { id: "call_read", name: "read_file", arguments: { path: "README.md" } },
        { id: "call_patch", name: "apply_patch", arguments: { input: "*** Begin Patch\n*** End Patch" } },
        { id: "call_python", name: "mcp__python__run_script", arguments: { code: "print(1)" } },
      ],
    }), request(), "round-b");
    expect(outcome).toEqual({
      kind: "tool_calls",
      requests: [
        { callId: "call_read", wireName: "read_file", freeform: false, arguments: { path: "README.md" } },
        { callId: "call_patch", wireName: "apply_patch", freeform: true, input: "*** Begin Patch\n*** End Patch" },
        { callId: "call_python", wireName: "mcp__python__run_script", freeform: false, arguments: { code: "print(1)" } },
      ],
    });
  });

  test("derives a stable call id when the browser omits one", () => {
    const raw = '{"kind":"tool_calls","tool_calls":[{"name":"read_file","arguments":{"path":"README.md"}}]}';
    const first = parseChatGptDirectToolOutcome(raw, request(), "round-c");
    const second = parseChatGptDirectToolOutcome(raw, request(), "round-c");
    expect(first).toEqual(second);
    expect(first.kind).toBe("tool_calls");
    if (first.kind === "tool_calls") expect(first.requests[0]!.callId).toMatch(/^call_web_[a-f0-9]{24}$/);
  });

  test("rejects unavailable tools and tool_choice violations", () => {
    expect(() => parseChatGptDirectToolOutcome(
      '{"kind":"tool_calls","tool_calls":[{"name":"shell_everything","arguments":{}}]}',
      request(),
      "round-d",
    )).toThrow("unavailable Codex tool");
    expect(() => parseChatGptDirectToolOutcome(
      '{"kind":"tool_calls","tool_calls":[{"name":"apply_patch","arguments":{"input":"x"}}]}',
      request({ toolChoice: { name: "read_file" } }),
      "round-e",
    )).toThrow("outside the active tool_choice");
  });

  test("enforces required and non-parallel tool policies", () => {
    expect(() => parseChatGptDirectToolOutcome(
      '{"kind":"final","content":"done"}',
      request({ toolChoice: "required" }),
      "round-f",
    )).toThrow("requires a tool call");
    expect(() => parseChatGptDirectToolOutcome(JSON.stringify({
      kind: "tool_calls",
      tool_calls: [
        { name: "read_file", arguments: { path: "a" } },
        { name: "read_file", arguments: { path: "b" } },
      ],
    }), request({ parallelToolCalls: false }), "round-g")).toThrow("disabled parallel_tool_calls");
  });

  test("fails closed on prose-wrapped or malformed protocol output", () => {
    expect(() => parseChatGptDirectToolOutcome(
      'Here you go: {"kind":"final","content":"done"}',
      request(),
      "round-h",
    )).toThrow("not one complete JSON object");
    expect(() => parseChatGptDirectToolOutcome(
      '{"kind":"tool_calls","tool_calls":[]}',
      request(),
      "round-i",
    )).toThrow("at least one tool call");
  });
});
