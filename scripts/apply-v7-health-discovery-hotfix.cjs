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

const supervisorPath = "launcher/electron/runtime-supervisor.cjs";

replaceExactlyOnce(
  supervisorPath,
  `      const liveRuntime = entry.live_runtime && typeof entry.live_runtime === "object"\n        ? entry.live_runtime\n        : {};\n      const healthBaseUrl = loopbackHealthBaseURL(liveRuntime.base_url);\n      if (healthBaseUrl) this.tunnelHealthBaseUrl = healthBaseUrl;`,
  `      const liveRuntime = entry.live_runtime && typeof entry.live_runtime === "object"\n        ? entry.live_runtime\n        : {};\n      const healthBaseUrl = loopbackHealthBaseURL(liveRuntime.base_url);\n      if (healthBaseUrl) {\n        this.tunnelHealthBaseUrl = healthBaseUrl;\n      } else if (typeof parsed.state_root === "string" && parsed.state_root) {\n        const healthUrlFile = path.join(parsed.state_root, "health", \`${tunnel.alias}.url\`);\n        try {\n          const fileBaseUrl = loopbackHealthBaseURL(fs.readFileSync(healthUrlFile, "utf8").trim());\n          if (fileBaseUrl) this.tunnelHealthBaseUrl = fileBaseUrl;\n        } catch {\n          // The runtime can be healthy before the health URL file becomes visible.\n          // Discovery retries through the same local-only inventory below.\n        }\n      }`,
  "local health URL file fallback",
);

replaceExactlyOnce(
  supervisorPath,
  `  async discoverTunnelHealthBaseUrl(config) {\n    const tunnel = config.tunnel;\n    if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");\n    const result = await this.runTunnelCommand(\n      config,\n      ["runtimes", "status", tunnel.alias, "--json"],\n      5_000,\n      "Local tunnel health discovery",\n    );\n    if (result.code !== 0) {\n      throw new Error(\`Local tunnel health discovery failed: \${tunnelControlDiagnostic(result)}\`);\n    }\n    let parsed;\n    try {\n      parsed = JSON.parse(result.output);\n    } catch (error) {\n      throw new Error(\`Local tunnel health discovery returned invalid JSON: \${errorMessage(error)}\`);\n    }\n    const candidates = [\n      parsed?.local?.effective_health?.base_url,\n      parsed?.local?.health?.base_url,\n      parsed?.health_url,\n      parsed?.ui_url,\n    ];\n    const baseUrl = candidates.map(loopbackHealthBaseURL).find(Boolean);\n    if (!baseUrl) {\n      throw new Error("Local tunnel health discovery returned no verified loopback endpoint");\n    }\n    this.tunnelHealthBaseUrl = baseUrl;\n    return baseUrl;\n  }`,
  `  async discoverTunnelHealthBaseUrl(config, timeoutMs = 10_000) {\n    const tunnel = config.tunnel;\n    if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");\n    const deadline = Date.now() + timeoutMs;\n    let lastDetail = "local tunnel inventory has not exposed a health endpoint";\n    do {\n      const health = await this.readTunnelHealth(config);\n      lastDetail = health.detail;\n      if (this.tunnelHealthBaseUrl) return this.tunnelHealthBaseUrl;\n      if (tunnelRuntimeStopped(health)) {\n        throw new Error(\`Local tunnel health discovery stopped: \${health.detail}\`);\n      }\n      if (Date.now() >= deadline) break;\n      await sleep(TUNNEL_HEALTH_POLL_INTERVAL_MS);\n    } while (Date.now() < deadline);\n    throw new Error(\n      \`Local tunnel health discovery did not expose a verified loopback endpoint within \${timeoutMs}ms: \${lastDetail}\`,\n    );\n  }`,
  "local-only tunnel health discovery",
);

const patched = fs.readFileSync(supervisorPath, "utf8");
if (!patched.includes('path.join(parsed.state_root, "health", `${tunnel.alias}.url`)')) {
  throw new Error("V7 local health-file fallback did not persist");
}
const discoveryStart = patched.indexOf("  async discoverTunnelHealthBaseUrl(config, timeoutMs = 10_000)");
const discoveryEnd = patched.indexOf("\n  async waitForTunnelMcpTransport", discoveryStart);
if (discoveryStart < 0 || discoveryEnd < 0) {
  throw new Error("V7 local-only health discovery block is missing");
}
const discovery = patched.slice(discoveryStart, discoveryEnd);
if (discovery.includes('"runtimes", "status"')) {
  throw new Error("V7 local-only health discovery still depends on runtimes status");
}
if (!discovery.includes("await this.readTunnelHealth(config)")) {
  throw new Error("V7 local-only health discovery does not use local inventory");
}

process.stdout.write("V7_LOCAL_HEALTH_DISCOVERY_HOTFIX_APPLIED\n");
