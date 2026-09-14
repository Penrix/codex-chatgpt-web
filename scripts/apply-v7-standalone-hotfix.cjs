const fs = require("node:fs");

function replaceExactlyOnce(file, before, after, label) {
  const source = fs.readFileSync(file, "utf8");
  const usesCrlf = source.includes("\r\n");
  const normalized = source.replace(/\r\n/g, "\n");
  const first = normalized.indexOf(before);
  if (first < 0) throw new Error(`${label}: expected source block was not found in ${file}`);
  if (normalized.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected source block is ambiguous in ${file}`);
  }
  const patched = normalized.slice(0, first) + after + normalized.slice(first + before.length);
  fs.writeFileSync(file, usesCrlf ? patched.replace(/\n/g, "\r\n") : patched);
}

replaceExactlyOnce(
  "src/cli.ts",
  `          ...(status.routeUrl ? { routeUrl: status.routeUrl } : {}),\n          errors: status.errors,`,
  `          ...(status.routeUrl ? { routeUrl: status.routeUrl } : {}),\n          staticCatalogActive: status.staticCatalogActive,\n          errors: status.errors,`,
  "route status static catalog field",
);

replaceExactlyOnce(
  "launcher/electron/main.cjs",
  `  }).catch(async (error) => {\n    const primary = error instanceof Error ? error.message : String(error);\n    const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });`,
  `  }).catch(async (error) => {\n    const primary = error instanceof Error ? error.message : String(error);\n    if (primary.startsWith("Codex bridge route is inconsistent:")) {\n      logger.warn("codex.route_repair_required", { message: primary });\n      const state = stateStore.update({\n        coreSetupComplete: false,\n        codexCatalogVerified: false,\n        codexRestartRequired: false,\n      });\n      send("launcher:state-changed", state);\n      stopCatalogVerificationMonitor();\n      return;\n    }\n    const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });`,
  "stale route startup recovery",
);

replaceExactlyOnce(
  "src/tunnel.ts",
  `import { createHash, randomUUID } from "node:crypto";`,
  `import { spawn } from "node:child_process";\nimport { createHash, randomUUID } from "node:crypto";`,
  "Windows managed tunnel async process import",
);

replaceExactlyOnce(
  "src/tunnel.ts",
  `export function connectTunnel(config: AppConfig): void {\n  const settings = tunnel(config);\n  mkdirSync(settings.profileDir, { recursive: true, mode: 0o700 });\n  const result = runCommand(settings.binaryPath, [\n    "runtimes", "connect",\n    "--alias", settings.alias,\n    "--profile", settings.profileName,\n    "--profile-dir", settings.profileDir,\n    "--tunnel-client-bin", settings.binaryPath,\n    "--tunnel-id", settings.tunnelId,\n    "--runtime-api-key", \`file:\${settings.runtimeKeyFile}\`,\n    "--mcp-command", mcpCommand(config),\n    "--json",\n  ], { timeout: TUNNEL_READY_TIMEOUT_MS });\n  const structuredOutput = result.stdout.trim();\n  const launchError = structuredOutput\n    ? tunnelConnectLaunchError(structuredOutput)\n    : undefined;\n  if (result.status !== 0) {\n    const detail = launchError && launchError !== "tunnel-client returned non-JSON connect output"\n      ? launchError\n      : safeTunnelDetail(tunnelCommandOutput(result) || \`exit \${result.status}\`);\n    throw new Error(\`Tunnel managed startup failed: \${detail}\`);\n  }\n  if (launchError) throw new Error(\`Tunnel runtime exited during launch: \${launchError}\`);\n}`,
  `function managedTunnelConnectArgs(config: AppConfig): string[] {\n  const settings = tunnel(config);\n  return [\n    "runtimes", "connect",\n    "--alias", settings.alias,\n    "--profile", settings.profileName,\n    "--profile-dir", settings.profileDir,\n    "--tunnel-client-bin", settings.binaryPath,\n    "--tunnel-id", settings.tunnelId,\n    "--runtime-api-key", "file:" + settings.runtimeKeyFile,\n    "--mcp-command", mcpCommand(config),\n    "--json",\n  ];\n}\n\nexport function parseTunnelLocalInventoryStatus(\n  output: string,\n  alias: string,\n  exitStatus = 0,\n): TunnelRuntimeStatus {\n  if (exitStatus !== 0) {\n    return { ok: false, processRunning: false, healthy: false, ready: false, detail: safeTunnelDetail(output) };\n  }\n  try {\n    const parsed = JSON.parse(output) as { entries?: unknown };\n    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];\n    const entry = entries.find(candidate => {\n      return candidate && typeof candidate === "object"\n        && (candidate as { alias?: unknown }).alias === alias;\n    }) as Record<string, unknown> | undefined;\n    if (!entry) {\n      return { ok: false, processRunning: false, healthy: false, ready: false, state: "stopped", detail: "local_inventory=absent" };\n    }\n    const state = typeof entry.runtime_state === "string" ? entry.runtime_state : undefined;\n    const processRunning = state === "starting" || state === "healthy" || state === "ready";\n    const healthy = state === "healthy" || state === "ready";\n    const ready = state === "ready";\n    return {\n      ok: processRunning && healthy && ready,\n      processRunning,\n      healthy,\n      ready,\n      ...(state ? { state } : {}),\n      detail: [\n        "local_inventory=true",\n        "process_running=" + String(processRunning),\n        "healthy=" + String(healthy),\n        "ready=" + String(ready),\n        ...(state ? ["state=" + state] : []),\n      ].join(" "),\n    };\n  } catch {\n    return {\n      ok: false,\n      processRunning: false,\n      healthy: false,\n      ready: false,\n      detail: "tunnel-client returned non-JSON local inventory: " + safeTunnelDetail(output),\n    };\n  }\n}\n\nfunction tunnelLocalInventoryStatus(config: AppConfig): TunnelRuntimeStatus {\n  const settings = tunnel(config);\n  const result = runCommand(\n    settings.binaryPath,\n    ["runtimes", "cleanup", "--json"],\n    { timeout: 5_000 },\n  );\n  return parseTunnelLocalInventoryStatus(tunnelCommandOutput(result), settings.alias, result.status);\n}\n\nasync function connectTunnelOnWindows(config: AppConfig, args: string[]): Promise<void> {\n  const settings = tunnel(config);\n  await new Promise<void>((resolve, reject) => {\n    const child = spawn(settings.binaryPath, args, {\n      cwd: settings.profileDir,\n      stdio: "ignore",\n      windowsHide: true,\n    });\n    let settled = false;\n    let probeInFlight = false;\n    let observedRunning = false;\n    let lastStatus: TunnelRuntimeStatus = {\n      ok: false,\n      processRunning: false,\n      healthy: false,\n      ready: false,\n      detail: "local tunnel runtime has not been observed",\n    };\n    let poll: ReturnType<typeof setInterval> | undefined;\n    let timeout: ReturnType<typeof setTimeout> | undefined;\n    const clearTimers = () => {\n      if (poll) clearInterval(poll);\n      if (timeout) clearTimeout(timeout);\n    };\n    const stopControlProcess = () => {\n      if (child.exitCode === null && child.signalCode === null) {\n        try { child.kill("SIGTERM"); } catch {}\n      }\n      child.unref();\n    };\n    const finish = (fn: () => void) => {\n      if (settled) return;\n      settled = true;\n      clearTimers();\n      fn();\n    };\n    const inspect = () => {\n      if (settled || probeInFlight) return;\n      probeInFlight = true;\n      try {\n        lastStatus = tunnelLocalInventoryStatus(config);\n        if (lastStatus.processRunning) observedRunning = true;\n        if (lastStatus.processRunning && lastStatus.healthy) {\n          finish(() => {\n            stopControlProcess();\n            resolve();\n          });\n          return;\n        }\n        if (observedRunning && lastStatus.state === "stopped") {\n          finish(() => {\n            stopControlProcess();\n            reject(new Error("Tunnel managed runtime stopped during startup: " + lastStatus.detail));\n          });\n        }\n      } catch (error) {\n        lastStatus = {\n          ok: false,\n          processRunning: false,\n          healthy: false,\n          ready: false,\n          detail: error instanceof Error ? error.message : String(error),\n        };\n      } finally {\n        probeInFlight = false;\n      }\n    };\n    child.once("error", (error) => finish(() => reject(error)));\n    child.once("exit", (code) => {\n      if (settled) return;\n      if ((code ?? 1) === 0) {\n        finish(resolve);\n        return;\n      }\n      try { lastStatus = tunnelLocalInventoryStatus(config); } catch {}\n      finish(() => reject(new Error(\n        "Tunnel managed startup failed: control process exited " + String(code ?? 1) + "; " + lastStatus.detail,\n      )));\n    });\n    poll = setInterval(inspect, 250);\n    timeout = setTimeout(() => {\n      finish(() => {\n        stopControlProcess();\n        reject(new Error(\n          "Tunnel managed startup did not produce a healthy local runtime within "\n          + String(TUNNEL_READY_TIMEOUT_MS) + "ms: " + lastStatus.detail,\n        ));\n      });\n    }, TUNNEL_READY_TIMEOUT_MS);\n    inspect();\n  });\n}\n\nexport async function connectTunnel(config: AppConfig): Promise<void> {\n  const settings = tunnel(config);\n  mkdirSync(settings.profileDir, { recursive: true, mode: 0o700 });\n  const args = managedTunnelConnectArgs(config);\n  if (process.platform === "win32") {\n    await connectTunnelOnWindows(config, args);\n    return;\n  }\n  const result = runCommand(settings.binaryPath, args, { timeout: TUNNEL_READY_TIMEOUT_MS });\n  const structuredOutput = result.stdout.trim();\n  const launchError = structuredOutput\n    ? tunnelConnectLaunchError(structuredOutput)\n    : undefined;\n  if (result.status !== 0) {\n    const detail = launchError && launchError !== "tunnel-client returned non-JSON connect output"\n      ? launchError\n      : safeTunnelDetail(tunnelCommandOutput(result) || "exit " + String(result.status));\n    throw new Error("Tunnel managed startup failed: " + detail);\n  }\n  if (launchError) throw new Error("Tunnel runtime exited during launch: " + launchError);\n}`,
  "Windows managed tunnel connect lifecycle",
);

replaceExactlyOnce(
  "src/tunnel.ts",
  `  let status = tunnelStatus(config);\n  while (!status.ok && Date.now() < deadline) {\n    await new Promise(resolveWait => setTimeout(resolveWait, TUNNEL_STATUS_POLL_INTERVAL_MS));\n    status = tunnelStatus(config);\n  }`,
  `  const observe = () => process.platform === "win32"\n    ? tunnelLocalInventoryStatus(config)\n    : tunnelStatus(config);\n  let status = observe();\n  while (!status.ok && Date.now() < deadline) {\n    await new Promise(resolveWait => setTimeout(resolveWait, TUNNEL_STATUS_POLL_INTERVAL_MS));\n    status = observe();\n  }`,
  "Windows local-only tunnel readiness polling",
);

replaceExactlyOnce(
  "src/setup.ts",
  `    connectTunnel(config);`,
  `    await connectTunnel(config);`,
  "await managed tunnel bootstrap",
);

replaceExactlyOnce(
  "launcher/electron/runtime-supervisor.cjs",
  `  async runTunnelConnectCommand(config) {\n    const contract = config.browserInteractionMode === "manual" ? "safe" : "native";\n    const invocation = this.runtimeCommand([\n      "mcp",\n      "--contract",\n      contract,\n      "--broker-socket",\n      config.brokerSocketPath,\n    ]);\n    return await this.runTunnelCommand(\n      config,\n      managedTunnelConnectArgs(config, invocation),\n      TUNNEL_START_TIMEOUT_MS,\n      "Tunnel managed startup",\n    );\n  }`,
  `  async runTunnelConnectCommand(config) {\n    const contract = config.browserInteractionMode === "manual" ? "safe" : "native";\n    const invocation = this.runtimeCommand([\n      "mcp",\n      "--contract",\n      contract,\n      "--broker-socket",\n      config.brokerSocketPath,\n    ]);\n    const args = managedTunnelConnectArgs(config, invocation);\n    if (process.platform !== "win32") {\n      return await this.runTunnelCommand(\n        config,\n        args,\n        TUNNEL_START_TIMEOUT_MS,\n        "Tunnel managed startup",\n      );\n    }\n    return await this.runWindowsManagedTunnelConnectCommand(config, args, TUNNEL_START_TIMEOUT_MS);\n  }\n\n  async runWindowsManagedTunnelConnectCommand(config, args, timeoutMs) {\n    const tunnel = config.tunnel;\n    if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");\n    return await new Promise((resolve, reject) => {\n      const child = spawn(tunnel.binaryPath, args, {\n        cwd: tunnel.profileDir,\n        detached: false,\n        stdio: "ignore",\n        windowsHide: true,\n      });\n      let settled = false;\n      let probeInFlight = false;\n      let observedRunning = false;\n      let lastDetail = "local tunnel runtime has not been observed";\n      let poll = null;\n      let timeout = null;\n      const clearTimers = () => {\n        if (poll) clearInterval(poll);\n        if (timeout) clearTimeout(timeout);\n      };\n      const stopControlProcess = () => {\n        if (child.exitCode === null && child.signalCode === null) {\n          try { child.kill("SIGTERM"); } catch {}\n        }\n        child.unref();\n      };\n      const finish = (fn) => {\n        if (settled) return;\n        settled = true;\n        clearTimers();\n        fn();\n      };\n      const inspect = () => {\n        if (settled || probeInFlight) return;\n        probeInFlight = true;\n        void this.readTunnelHealth(config).then((health) => {\n          if (settled) return;\n          lastDetail = health.detail;\n          if (health.processRunning === true) observedRunning = true;\n          if (health.processRunning === true && health.healthy === true) {\n            finish(() => {\n              stopControlProcess();\n              resolve({ code: 0, stdout: "", stderr: "", output: "" });\n            });\n            return;\n          }\n          if (observedRunning && tunnelRuntimeStopped(health)) {\n            finish(() => {\n              stopControlProcess();\n              reject(new Error("Tunnel managed runtime stopped during connect: " + health.detail));\n            });\n          }\n        }).catch((error) => {\n          lastDetail = "local tunnel inventory probe failed: " + errorMessage(error);\n        }).finally(() => {\n          probeInFlight = false;\n        });\n      };\n      child.once("error", (error) => finish(() => reject(error)));\n      child.once("exit", (code) => {\n        if (settled) return;\n        const exitCode = code ?? 1;\n        finish(() => resolve({\n          code: exitCode,\n          stdout: "",\n          stderr: exitCode === 0 ? "" : lastDetail,\n          output: exitCode === 0 ? "" : lastDetail,\n        }));\n      });\n      poll = setInterval(inspect, TUNNEL_HEALTH_POLL_INTERVAL_MS);\n      timeout = setTimeout(() => {\n        finish(() => {\n          stopControlProcess();\n          reject(new Error(\n            "Tunnel managed startup did not produce a healthy local runtime within "\n            + String(timeoutMs) + "ms: " + lastDetail,\n          ));\n        });\n      }, timeoutMs);\n      inspect();\n    });\n  }`,
  "Windows launcher managed tunnel connect lifecycle",
);

replaceExactlyOnce(
  "tests/tunnel.test.ts",
  `import { TUNNEL_VERSION, parseTunnelStatus, tunnelClientInstallAction, tunnelCommandOutput, tunnelConnectLaunchError } from "../src/tunnel";`,
  `import { TUNNEL_VERSION, parseTunnelLocalInventoryStatus, parseTunnelStatus, tunnelClientInstallAction, tunnelCommandOutput, tunnelConnectLaunchError } from "../src/tunnel";`,
  "local tunnel inventory test import",
);

fs.appendFileSync(
  "tests/tunnel.test.ts",
  `\n\ntest("local runtime inventory is the Windows managed-connect success boundary", () => {\n  expect(parseTunnelLocalInventoryStatus(JSON.stringify({\n    entries: [{ alias: "codex-chatgpt-web", runtime_state: "healthy" }],\n  }), "codex-chatgpt-web")).toMatchObject({\n    processRunning: true,\n    healthy: true,\n    ready: false,\n    state: "healthy",\n  });\n  expect(parseTunnelLocalInventoryStatus(JSON.stringify({\n    entries: [{ alias: "codex-chatgpt-web", runtime_state: "ready" }],\n  }), "codex-chatgpt-web")).toMatchObject({\n    ok: true,\n    processRunning: true,\n    healthy: true,\n    ready: true,\n    state: "ready",\n  });\n  expect(parseTunnelLocalInventoryStatus(JSON.stringify({ entries: [] }), "codex-chatgpt-web")).toMatchObject({\n    processRunning: false,\n    healthy: false,\n    ready: false,\n    state: "stopped",\n  });\n});\n`,
);

const cli = fs.readFileSync("src/cli.ts", "utf8");
if (!cli.includes("staticCatalogActive: status.staticCatalogActive")) {
  throw new Error("V7 route status hotfix did not persist");
}
const main = fs.readFileSync("launcher/electron/main.cjs", "utf8");
if (!main.includes('logger.warn("codex.route_repair_required"')) {
  throw new Error("V7 stale-route startup hotfix did not persist");
}
const tunnel = fs.readFileSync("src/tunnel.ts", "utf8");
if (!tunnel.includes("parseTunnelLocalInventoryStatus") || !tunnel.includes("connectTunnelOnWindows")) {
  throw new Error("V7 Windows managed-connect lifecycle hotfix did not persist");
}
const supervisor = fs.readFileSync("launcher/electron/runtime-supervisor.cjs", "utf8");
if (!supervisor.includes("runWindowsManagedTunnelConnectCommand")) {
  throw new Error("V7 Windows launcher managed-connect lifecycle hotfix did not persist");
}
const setup = fs.readFileSync("src/setup.ts", "utf8");
if (!setup.includes("await connectTunnel(config);")) {
  throw new Error("V7 async tunnel bootstrap hotfix did not persist");
}

process.stdout.write("V7_STANDALONE_HOTFIX_APPLIED\n");