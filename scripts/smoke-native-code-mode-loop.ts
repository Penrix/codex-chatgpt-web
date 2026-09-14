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

function flattenModelTools(values: unknown[]): Record<string, unknown>[] {
  const flattened: Record<string, unknown>[] = [];
  for (const value of values) {
    const tool = record(value);
    if (!tool) continue;
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      flattened.push(...flattenModelTools(tool.tools));
      continue;
    }
    flattened.push(tool);
  }
  return flattened;
}

function requestModelTools(body: Record<string, unknown>): { tools: Record<string, unknown>[]; source: "top-level" | "additional_tools" } {
  if (Array.isArray(body.tools)) return { tools: flattenModelTools(body.tools), source: "top-level" };
  if (Array.isArray(body.input)) {
    const additional = body.input
      .map(record)
      .find(item => item?.type === "additional_tools");
    if (additional && Array.isArray(additional.tools)) {
      return { tools: flattenModelTools(additional.tools), source: "additional_tools" };
    }
  }
  throw new Error(`Native loop request exposed no tools: keys=${JSON.stringify(Object.keys(body))} input=${JSON.stringify(body.input)}`);
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
    item: {
      type: "custom_tool_call",
      call_id: callId,
      name,
      input,
    },
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
  }).join("");
}

function findCustomToolOutput(body: Record<string, unknown>, callId: string): Record<string, unknown> | undefined {
  if (!Array.isArray(body.input)) return undefined;
  return body.input
    .map(record)
    .find(item => item?.type === "custom_tool_call_output" && item.call_id === callId);
}

const codex = resolve(process.argv[2] ?? "codex");
const root = mkdtempSync(join(tmpdir(), `codex-web-gpt-native-loop-${process.pid}-`));
const codexHome = join(root, "codex-home");
const workspace = join(root, "workspace");
mkdirSync(codexHome, { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "README.md"), "# native loop smoke\n\nOfficial Codex Code Mode loop.\n");

const callId = "native-code-mode-exec-1";
const marker = "CODE_MODE_NATIVE_EXEC_OK";
const finalText = "NATIVE_CODE_MODE_LOOP_DONE";
const requests: Record<string, unknown>[] = [];
let serverFailure: Error | undefined;
let firstToolSource: "top-level" | "additional_tools" | undefined;

let secondRequestResolve!: (body: Record<string, unknown>) => void;
let secondRequestReject!: (error: Error) => void;
const secondRequest = new Promise<Record<string, unknown>>((resolveRequest, rejectRequest) => {
  secondRequestResolve = resolveRequest;
  secondRequestReject = rejectRequest;
});
let secondRequestSettled = false;

const code = [
  `const result = await tools.exec_command({ cmd: ${JSON.stringify(`Write-Output ${marker}`)}, yield_time_ms: 10000 });`,
  "text(JSON.stringify(result));",
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
    if (!secondRequestSettled) {
      secondRequestSettled = true;
      secondRequestReject(normalized);
    }
  });
  request.on("end", () => {
    try {
      const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      assert(body, "Native loop Responses request is not an object");
      requests.push(body);

      if (requests.length === 1) {
        const modelTools = requestModelTools(body);
        firstToolSource = modelTools.source;
        const names = modelTools.tools
          .map(tool => typeof tool.name === "string" ? tool.name : undefined)
          .filter((name): name is string => Boolean(name));
        assert(names.includes("exec"), `First native loop request did not advertise exec: ${JSON.stringify(names)}`);
        assert(names.includes("wait"), `First native loop request did not advertise wait: ${JSON.stringify(names)}`);
        assert(modelTools.source === "additional_tools",
          `Sol-derived High should use Responses Lite additional_tools, got ${modelTools.source}`);
        sendSse(response, [
          responseCreated("native-loop-1"),
          customToolCall(callId, "exec", code),
          responseCompleted("native-loop-1"),
        ]);
        return;
      }

      if (requests.length === 2) {
        const output = findCustomToolOutput(body, callId);
        assert(output, `Second native loop request did not contain custom_tool_call_output(${callId}): ${JSON.stringify(body.input)}`);
        const text = outputText(output.output);
        assert(text.includes(marker), `Native exec output did not contain nested exec_command marker: ${JSON.stringify(text)}`);
        assert(/exit[_ ]code/i.test(text), `Native exec output did not expose command completion: ${JSON.stringify(text)}`);
        if (!secondRequestSettled) {
          secondRequestSettled = true;
          secondRequestResolve(body);
        }
        sendSse(response, [
          responseCreated("native-loop-2"),
          assistantMessage("native-loop-final", finalText),
          responseCompleted("native-loop-2"),
        ]);
        return;
      }

      throw new Error(`Native loop unexpectedly issued ${requests.length} Responses requests`);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      serverFailure ??= normalized;
      if (!secondRequestSettled) {
        secondRequestSettled = true;
        secondRequestReject(normalized);
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
  assert(address && typeof address === "object", "Native loop server has no TCP address");

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
    `model_provider = "native_loop"`,
    `model_catalog_json = ${tomlString(catalogPath)}`,
    "",
    "[model_providers.native_loop]",
    `name = "Native Code Mode Loop"`,
    `base_url = ${tomlString(baseUrl)}`,
    `env_key = "CODEX_NATIVE_LOOP_KEY"`,
    `wire_api = "responses"`,
    "",
  ].join("\n"));

  const child = spawn(codex, [
    "exec",
    "--model", "chatgpt-web/high",
    "--sandbox", "workspace-write",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color", "never",
    "Run the requested local check and report its result.",
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_NATIVE_LOOP_KEY: "native-loop-key",
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
      `Timed out waiting for native Code Mode loop. requests=${requests.length} stdout=${JSON.stringify(childStdout.slice(-3000))} stderr=${JSON.stringify(childStderr.slice(-6000))}`,
    )), 45_000);
    timer.unref?.();
  });

  await Promise.race([secondRequest, timeout]);
  const exit = await Promise.race([childExit, timeout]);
  assert(!serverFailure, `Native loop server failed: ${serverFailure?.message}`);
  assert(exit.code === 0, `Native Codex loop exited ${exit.code ?? exit.signal}: stdout=${JSON.stringify(childStdout)} stderr=${JSON.stringify(childStderr)}`);
  assert(requests.length === 2, `Expected exactly two Responses rounds, got ${requests.length}`);
  assert(childStdout.includes(finalText) || childStderr.includes(finalText),
    `Native Codex did not surface the final model answer: stdout=${JSON.stringify(childStdout)} stderr=${JSON.stringify(childStderr)}`);

  process.stdout.write(`NATIVE_CODE_MODE_LOOP_SMOKE_OK source=${firstToolSource} requests=${requests.length} marker=${marker}\n`);
} finally {
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    process.stderr.write(`native loop cleanup warning: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
