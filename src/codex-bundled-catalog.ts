import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config";
import { getConfigDir } from "./config";
import { augmentNativeModelCatalog } from "./model-catalog";

export interface BundledCodexCatalog {
  models: unknown[];
  [key: string]: unknown;
}

export interface ManagedCodexCatalogArtifact {
  path: string;
  data: string;
}

interface CommandResult {
  status: number | null;
  error?: Error;
  stdout: string;
}

interface CommandExecutionOptions {
  env?: NodeJS.ProcessEnv;
}

interface BundledCatalogOptions {
  platform?: NodeJS.Platform;
  localAppData?: string;
  tempRoot?: string;
  run?: (
    executable: string,
    args: string[],
    options?: CommandExecutionOptions,
  ) => CommandResult;
}

export function findWindowsCodexExecutables(localAppData: string): string[] {
  // This branch deliberately targets OpenAI's standalone Windows CLI. Do not silently fall back to
  // the Desktop-bundled CLI: the point of this compatibility base is to make the CLI a stable,
  // independently versioned reference implementation.
  const executable = join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
  try {
    return statSync(executable).isFile() ? [executable] : [];
  } catch {
    return [];
  }
}

export function parseBundledCodexCatalog(stdout: string): BundledCodexCatalog | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const models = (parsed as { models?: unknown }).models;
    if (!Array.isArray(models) || models.length === 0) return undefined;
    return parsed as BundledCodexCatalog;
  } catch {
    return undefined;
  }
}

function defaultRun(
  executable: string,
  args: string[],
  options: CommandExecutionOptions = {},
): CommandResult {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  return {
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
    stdout: result.stdout ?? "",
  };
}

function catalogFromResult(result: CommandResult): BundledCodexCatalog | undefined {
  if (result.status !== 0 || result.error) return undefined;
  return parseBundledCodexCatalog(result.stdout);
}

export function loadBundledWindowsCodexCatalog(
  options: BundledCatalogOptions = {},
): BundledCodexCatalog | undefined {
  const platform = options.platform ?? process.platform;
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA?.trim();
  if (platform !== "win32" || !localAppData) return undefined;
  const run = options.run ?? defaultRun;
  const tempRoot = options.tempRoot ?? tmpdir();
  for (const executable of findWindowsCodexExecutables(localAppData)) {
    const bundled = catalogFromResult(run(executable, ["debug", "models", "--bundled"]));
    if (bundled) return bundled;

    // A plain debug-model query under a fresh CODEX_HOME is a safe fallback for standalone builds
    // that do not expose --bundled. The isolated home cannot inherit the user's bridge route,
    // model_catalog_json, or saved Codex auth, so discovery cannot recurse through this launcher.
    const isolatedHome = mkdtempSync(join(tempRoot, "codex-web-gpt-catalog-"));
    try {
      const isolated = catalogFromResult(run(
        executable,
        ["debug", "models"],
        { env: { ...process.env, CODEX_HOME: isolatedHome } },
      ));
      if (isolated) return isolated;
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }
  return undefined;
}

export function getManagedCodexCatalogPath(): string {
  return join(getConfigDir(), "codex", "model-catalog.json");
}

export function buildManagedWindowsCodexCatalog(
  config: AppConfig,
  options: BundledCatalogOptions = {},
): ManagedCodexCatalogArtifact | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const nativeCatalog = loadBundledWindowsCodexCatalog({ ...options, platform });
  if (!nativeCatalog) {
    throw new Error(
      "Official standalone Codex CLI model catalog is unavailable. Install the OpenAI standalone CLI under "
      + "%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin\\codex.exe and retry.",
    );
  }
  const merged = augmentNativeModelCatalog(nativeCatalog, config);
  return {
    path: getManagedCodexCatalogPath(),
    data: `${JSON.stringify(merged, null, 2)}\n`,
  };
}
