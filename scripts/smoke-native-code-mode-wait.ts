import { spawn, spawnSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { defaultConfig } from "../src/config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value.replace(/\\/g, "/"));
}

function nativeCatalog(codex: string): Record<string, unknown> {
  const result = spawnSync(codex, ["debug", "models", "--bundled"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error(`Codex bundled catalog discovery failed: ${result.error?.message || result.stderr || result.signal || `exit ${result.status}`}`);
  }
  const parsed = record(JSON.parse(result.stdout));
  assert(parsed, "Codex bundled catalog is not an object");
  return parsed;
}

function sse(events: Record<string, unknown>[]): string {
  return `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function responseCreated(id: string): Record<string, unknown> {
  return { type: "response.created", response: { id } };
}

function responseCompleted(id: string): Record<string, unknown> {
  return { type: "response.completed", response: { id } };
}

function customToolCall(callId: string, name: string, input: string): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    item: { type: "custom_tool_call", call_id: callId, name, input },
  };
}

function functionCall(callId: string, name: string, argumentsJson: string): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    item: { type: "function_call", call_id: callId, name, arguments: argumentsJson },
  };
}

function assistantMessage(id: string, text: string): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id,
      content: [{ type: "output_text", text }],
    },
  };
}

function sendSse(response: ServerResponse, events: Record<string, unknown>[]): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache");
  response.end(sse(events));
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return JSON.stringify(value);
  return value.map(item => {
    const object = record(item);
    return object && typeof object.text === "string" ? object.text : JSON.stringify(item);
  }).join("\n");
}

function findCallOutput(
  body: Record<string, unknown>,
  callId: string,
  type: "custom_tool_call_output" | "function_call_output",
): Record<string, unknown> | undefined {
  if (!Array.isArray(body.input)) return undefined;
  return body.input
    .map(record)
    .find(item => item?.type === type && item.call_id === callId);
}

function runningCellId(text: string): string {
  const match = text.match(/Script running with cell ID ([^\r\n]+)/);
  assert(match?.[1], `Yielded exec output did not expose a running cell id: ${JSON.stringify(text)}`);
  return match[1].trim();
}

const codex = resolve(process.argv[2] ?? "codex");
const root = mkdtempSync(join(tmpdir(), `codex-web-gpt-native-wait-${process.pid}-`));
const codexHome = join(root, "codex-home");
const workspace = join(root, "workspace");
mkdirSync(codexHome, { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "README.md"), "# native wait smoke\n\nOfficial Codex Code Mode yield/wait lifecycle.\n");

const execCallId = "native-code-mode-yield-exec";
const waitCallId = "native-code-mode-wait";
const finalText = "NATIVE_CODE_MODE_WAIT_DONE";
const requests: Record<string, unknown>[] = [];
let serverFailure: Error | undefined;
let observedCellId = "";

let thirdRequestResolve!: (body: Record<string, unknown>) => void;
let thirdRequestReject!: (error: Error) => void;
const thirdRequest = new Promise<Record<string, unknown>>((resolveRequest, rejectRequest) => {
  thirdRequestResolve = resolveRequest;
  thirdRequestReject = rejectRequest;
});
let thirdRequestSettled = false;

const yieldedCode = [
  `text("started");`,
  `yield_control();`,
  `await new Promise(resolveDone => {`,
  `  setTimeout(() => { text("done"); resolveDone(undefined); }, 1500);`,
  `});`,
].join("\n");

const server = createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }

  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(Buffer.from(chunk)));
  request.on("error", error => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    serverFailure ??= normalized;
    if (!thirdRequestSettled) {
      thirdRequestSettled = true;
      thirdRequestReject(normalized);
    }
  });
  request.on("end", () => {
    try {
      const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      assert(body, "Native wait Responses request is not an object");
      requests.push(body);

      if (requests.length === 1) {
        sendSse(response, [
          responseCreated("native-wait-1"),
          customToolCall(execCallId, "exec", yieldedCode),
          responseCompleted("native-wait-1"),
        ]);
        return;
      }

      if (requests.length === 2) {
        const output = findCallOutput(body, execCallId, "custom_tool_call_output");
        assert(output, `Yielded exec did not produce custom_tool_call_output(${execCallId}): ${JSON.stringify(body.input)}`);
        const text = outputText(output.output);
        assert(text.includes("started"), `Yielded exec output lost pre-yield text: ${JSON.stringify(text)}`);
        observedCellId = runningCellId(text);
        sendSse(response, [
          responseCreated("native-wait-2"),
          functionCall(waitCallId, "wait", JSON.stringify({ cell_id: observedCellId, yield_time_ms: 10_000 })),
          responseCompleted("native-wait-2"),
        ]);
        return;
      }

      if (requests.length === 3) {
        const output = findCallOutput(body, waitCallId, "function_call_output");
        assert(output, `wait did not produce function_call_output(${waitCallId}): ${JSON.stringify(body.input)}`);
        const text = outputText(output.output);
        assert(text.includes("done"), `wait output did not contain post-yield completion text: ${JSON.stringify(text)}`);
        if (!thirdRequestSettled) {
          thirdRequestSettled = true;
          thirdRequestResolve(body);
        }
        sendSse(response, [
          responseCreated("native-wait-3"),
          assistantMessage("native-wait-final", finalText),
          responseCompleted("native-wait-3"),
        ]);
        return;
      }

      throw new Error(`Native wait smoke unexpectedly issued ${requests.length} Responses requests`);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      serverFailure ??= normalized;
      if (!thirdRequestSettled) {
        thirdRequestSettled = true;
        thirdRequestReject(normalized);
      }
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { message: normalized.message } }));
    }
  });
});

try {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  assert(address && typeof address === "object", "Native wait server has no TCP address");

  const config = defaultConfig("browser-only");
  config.solAvailable = true;
  config.proAvailable = false;
  config.subagentProtocol = "native";
  const catalog = augmentNativeModelCatalog(nativeCatalog(codex), config);
  const catalogPath = join(root, "model-catalog.json");
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  writeFileSync(join(codexHome, "config.toml"), [
    `model = "chatgpt-web/high"`,
    `model_provider = "native_wait"`,
    `model_catalog_json = ${tomlString(catalogPath)}`,
    "",
    "[model_providers.native_wait]",
    `name = "Native Code Mode Wait"`,
    `base_url = ${tomlString(baseUrl)}`,
    `env_key = "CODEX_NATIVE_WAIT_KEY"`,
    `wire_api = "responses"`,
    "",
  ].join("\n"));

  const child = spawn(codex, [
    "exec",
    "--model", "chatgpt-web/high",
    "--sandbox", "danger-full-access",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color", "never",
    "Run the long task, wait for it when needed, and report completion.",
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_NATIVE_WAIT_KEY: "native-wait-key",
      OPENAI_API_KEY: "",
      CODEX_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let childStdout = "";
  let childStderr = "";
  child.stdout?.on("data", chunk => { childStdout += String(chunk); });
  child.stderr?.on("data", chunk => { childStderr += String(chunk); });
  const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (exitCode, signal) => resolveExit({ code: exitCode, signal }));
  });

  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `Timed out waiting for native Code Mode yield/wait loop. requests=${requests.length} cell=${observedCellId || "<none>"} stdout=${JSON.stringify(childStdout.slice(-3000))} stderr=${JSON.stringify(childStderr.slice(-6000))}`,
    )), 45_000);
    timer.unref?.();
  });

  await Promise.race([thirdRequest, timeout]);
  const exit = await Promise.race([childExit, timeout]);
  assert(!serverFailure, `Native wait server failed: ${serverFailure?.message}`);
  assert(exit.code === 0, `Native Codex wait smoke exited ${exit.code ?? exit.signal}: stdout=${JSON.stringify(childStdout)} stderr=${JSON.stringify(childStderr)}`);
  assert(requests.length === 3, `Expected exactly three Responses rounds, got ${requests.length}`);
  assert(observedCellId.length > 0, "Native wait smoke never observed a Code Mode cell id");
  assert(childStdout.includes(finalText) || childStderr.includes(finalText),
    `Native Codex did not surface the final wait answer: stdout=${JSON.stringify(childStdout)} stderr=${JSON.stringify(childStderr)}`);

  process.stdout.write(`NATIVE_CODE_MODE_WAIT_SMOKE_OK requests=${requests.length} cell=${observedCellId}\n`);
} finally {
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    process.stderr.write(`native wait cleanup warning: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
