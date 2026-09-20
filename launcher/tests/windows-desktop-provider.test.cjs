const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyWindowsDesktopProvider, restoreWindowsDesktopProvider, statePathFor } = require("../electron/windows-desktop-provider.cjs");

function fixture(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "penrix-desktop-provider-"));
  const configPath = path.join(root, "config.toml");
  fs.writeFileSync(configPath, text, "utf8");
  return { root, configPath };
}

test("applies the localhost provider and restores the original config exactly", () => {
  const original = [
    'model = "gpt-5.6-sol"',
    'approval_policy = "never"',
    'openai_base_url = "http://127.0.0.1:17841/v1"',
    'experimental_realtime_webrtc_call_base_url = "https://chatgpt.com/backend-api/codex"',
    "",
    "[features]",
    "multi_agent = true",
    "",
  ].join("\r\n");
  const { root, configPath } = fixture(original);
  try {
    const applied = applyWindowsDesktopProvider(configPath, "win32");
    assert.equal(applied.changed, true);
    const patched = fs.readFileSync(configPath, "utf8");
    assert.match(patched, /^model_provider = "codex_web_gpt"$/m);
    assert.match(patched, /^openai_base_url = "http:\/\/127\.0\.0\.1:17841\/v1"$/m);
    assert.match(patched, /^\[model_providers\.codex_web_gpt\]$/m);
    assert.match(patched, /^base_url = "http:\/\/localhost:17841\/v1"$/m);
    assert.match(patched, /^wire_api = "responses"$/m);
    assert.match(patched, /^requires_openai_auth = true$/m);
    assert.match(patched, /^supports_websockets = false$/m);
    assert.ok(fs.existsSync(statePathFor(configPath)));

    const second = applyWindowsDesktopProvider(configPath, "win32");
    assert.equal(second.changed, false);
    assert.equal((fs.readFileSync(configPath, "utf8").match(/\[model_providers\.codex_web_gpt\]/g) || []).length, 1);

    const restored = restoreWindowsDesktopProvider(configPath, "win32");
    assert.equal(restored.changed, true);
    assert.equal(fs.readFileSync(configPath, "utf8"), original);
    assert.equal(fs.existsSync(statePathFor(configPath)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preserves and restores a pre-existing model provider and provider table", () => {
  const original = [
    'model_provider = "custom"',
    'openai_base_url = "http://127.0.0.1:17841/v1"',
    "",
    "[model_providers.custom]",
    'name = "Custom"',
    'base_url = "https://example.invalid/v1"',
    "",
    "[model_providers.codex_web_gpt]",
    'name = "User-owned old table"',
    'base_url = "http://127.0.0.1:9999/v1"',
  ].join("\n");
  const { root, configPath } = fixture(original);
  try {
    applyWindowsDesktopProvider(configPath, "win32");
    const patched = fs.readFileSync(configPath, "utf8");
    assert.match(patched, /^model_provider = "codex_web_gpt"$/m);
    assert.match(patched, /^base_url = "http:\/\/localhost:17841\/v1"$/m);
    assert.match(patched, /^\[model_providers\.custom\]$/m);
    restoreWindowsDesktopProvider(configPath, "win32");
    const restored = fs.readFileSync(configPath, "utf8");
    assert.match(restored, /^model_provider = "custom"$/m);
    assert.match(restored, /^name = "User-owned old table"$/m);
    assert.match(restored, /^base_url = "http:\/\/127\.0\.0\.1:9999\/v1"$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite a provider changed after setup", () => {
  const original = 'openai_base_url = "http://127.0.0.1:17841/v1"\n';
  const { root, configPath } = fixture(original);
  try {
    applyWindowsDesktopProvider(configPath, "win32");
    const changed = fs.readFileSync(configPath, "utf8").replace(
      'base_url = "http://localhost:17841/v1"',
      'base_url = "http://localhost:19999/v1"',
    );
    fs.writeFileSync(configPath, changed, "utf8");
    assert.throws(() => restoreWindowsDesktopProvider(configPath, "win32"), /changed after setup/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});