const fs = require("node:fs");

const path = "src/config.ts";
const source = fs.readFileSync(path, "utf8");
const before = `      localToolsEnabled: config.mode === "full",\n      // Automatic Sol/High does not need a ChatGPT Connector. Browser-only is the intentional\n      // direct-tools runtime; Full mode remains the explicit MCP/Zero Risk contract.\n      directToolsEnabled: !manual && config.mode === "browser-only" && config.solAvailable,`;
const after = `      // Automatic Sol/High must never fall back to a ChatGPT Connector merely because an\n      // older installation still has mode=full. Full MCP is reserved for Manual / Zero Risk.\n      localToolsEnabled: manual && config.mode === "full",\n      directToolsEnabled: !manual && config.solAvailable,`;

const normalized = source.replace(/\r\n/g, "\n");
const first = normalized.indexOf(before);
if (first < 0) throw new Error("automatic direct guard: expected provider capability block was not found");
if (normalized.indexOf(before, first + before.length) >= 0) {
  throw new Error("automatic direct guard: provider capability block is ambiguous");
}
const patched = normalized.slice(0, first) + after + normalized.slice(first + before.length);
fs.writeFileSync(path, source.includes("\r\n") ? patched.replace(/\n/g, "\r\n") : patched);

const verified = fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
if (!verified.includes('localToolsEnabled: manual && config.mode === "full"')) {
  throw new Error("automatic direct guard: stale Full mode can still expose connector-backed local tools");
}
if (!verified.includes("directToolsEnabled: !manual && config.solAvailable")) {
  throw new Error("automatic direct guard: Automatic Sol is not projected as direct-tools capable");
}

process.stdout.write("V8_AUTOMATIC_DIRECT_GUARD_HOTFIX_APPLIED\n");
