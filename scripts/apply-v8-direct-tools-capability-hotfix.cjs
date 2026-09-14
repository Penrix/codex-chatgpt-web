const fs = require("node:fs");

function read(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function write(file, source) {
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, original.includes("\r\n") ? source.replace(/\n/g, "\r\n") : source);
}

function replaceExactlyOnce(file, before, after, label) {
  const source = read(file);
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${label}: expected source block was not found in ${file}`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected source block is ambiguous in ${file}`);
  }
  write(file, source.slice(0, first) + after + source.slice(first + before.length));
}

function replaceCount(file, before, after, expected, label) {
  const source = read(file);
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`${label}: expected ${expected} matches in ${file}, found ${count}`);
  write(file, source.split(before).join(after));
}

const typesPath = "src/types.ts";
const modelPath = "src/adapters/chatgpt-web/model.ts";
const configPath = "src/config.ts";
const adapterPath = "src/adapters/chatgpt-web/index.ts";
const runtimePath = "launcher/electron/runtime.cjs";

replaceExactlyOnce(
  typesPath,
  `    /** Attach the turn-bound Codex MCP capability for every connector-capable Web model. */\n    localToolsEnabled?: boolean;`,
  `    /** Attach the turn-bound Codex MCP capability for connector-backed Web models. */\n    localToolsEnabled?: boolean;\n    /** Let automatic Sol/High return strict tool envelopes to the native Codex Responses harness. */\n    directToolsEnabled?: boolean;`,
  "provider direct-tools capability",
);

replaceExactlyOnce(
  modelPath,
  `export interface ChatGptWebCapabilities {\n  localToolsEnabled: boolean;\n  solAvailable: boolean;`,
  `export interface ChatGptWebCapabilities {\n  localToolsEnabled: boolean;\n  /** Native Codex execution reached through strict browser envelopes rather than a ChatGPT connector. */\n  directToolsEnabled?: boolean;\n  solAvailable: boolean;`,
  "model direct-tools capability",
);

replaceCount(
  modelPath,
  `localTools: capabilities.localToolsEnabled }`,
  `localTools: capabilities.localToolsEnabled || capabilities.directToolsEnabled === true }`,
  5,
  "Sol direct-tools mode",
);

replaceExactlyOnce(
  configPath,
  `      localToolsEnabled: config.mode === "full",\n      solAvailable: manual ? false : config.solAvailable,`,
  `      localToolsEnabled: config.mode === "full",\n      // Automatic Sol/High does not need a ChatGPT Connector. Browser-only is the intentional\n      // direct-tools runtime; Full mode remains the explicit MCP/Zero Risk contract.\n      directToolsEnabled: !manual && config.mode === "browser-only" && config.solAvailable,\n      solAvailable: manual ? false : config.solAvailable,`,
  "provider direct-tools projection",
);

replaceExactlyOnce(
  adapterPath,
  `  const configuredCapabilities: ChatGptWebCapabilities = {\n    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,\n    solAvailable: provider.chatgptWeb?.solAvailable !== false,`,
  `  const configuredCapabilities: ChatGptWebCapabilities = {\n    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,\n    directToolsEnabled: provider.chatgptWeb?.directToolsEnabled === true,\n    solAvailable: provider.chatgptWeb?.solAvailable !== false,`,
  "adapter direct-tools capability",
);

replaceCount(
  adapterPath,
  `const directTools = !manualRequest && mode.localTools && parsed.modelId === CHATGPT_WEB_MODEL_ID;`,
  `const directTools = !manualRequest\n      && turnCapabilities.directToolsEnabled === true\n      && parsed.modelId === CHATGPT_WEB_MODEL_ID;`,
  1,
  "runtime direct-tools capability selection",
);
replaceCount(
  adapterPath,
  `const directTools = !manualRequest && mode.localTools && parsed.modelId === CHATGPT_WEB_MODEL_ID;`,
  `const directTools = !manualRequest\n          && turnCapabilities.directToolsEnabled === true\n          && parsed.modelId === CHATGPT_WEB_MODEL_ID;`,
  1,
  "request direct-tools capability selection",
);

