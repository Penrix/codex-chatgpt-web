import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
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

interface BundledCatalogOptions {
  platform?: NodeJS.Platform;
  localAppData?: string;
  run?: (executable: string, args: string[]) => CommandResult;
}

export function findWindowsCodexExecutables(localAppData: string): string[] {
  const binRoot = join(localAppData, "OpenAI", "Codex", "bin");
  let entries;
  try {
    entries = readdirSync(binRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory() && /^[a-f0-9]{12,64}$/i.test(entry.name))
    .map(entry => {
      const executable = join(binRoot, entry.name, "codex.exe");
      try {
        const stat = statSync(executable);
        return stat.isFile() ? { executable, modifiedAt: stat.mtimeMs } : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((candidate): candidate is { executable: string; modifiedAt: number } => Boolean(candidate))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .map(candidate => candidate.executable);
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

function defaultRun(executable: string, args: string[]): CommandResult {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
    stdout: result.stdout ?? "",
  };
}

export function loadBundledWindowsCodexCatalog(
  options: BundledCatalogOptions = {},
): BundledCodexCatalog | undefined {
  const platform = options.platform ?? process.platform;
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA?.trim();
  if (platform !== "win32" || !localAppData) return undefined;
  const run = options.run ?? defaultRun;
  for (const executable of findWindowsCodexExecutables(localAppData)) {
    const result = run(executable, ["debug", "models", "--bundled"]);
    if (result.status !== 0 || result.error) continue;
    const catalog = parseBundledCodexCatalog(result.stdout);
    if (catalog) return catalog;
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
      "Windows Codex model catalog is unavailable; expected the installed Codex CLI to support `debug models --bundled`",
    );
  }
  const merged = augmentNativeModelCatalog(nativeCatalog, config);
  return {
    path: getManagedCodexCatalogPath(),
    data: `${JSON.stringify(merged, null, 2)}\n`,
  };
}
