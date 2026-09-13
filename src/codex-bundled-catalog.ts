import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

interface BundledCodexCatalog {
  models: unknown[];
  [key: string]: unknown;
}

let cachedWindowsCatalog: BundledCodexCatalog | undefined;

function windowsCodexCandidates(): string[] {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (process.platform !== "win32" || !localAppData) return [];
  const binRoot = join(localAppData, "OpenAI", "Codex", "bin");
  let entries;
  try {
    entries = readdirSync(binRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory() && /^[a-f0-9]{32}$/i.test(entry.name))
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

function parseBundledCatalog(stdout: string): BundledCodexCatalog | undefined {
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

/**
 * Codex Desktop 26.903 can fail its online `/models` refresh while its own bundled catalog remains
 * available. Read that authoritative per-install catalog only as a Windows fallback. The normal
 * bridge path still prefers the live Codex backend, so a later successful refresh automatically
 * supersedes this snapshot instead of freezing model updates through `model_catalog_json`.
 */
export function loadBundledWindowsCodexCatalog(): BundledCodexCatalog | undefined {
  if (cachedWindowsCatalog) return cachedWindowsCatalog;
  for (const executable of windowsCodexCandidates()) {
    const result = spawnSync(executable, ["debug", "models", "--bundled"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0 || result.error) continue;
    const catalog = parseBundledCatalog(result.stdout);
    if (!catalog) continue;
    cachedWindowsCatalog = catalog;
    return catalog;
  }
  return undefined;
}