replaceExactlyOnce(
  runtimePath,
  `    const existing = this.runtimeConfigSnapshot();\n    const mode = existing.mode;\n    const interactionMode = existing.configured\n      ? existing.config?.browserInteractionMode ?? this.browserInteractionMode()\n      : this.browserInteractionMode();`,
  `    const existing = this.runtimeConfigSnapshot();\n    const interactionMode = existing.configured\n      ? existing.config?.browserInteractionMode ?? this.browserInteractionMode()\n      : this.browserInteractionMode();\n    // Automatic Sol/High tools are executed by native Codex through the browser envelope protocol.\n    // Do not preserve a legacy Full/Tunnel dependency merely because an older release configured it.\n    const mode = interactionMode === "automatic" ? "browser-only" : existing.mode;`,
  "automatic core setup downgrade",
);

replaceExactlyOnce(
  runtimePath,
  `    const existing = this.runtimeConfigSnapshot();\n    const mode = existing.mode;\n    const interactionMode = existing.configured\n      ? existing.config?.browserInteractionMode ?? this.browserInteractionMode()\n      : "automatic";`,
  `    const existing = this.runtimeConfigSnapshot();\n    const interactionMode = existing.configured\n      ? existing.config?.browserInteractionMode ?? this.browserInteractionMode()\n      : "automatic";\n    const mode = interactionMode === "automatic" ? "browser-only" : existing.mode;`,
  "automatic DEV core setup downgrade",
);

replaceExactlyOnce(
  runtimePath,
  `    const current = this.runtimeConfigSnapshot();\n    if (!current.configured) {\n      throw new Error("Initialize the runtime before changing Bigger Context");\n    }\n    const mode = current.mode;`,
  `    const current = this.runtimeConfigSnapshot();\n    if (!current.configured) {\n      throw new Error("Initialize the runtime before changing Bigger Context");\n    }\n    const mode = current.config?.browserInteractionMode === "manual" ? current.mode : "browser-only";`,
  "Bigger Context automatic direct runtime",
);

replaceExactlyOnce(
  runtimePath,
  `    const connectorMigrationRequired = existing.mode === "full"\n      && isLegacyConnectorName(validateConnectorName(existing.config?.appName));\n    const interactionMode = existing.config?.browserInteractionMode ?? "automatic";`,
  `    const connectorMigrationRequired = existing.mode === "full"\n      && isLegacyConnectorName(validateConnectorName(existing.config?.appName));\n    const interactionMode = existing.config?.browserInteractionMode ?? "automatic";\n    const automaticDirectMigrationRequired = interactionMode === "automatic" && existing.mode === "full";\n    const targetMode = automaticDirectMigrationRequired ? "browser-only" : existing.mode;`,
  "managed runtime automatic direct migration",
);

replaceExactlyOnce(
  runtimePath,
  `    if (existing.owner !== "launcher"\n      || (existing.config?.releaseVersion === currentVersion\n        && !connectorMigrationRequired\n        && !tunnelProfileMigrationRequired)) {`,
  `    if (existing.owner !== "launcher"\n      || (existing.config?.releaseVersion === currentVersion\n        && !connectorMigrationRequired\n        && !tunnelProfileMigrationRequired\n        && !automaticDirectMigrationRequired)) {`,
  "managed runtime migration trigger",
);

replaceExactlyOnce(
  runtimePath,
  `      existing.mode === "full" ? "--full" : "--browser-only",`,
  `      targetMode === "full" ? "--full" : "--browser-only",`,
  "managed runtime target mode",
);

