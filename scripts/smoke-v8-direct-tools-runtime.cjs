const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../launcher/electron/runtime.cjs");

function hostFor(existingConfig, interactionMode = existingConfig?.browserInteractionMode ?? "automatic") {
  const host = new RuntimeHost({
    app: {
      getPath: () => path.join(os.tmpdir(), "codex-web-gpt-v8-direct-runtime-smoke"),
      getVersion: () => "5.0.6",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => existingConfig,
      readSetupConfig: () => existingConfig,
      stopForSetup: async () => ({ status: "stopped" }),
      startIfConfigured: async () => ({ status: "ready" }),
    },
    getBrowserInteractionMode: () => interactionMode,
  });
  let invocation;
  host.runSetup = async (name, args, options = {}) => {
    invocation = { name, args, timeoutMs: options.timeoutMs };
    await options.afterRuntimeReady?.();
    return { code: 0, stdout: "", stderr: "" };
  };
  host.bridgeStatus = async () => ({
    installed: true,
    active: true,
    staticCatalogActive: true,
    errors: [],
  });
  return { host, invocation: () => invocation };
}

(async () => {
  const legacyAutomaticFull = {
    mode: "full",
    browserHost: "launcher",
    browserInteractionMode: "automatic",
    appName: "Codex Native2",
    automaticAppName: "Codex Native2",
    releaseVersion: "5.0.6",
    solAvailable: true,
    proAvailable: false,
  };

  const upgrade = hostFor(legacyAutomaticFull);
  const upgradeResult = await upgrade.host.upgradeManagedRuntime();
  assert.equal(upgradeResult.updated, true, "same-version Automatic Full must still migrate");
  assert.equal(upgradeResult.mode, "browser-only");
  assert.deepEqual(upgrade.invocation().args.slice(0, 2), ["setup", "--browser-only"]);
  assert.equal(upgrade.invocation().args.includes("--automatic-browser-interaction"), true);

  const reinstall = hostFor(legacyAutomaticFull);
  const reinstallResult = await reinstall.host.setupCore();
  assert.equal(reinstallResult.mode, "browser-only");
  assert.deepEqual(reinstall.invocation().args.slice(0, 2), ["setup", "--browser-only"]);

  const manualFull = {
    ...legacyAutomaticFull,
    browserInteractionMode: "manual",
    appName: "Codex Zero Risk",
  };
  const manual = hostFor(manualFull, "manual");
  const manualResult = await manual.host.setupCore();
  assert.equal(manualResult.mode, "full");
  assert.deepEqual(manual.invocation().args.slice(0, 2), ["setup", "--full"]);

  const backToAutomatic = hostFor(manualFull, "manual");
  await backToAutomatic.host.setBrowserInteractionMode("automatic");
  assert.equal(backToAutomatic.invocation().args.includes("--browser-only"), true);
  assert.equal(backToAutomatic.invocation().args.includes("--full"), false);

  process.stdout.write("V8_DIRECT_TOOLS_RUNTIME_SMOKE_OK\n");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
