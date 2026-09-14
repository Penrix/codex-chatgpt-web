import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findWindowsCodexExecutables, loadBundledWindowsCodexCatalog } from "../src/codex-bundled-catalog";

const nativeCatalog = {
  models: [{
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6 Sol",
    description: "Native model",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    default_reasoning_level: "high",
    supported_reasoning_levels: [{ effort: "high", description: "High" }],
    tool_mode: "code_mode_only",
    multi_agent_version: "v1",
    input_modalities: ["text", "image"],
    context_window: 272000,
    max_context_window: 872000,
    effective_context_window_percent: 95,
  }],
};

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
}

test("prefers official standalone Codex CLI locations over Desktop bundled copies", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-standalone-local-"));
  const userProfile = mkdtempSync(join(tmpdir(), "codex-standalone-user-"));
  try {
    const installed = join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
    const managed = join(userProfile, ".codex", "packages", "standalone", "current", "bin", "codex.exe");
    const desktop = join(localAppData, "OpenAI", "Codex", "bin", "fd4c151a749f3ab4", "codex.exe");
    touch(installed);
    touch(managed);
    touch(desktop);
    expect(findWindowsCodexExecutables(localAppData, userProfile)).toEqual([
      installed,
      managed,
      desktop,
    ]);
  } finally {
    rmSync(localAppData, { recursive: true, force: true });
    rmSync(userProfile, { recursive: true, force: true });
  }
});

test("catalog discovery uses standalone CLI before a Desktop fallback", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-standalone-local-"));
  const userProfile = mkdtempSync(join(tmpdir(), "codex-standalone-user-"));
  const calls: string[] = [];
  try {
    const installed = join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
    const desktop = join(localAppData, "OpenAI", "Codex", "bin", "fd4c151a749f3ab4", "codex.exe");
    touch(installed);
    touch(desktop);
    const catalog = loadBundledWindowsCodexCatalog({
      platform: "win32",
      localAppData,
      userProfile,
      run: (candidate, args) => {
        calls.push(`${candidate}|${args.join(" ")}`);
        return candidate === installed && args.join(" ") === "debug models --bundled"
          ? { status: 0, stdout: JSON.stringify(nativeCatalog) }
          : { status: 1, stdout: "" };
      },
    });
    expect(catalog).toEqual(nativeCatalog);
    expect(calls).toEqual([`${installed}|debug models --bundled`]);
  } finally {
    rmSync(localAppData, { recursive: true, force: true });
    rmSync(userProfile, { recursive: true, force: true });
  }
});
