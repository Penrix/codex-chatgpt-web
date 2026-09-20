const fs = require("node:fs");
const path = require("node:path");

const STATE_FILE = ".penrix-codex-desktop-provider.json";
const PROVIDER_HEADER = "[model_providers.codex_web_gpt]";
const MANAGED_PROVIDER_LINES = [
  PROVIDER_HEADER,
  'name = "Codex Web GPT local bridge"',
  'base_url = "http://localhost:17841/v1"',
  'wire_api = "responses"',
  "requires_openai_auth = true",
  "supports_websockets = false",
];

function splitText(text) {
  const lineEnding = text.includes("\r\n") ? "\r\n" : text.includes("\r") ? "\r" : "\n";
  const trailingNewline = text.endsWith("\n") || text.endsWith("\r");
  return { lines: text.split(/\r\n|\n|\r/), lineEnding, trailingNewline };
}

function renderText(lines, lineEnding, trailingNewline) {
  let text = lines.join(lineEnding);
  if (trailingNewline && !text.endsWith(lineEnding)) text += lineEnding;
  return text;
}

function firstTableIndex(lines) {
  const index = lines.findIndex(line => /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line));
  return index < 0 ? lines.length : index;
}

function findTopLevelAssignment(lines, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp("^\\s*" + escaped + "\\s*=\\s*(.+?)\\s*$");
  const matches = [];
  for (let index = 0; index < firstTableIndex(lines); index += 1) {
    const line = lines[index];
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (match) matches.push({ index, rawLine: line, rawValue: match[1] });
  }
  if (matches.length > 1) throw new Error("Duplicate top-level " + key + " assignments");
  return matches[0];
}

function decodeQuotedString(raw, key) {
  const value = raw.replace(/\s+#.*$/, "").trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded === "string") return decoded;
    } catch {}
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  throw new Error(key + " must be a quoted TOML string");
}

function findProviderBlock(lines) {
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== PROVIDER_HEADER) continue;
    if (start >= 0) throw new Error("Duplicate " + PROVIDER_HEADER + " tables");
    start = index;
  }
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(lines[index])) { end = index; break; }
  }
  return { start, end, lines: lines.slice(start, end) };
}

function removeRange(lines, start, end) { lines.splice(start, end - start); }

function setTopLevelAssignment(lines, key, line) {
  const current = findTopLevelAssignment(lines, key);
  if (current) { lines[current.index] = line; return current; }
  lines.splice(firstTableIndex(lines), 0, line);
  return undefined;
}

function statePathFor(configPath) { return path.join(path.dirname(configPath), STATE_FILE); }

function readState(configPath) {
  const statePath = statePathFor(configPath);
  if (!fs.existsSync(statePath)) return undefined;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (!state || state.version !== 1 || state.configPath !== configPath) {
    throw new Error("Invalid Penrix Desktop provider state: " + statePath);
  }
  return state;
}

function writeState(configPath, state) {
  fs.writeFileSync(statePathFor(configPath), JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

function managedProviderMatches(lines) {
  const provider = findProviderBlock(lines);
  if (!provider) return false;
  const normalized = provider.lines.filter((line, index) => index === 0 || line.trim() !== "");
  return normalized.length === MANAGED_PROVIDER_LINES.length
    && normalized.every((line, index) => line.trim() === MANAGED_PROVIDER_LINES[index]);
}

function assertManagedProvider(lines) {
  const modelProvider = findTopLevelAssignment(lines, "model_provider");
  if (!modelProvider || decodeQuotedString(modelProvider.rawValue, "model_provider") !== "codex_web_gpt") {
    throw new Error("Codex Desktop provider changed after setup; refusing to overwrite it");
  }
  if (!managedProviderMatches(lines)) {
    throw new Error("Codex Desktop provider table changed after setup; refusing to overwrite it");
  }
}

function applyWindowsDesktopProvider(configPath, platform = process.platform) {
  if (platform !== "win32") return { changed: false, reason: "non-windows" };
  if (!fs.existsSync(configPath)) throw new Error("Codex config not found: " + configPath);
  const original = fs.readFileSync(configPath, "utf8");
  const parsed = splitText(original);
  const lines = parsed.lines;
  const route = findTopLevelAssignment(lines, "openai_base_url");
  if (!route) throw new Error("Codex openai_base_url is missing after setup");
  const routeValue = decodeQuotedString(route.rawValue, "openai_base_url");
  if (routeValue !== "http://127.0.0.1:17841/v1") throw new Error("Unexpected Codex bridge route: " + routeValue);
  const existingState = readState(configPath);
  if (existingState) { assertManagedProvider(lines); return { changed: false, statePath: statePathFor(configPath) }; }
  const previousModelProvider = findTopLevelAssignment(lines, "model_provider");
  const previousProviderBlock = findProviderBlock(lines);
  const state = {
    version: 1,
    configPath,
    previousModelProvider: previousModelProvider
      ? { present: true, rawLine: previousModelProvider.rawLine, index: previousModelProvider.index }
      : { present: false },
    previousProviderBlock: previousProviderBlock
      ? { present: true, lines: previousProviderBlock.lines, index: previousProviderBlock.start }
      : { present: false },
  };
  if (previousProviderBlock) removeRange(lines, previousProviderBlock.start, previousProviderBlock.end);
  setTopLevelAssignment(lines, "model_provider", 'model_provider = "codex_web_gpt"');
  if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
  lines.push(...MANAGED_PROVIDER_LINES);
  writeState(configPath, state);
  try {
    fs.writeFileSync(configPath, renderText(lines, parsed.lineEnding, parsed.trailingNewline), "utf8");
  } catch (error) {
    fs.rmSync(statePathFor(configPath), { force: true });
    throw error;
  }
  return { changed: true, statePath: statePathFor(configPath) };
}

function restoreWindowsDesktopProvider(configPath, platform = process.platform) {
  if (platform !== "win32") return { changed: false, reason: "non-windows" };
  const state = readState(configPath);
  if (!state) return { changed: false, reason: "not-managed" };
  if (!fs.existsSync(configPath)) throw new Error("Codex config not found: " + configPath);
  const current = fs.readFileSync(configPath, "utf8");
  const parsed = splitText(current);
  const lines = parsed.lines;
  assertManagedProvider(lines);
  const modelProvider = findTopLevelAssignment(lines, "model_provider");
  lines.splice(modelProvider.index, 1);
  const provider = findProviderBlock(lines);
  removeRange(lines, provider.start, provider.end);
  if (state.previousModelProvider && state.previousModelProvider.present) {
    const index = Math.min(Number.isInteger(state.previousModelProvider.index) ? state.previousModelProvider.index : firstTableIndex(lines), firstTableIndex(lines));
    lines.splice(index, 0, state.previousModelProvider.rawLine);
  }
  if (state.previousProviderBlock && state.previousProviderBlock.present) {
    const index = Math.min(Number.isInteger(state.previousProviderBlock.index) ? state.previousProviderBlock.index : lines.length, lines.length);
    lines.splice(index, 0, ...state.previousProviderBlock.lines);
  }
  fs.writeFileSync(configPath, renderText(lines, parsed.lineEnding, parsed.trailingNewline), "utf8");
  fs.rmSync(statePathFor(configPath), { force: true });
  return { changed: true };
}

module.exports = { applyWindowsDesktopProvider, restoreWindowsDesktopProvider, statePathFor };