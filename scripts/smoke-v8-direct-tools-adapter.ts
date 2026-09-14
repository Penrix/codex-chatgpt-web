import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const provider: CodexProviderConfig = {
  adapter: "chatgpt-web",
  baseUrl: `browser://v8-direct-tools-smoke-${process.pid}-${Date.now()}`,
  chatgptWeb: {
    localToolsEnabled: true,
    solAvailable: true,
    proAvailable: false,
  },
};

function nativeRequest(input: unknown[], messages: CodexParsedRequest["context"]["messages"]): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      tools: [{
        name: "read_file",
        description: "Read one file from the active Codex workspace",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
      messages,
    },
    options: { reasoning: "high", toolChoice: "auto", parallelToolCalls: true },
    _rawBody: {
      prompt_cache_key: "thread_v8_direct_tools_smoke",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_v8_direct_tools_smoke",
          turn_id: "turn_v8_direct_tools_smoke",
        }),
      },
      input,
    },
  };
}

const firstInput = [{
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Read README.md before answering." }],
  internal_chat_message_metadata_passthrough: { turn_id: "turn_v8_direct_tools_smoke" },
}];

const first = nativeRequest(firstInput, [
  { role: "user", content: "Read README.md before answering.", timestamp: 1 },
]);

const worker = ChatGptBrowserWorker.forProvider(provider);
const originalRun = worker.run.bind(worker);
let browserStarts = 0;
let preparedPrompt = "";

(worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
  browserStarts += 1;
  assert(turn.capabilities.localToolsEnabled === false, "Direct tool browser turn must not expose browser-local MCP tools");
  const prepared = await turn.prepare();
  preparedPrompt = prepared.text;
  prepared.release();
  const answer = JSON.stringify({
    kind: "tool_calls",
    tool_calls: [{
      id: "call_readme",
      name: "read_file",
      arguments: { path: "README.md" },
    }],
  });
  turn.onTextDelta(answer);
  return answer;
};

try {
  const events: AdapterEvent[] = [];
  await createChatGptWebAdapter(provider).runTurn!(first, { headers: new Headers() }, event => events.push(event));

  assert(browserStarts === 1, `Expected one browser turn, got ${browserStarts}`);
  assert(preparedPrompt.includes("Codex browser tool protocol"), "Direct tool protocol was not injected into the browser prompt");
  assert(preparedPrompt.includes('"name":"read_file"'), "Active Codex tool catalog was not serialized into the browser prompt");
  assert(!preparedPrompt.includes("turn_token"), "Direct tool prompt leaked the legacy MCP capability token contract");

  const start = events.find(event => event.type === "tool_call_start");
  const delta = events.find(event => event.type === "tool_call_delta");
  const end = events.find(event => event.type === "tool_call_end");
  const done = events.at(-1);
  assert(start?.type === "tool_call_start" && start.id === "call_readme" && start.name === "read_file",
    `Adapter did not emit the native tool_call_start: ${JSON.stringify(events)}`);
  assert(delta?.type === "tool_call_delta" && delta.id === "call_readme" && delta.argumentsDelta.includes("README.md"),
    `Adapter did not emit native tool arguments: ${JSON.stringify(events)}`);
  assert(end?.type === "tool_call_end" && end.id === "call_readme",
    `Adapter did not close the native tool call: ${JSON.stringify(events)}`);
  assert(done?.type === "done" && done.stopReason === "tool_use" && done.endTurn === false,
    `Adapter did not hand execution back to Codex at the tool boundary: ${JSON.stringify(done)}`);
  assert(!events.some(event => event.type === "text_delta"), "Protocol JSON escaped into the user-facing Codex stream");

  process.stdout.write("V8_DIRECT_TOOLS_ADAPTER_SMOKE_OK\n");
} finally {
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
  chatGptTurnSessions.clear();
}
