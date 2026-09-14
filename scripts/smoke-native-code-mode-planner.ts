import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { defaultConfig } from "../src/config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function tomlString(value: string): string {
  return JSON.stringify(value.replace(/\\/g, "/"));
}

function runCodex(codex: string, args: string[], env = process.env): string {
  const result = spawnSync(codex, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error(`Codex ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.signal || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function nativeCatalog(codex: string): Record<string, unknown> {
  const parsed = JSON.parse(runCodex(codex, ["debug", "models", "--bundled"])) as unknown;
  assert(parsed && typeof parsed === "object" && !Array.isArray(parsed), "Codex bundled catalog is not an object");
  return parsed as Record<string, unknown>;
}

function toolName(tool: unknown): string | undefined {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return undefined;
  const name = (tool as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function toolType(tool: unknown): string | undefined {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return undefined;
  const type = (tool as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function describeTools(tools: unknown[]): string {
  return JSON.stringify(tools.map(tool => ({ type: toolType(tool), name: toolName(tool) })));
}

function codeModeFeatureSummary(text: string): string {
  return text.split(/\r?\n/)
    .filter(line => /^code_mode(?:_host|_only|_prewarm)?\s/.test(line))
    .join(" | ");
}

function terminalSse(): string {
  const events = [
    { type: "response.created", response: { id: "planner-capture" } },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: "planner-capture-message",
        content: [{ type: "output_text", text: "planner capture complete" }],
      },
    },
    { type: "response.completed", response: { id: "planner-capture" } },
  ];
  return `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

const codex = resolve(process.argv[2] ?? "codex");
const root = mkdtempSync(join(tmpdir(), `codex-web-gpt-native-planner-${process.pid}-`));
const codexHome = join(root, "codex-home");
const workspace = join(root, "workspace");
mkdirSync(codexHome, { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "README.md"), "# planner smoke\n\nNative Code Mode planner capture.\n");

let capturedResolve!: (body: Record<string, unknown>) => void;
let capturedReject!: (error: Error) => void;
const captured = new Promise<Record<string, unknown>>((resolveCapture, rejectCapture) => {
  capturedResolve = resolveCapture;
  capturedReject = rejectCapture;
});
let captureSettled = false;

const server = createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(Buffer.from(chunk)));
  request.on("error", error => {
    if (!captureSettled) {
      captureSettled = true;
      capturedReject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  request.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      assert(body && typeof body === "object" && !Array.isArray(body), "Captured Responses body is not an object");
      if (!captureSettled) {
        captureSettled = true;
        capturedResolve(body as Record<string, unknown>);
      }
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("cache-control", "no-cache");
      response.end(terminalSse());
    } catch (error) {
      if (!captureSettled) {
        captureSettled = true;
        capturedReject(error instanceof Error ? error : new Error(String(error)));
      }
      response.statusCode = 400;
      response.end("invalid request");
    }
  });
});