replaceExactlyOnce(
  runtimePath,
  `      message: tunnelProfileMigrationRequired\n        ? \`Separating \${interactionMode === "manual" ? "Zero Risk" : "Automatic"} MCP credentials\`\n        : \`Upgrading launcher runtime from \${existing.config.releaseVersion} to \${currentVersion}\`,\n      successMessage: tunnelProfileMigrationRequired\n        ? \`\${interactionMode === "manual" ? "Zero Risk" : "Automatic"} MCP profile migrated\`\n        : \`Launcher runtime upgraded to \${currentVersion}\`,\n      timeoutMs: existing.mode === "full" ? MCP_SETUP_TIMEOUT_MS : CORE_SETUP_TIMEOUT_MS,`,
  `      message: automaticDirectMigrationRequired\n        ? "Migrating Automatic mode from MCP to native Codex direct tools"\n        : tunnelProfileMigrationRequired\n          ? \`Separating \${interactionMode === "manual" ? "Zero Risk" : "Automatic"} MCP credentials\`\n          : \`Upgrading launcher runtime from \${existing.config.releaseVersion} to \${currentVersion}\`,\n      successMessage: automaticDirectMigrationRequired\n        ? "Automatic mode now uses native Codex direct tools without a Tunnel"\n        : tunnelProfileMigrationRequired\n          ? \`\${interactionMode === "manual" ? "Zero Risk" : "Automatic"} MCP profile migrated\`\n          : \`Launcher runtime upgraded to \${currentVersion}\`,\n      timeoutMs: targetMode === "full" ? MCP_SETUP_TIMEOUT_MS : CORE_SETUP_TIMEOUT_MS,`,
  "managed runtime migration messaging",
);

replaceExactlyOnce(
  runtimePath,
  `      mode: existing.mode,\n      fromVersion: existing.config.releaseVersion,`,
  `      mode: targetMode,\n      fromVersion: existing.config.releaseVersion,`,
  "managed runtime migration result",
);

replaceExactlyOnce(
  runtimePath,
  `      current.mode === "full" ? "--full" : "--browser-only",\n      "--browser-host-descriptor",\n      this.browserDescriptorPath,\n      ...this.browserInteractionArgs({ mode, refreshCapabilities: true }),`,
  `      mode === "automatic" ? "--browser-only" : "--full",\n      "--browser-host-descriptor",\n      this.browserDescriptorPath,\n      ...this.browserInteractionArgs({ mode, refreshCapabilities: true }),`,
  "interaction-mode direct runtime selection",
);

replaceExactlyOnce(
  runtimePath,
  `      timeoutMs: current.mode === "full" ? MCP_SETUP_TIMEOUT_MS : CORE_SETUP_TIMEOUT_MS,\n      afterRuntimeReady,`,
  `      timeoutMs: mode === "manual" ? MCP_SETUP_TIMEOUT_MS : CORE_SETUP_TIMEOUT_MS,\n      afterRuntimeReady,`,
  "interaction-mode direct runtime timeout",
);

const types = read(typesPath);
const model = read(modelPath);
const config = read(configPath);
const adapter = read(adapterPath);
const runtime = read(runtimePath);
if (!types.includes("directToolsEnabled?: boolean")) throw new Error("directToolsEnabled provider type is missing");
if (!model.includes("capabilities.directToolsEnabled === true")) throw new Error("Sol direct-tools capability is not wired into model mode");
if (!config.includes('directToolsEnabled: !manual && config.mode === "browser-only" && config.solAvailable')) {
  throw new Error("browser-only automatic Sol is not projected as direct-tools capable");
}
if (!adapter.includes("turnCapabilities.directToolsEnabled === true")) {
  throw new Error("adapter direct-tools selection is not capability-gated");
}
if (!runtime.includes("automaticDirectMigrationRequired")) {
  throw new Error("automatic Full installations are not migrated away from Tunnel mode");
}
if (!runtime.includes('mode === "automatic" ? "--browser-only" : "--full"')) {
  throw new Error("switching to Automatic mode does not leave Full/Tunnel mode");
}

process.stdout.write("V8_DIRECT_TOOLS_CAPABILITY_HOTFIX_APPLIED\n");
