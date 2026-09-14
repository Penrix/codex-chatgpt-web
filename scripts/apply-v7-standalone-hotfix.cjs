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

const cli = fs.readFileSync("src/cli.ts", "utf8");
if (!cli.includes("staticCatalogActive: status.staticCatalogActive")) {
  throw new Error("V7 route status hotfix did not persist");
}
const main = fs.readFileSync("launcher/electron/main.cjs", "utf8");
if (!main.includes('logger.warn("codex.route_repair_required"')) {
  throw new Error("V7 stale-route startup hotfix did not persist");
}

process.stdout.write("V7_STANDALONE_HOTFIX_APPLIED\n");