try {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  assert(address && typeof address === "object", "Planner capture server has no TCP address");

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
    `model_provider = "planner_capture"`,
    `model_catalog_json = ${tomlString(catalogPath)}`,
    "",
    "[model_providers.planner_capture]",
    `name = "Planner Capture"`,
    `base_url = ${tomlString(baseUrl)}`,
    `env_key = "CODEX_PLANNER_CAPTURE_KEY"`,
    `wire_api = "responses"`,
    "",
  ].join("\n"));

  const childEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_PLANNER_CAPTURE_KEY: "planner-capture-key",
    OPENAI_API_KEY: "",
    CODEX_API_KEY: "",
  };

  const debugCatalog = JSON.parse(runCodex(codex, ["debug", "models"], childEnv)) as {
    models?: Array<Record<string, unknown>>;
  };
  const debugHigh = debugCatalog.models?.find(model => model.slug === "chatgpt-web/high");
  assert(debugHigh, "Configured Codex catalog did not expose chatgpt-web/high before planner capture");
  assert(debugHigh.tool_mode === "code_mode_only",
    `Configured chatgpt-web/high did not retain code_mode_only: ${JSON.stringify(debugHigh)}`);

  const baselineFeatures = codeModeFeatureSummary(runCodex(codex, ["features", "list"], childEnv));
  // 0.154 exposes the standalone host by default but keeps the JavaScript Code Mode engine behind
  // the code_mode feature. Prior clean-config captures proved that model_info.tool_mode alone can
  // still produce a request with no tools. This control run enables only the engine for this process;
  // it does not mutate CODEX_HOME and therefore isolates the feature gate from the routed catalog.
  const enabledFeatures = codeModeFeatureSummary(runCodex(
    codex,
    ["-c", "features.code_mode=true", "features", "list"],
    childEnv,
  ));
  process.stdout.write(`NATIVE_CODE_MODE_PRECHECK tool_mode=${String(debugHigh.tool_mode)} baseline=${baselineFeatures} enabled=${enabledFeatures}\n`);
  assert(/code_mode\s+under development\s+true/.test(enabledFeatures),
    `Per-process code_mode override did not enable the engine: ${enabledFeatures}`);

  const child = spawn(codex, [
    "-c", "features.code_mode=true",
    "exec",
    "--model", "chatgpt-web/high",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color", "never",
    "Inspect the current workspace and report the working directory.",
  ], {
    cwd: workspace,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childStdout = "";
  let childStderr = "";
  child.stdout?.on("data", chunk => { childStdout += String(chunk); });
  child.stderr?.on("data", chunk => { childStderr += String(chunk); });
  const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `Timed out waiting for native Codex planner request. stdout=${JSON.stringify(childStdout.slice(-2000))} stderr=${JSON.stringify(childStderr.slice(-4000))}`,
    )), 20_000);
    timer.unref?.();
  });
  const body = await Promise.race([captured, timeout]);

  assert(body.model === "chatgpt-web/high", `Expected chatgpt-web/high request, got ${JSON.stringify(body.model)}`);
  assert(Array.isArray(body.tools),
    `Native Codex planner request has no tools array with code_mode enabled; precheck=${JSON.stringify({ tool_mode: debugHigh.tool_mode, baselineFeatures, enabledFeatures })}; tool_choice=${JSON.stringify(body.tool_choice)}; request_keys=${JSON.stringify(Object.keys(body))}; stderr=${JSON.stringify(childStderr.slice(-5000))}`);
  const tools = body.tools as unknown[];
  const names = tools.map(toolName).filter((name): name is string => Boolean(name));
  const exec = tools.find(tool => toolName(tool) === "exec") as Record<string, unknown> | undefined;
  const wait = tools.find(tool => toolName(tool) === "wait") as Record<string, unknown> | undefined;
  assert(exec, `Native CodeModeOnly planner did not advertise exec: ${describeTools(tools)}`);
  assert(wait, `Native CodeModeOnly planner did not advertise wait: ${describeTools(tools)}`);
  assert(toolType(exec) === "custom", `Native exec is not a custom/freeform tool: ${JSON.stringify(exec)}`);
  assert(toolType(wait) === "function", `Native wait is not a function tool: ${JSON.stringify(wait)}`);
  assert(typeof exec.description === "string" && exec.description.includes("Run JavaScript code to orchestrate/compose tool calls"),
    "Native exec description does not contain the Code Mode contract");
  assert(typeof exec.description === "string" && exec.description.includes("tools.exec_command"),
    "Native exec description does not expose exec_command through the nested Codex tool registry");
  for (const forbidden of ["exec_command", "write_stdin", "apply_patch", "shell_command"]) {
    assert(!names.includes(forbidden), `Native CodeModeOnly planner leaked direct top-level ${forbidden}: ${describeTools(tools)}`);
  }
  assert(body.tool_choice === "auto", `Expected native Codex tool_choice=auto, got ${JSON.stringify(body.tool_choice)}`);
  assert(body.parallel_tool_calls === true, `Expected native Codex parallel_tool_calls=true, got ${JSON.stringify(body.parallel_tool_calls)}`);

  const exit = await Promise.race([childExit, timeout]);
  assert(exit.code === 0, `Native Codex planner smoke exited ${exit.code ?? exit.signal}: stdout=${JSON.stringify(childStdout)} stderr=${JSON.stringify(childStderr)}`);
  process.stdout.write(`NATIVE_CODE_MODE_PLANNER_SMOKE_OK tools=${describeTools(tools)}\n`);
} finally {
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    process.stderr.write(`planner cleanup warning: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
