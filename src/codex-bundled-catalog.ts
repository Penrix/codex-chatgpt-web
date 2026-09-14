import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
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

    // Some Codex Desktop builds identify as the same codex-cli release but do not expose the
    // --bundled debug flag. A plain `debug models` still falls back to the in-memory bundled
    // catalog when online discovery is unavailable. Run it under a brand-new CODEX_HOME so it
    // cannot inherit the user's openai_base_url, model_catalog_json, or ChatGPT auth state and
    // therefore cannot recurse through the bridge we are currently trying to configure.
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
      "Windows Codex model catalog is unavailable; the installed Codex CLI returned no native catalog through bundled or isolated debug-model discovery",
    );
  }
  const merged = augmentNativeModelCatalog(nativeCatalog, config);
  return {
    path: getManagedCodexCatalogPath(),
    data: `${JSON.stringify(merged, null, 2)}\n`,
  };
}
