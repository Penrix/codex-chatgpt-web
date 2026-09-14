import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildManagedWindowsCodexCatalog,
  findWindowsCodexExecutables,
  loadBundledWindowsCodexCatalog,
} from "../src/codex-bundled-catalog";
import { defaultConfig } from "../src/config";
import {
  installManagedModelCatalog,
  restoreManagedModelCatalog,
  verifyManagedModelCatalogInstalled,
} from "../src/codex-static-catalog-route";
import { splitLines, findTopLevelAssignment } from "../src/codex-integration-document";

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

function standaloneExecutable(localAppData: string): string {
  return join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
}

test("discovers the official standalone Codex CLI", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-standalone-catalog-"));
  try {
    const executable = standaloneExecutable(localAppData);
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "");
    expect(findWindowsCodexExecutables(localAppData)).toEqual([executable]);
  } finally {
    rmSync(localAppData, { recursive: true, force: true });
  }
});

test("does not silently use the Codex Desktop bundled CLI", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-standalone-catalog-"));
  try {
    const desktopExecutable = join(localAppData, "OpenAI", "Codex", "bin", "fd4c151a749f3ab4", "codex.exe");
    mkdirSync(dirname(desktopExecutable), { recursive: true });
    writeFileSync(desktopExecutable, "");
    expect(findWindowsCodexExecutables(localAppData)).toEqual([]);
  } finally {
    rmSync(localAppData, { recursive: true, force: true });
  }
});

test("reads the standalone CLI bundled model catalog", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-standalone-catalog-"));
  try {
    const executable = standaloneExecutable(localAppData);
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "");
    const catalog = loadBundledWindowsCodexCatalog({
      platform: "win32",
      localAppData,
      run: (candidate, args) => ({
        status: candidate === executable && args.join(" ") === "debug models --bundled" ? 0 : 1,
        stdout: JSON.stringify(nativeCatalog),
      }),
    });
    expect(catalog).toEqual(nativeCatalog);
  } finally {
    rmSync(localAppData, { recursive: true, force: true });
  }
});

test("falls back to isolated debug models for standalone CLI variants without --bundled", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-standalone-catalog-"));
  const tempRoot = mkdtempSync(join(tmpdir(), "codex-standalone-fallback-"));
  let isolatedHome = "";
  const calls: string[] = [];
  try {
    const executable = standaloneExecutable(localAppData);
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "");
    const catalog = loadBundledWindowsCodexCatalog({
      platform: "win32",
      localAppData,
      tempRoot,
      run: (candidate, args, options) => {
        expect(candidate).toBe(executable);
        calls.push(args.join(" "));
        if (args.join(" ") === "debug models --bundled") return { status: 2, stdout: "" };
        expect(args).toEqual(["debug", "models"]);
        isolatedHome = options?.env?.CODEX_HOME ?? "";
        expect(isolatedHome).not.toBe("");
        expect(existsSync(isolatedHome)).toBe(true);
        return { status: 0, stdout: JSON.stringify(nativeCatalog) };
      },
    });
    expect(catalog).toEqual(nativeCatalog);
    expect(calls).toEqual(["debug models --bundled", "debug models"]);
    expect(existsSync(isolatedHome)).toBe(false);
  } finally {
    rmSync(localAppData, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("builds native plus ChatGPT Web models from the standalone CLI catalog", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-standalone-catalog-"));
  try {
    const executable = standaloneExecutable(localAppData);
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "");
    const artifact = buildManagedWindowsCodexCatalog(defaultConfig(), {
      platform: "win32",
      localAppData,
      run: () => ({ status: 0, stdout: JSON.stringify(nativeCatalog) }),
    });
    expect(artifact).toBeDefined();
    const parsed = JSON.parse(artifact!.data) as { models: Array<{ slug: string }> };
    expect(parsed.models.some(model => model.slug === "gpt-5.6-sol")).toBe(true);
    expect(parsed.models.some(model => model.slug === "chatgpt-web/high")).toBe(true);
  } finally {
    rmSync(localAppData, { recursive: true, force: true });
  }
});

test("managed model_catalog_json is reversible", () => {
  const original = 'model_catalog_json = "C:\\\\native.json"\r\n[features]\r\nmulti_agent = true\r\n';
  const previous = findTopLevelAssignment(splitLines(original), "model_catalog_json");
  const managedPath = "C:\\Users\\123\\.codex-chatgpt-web\\codex\\model-catalog.json";
  const installed = installManagedModelCatalog(original, managedPath, true);
  expect(verifyManagedModelCatalogInstalled(installed, managedPath)).toBe(true);
  expect(restoreManagedModelCatalog(installed, managedPath, previous)).toBe(original);
});
