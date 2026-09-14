import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") throw new Error("V7 route-repair smoke is Windows-only");
const sourceCodex = resolve(process.argv[2] ?? "");
if (!sourceCodex) throw new Error("Pass the official standalone codex.exe path");

const root = mkdtempSync(join(tmpdir(), "codex-web-gpt-v7-route-"));
const codexHome = join(root, ".codex");
const appHome = join(root, ".codex-chatgpt-web");
const localAppData = join(root, "LocalAppData");
const standalone = join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe");

function runRouteStatus(): any {
  const result = spawnSync(process.execPath, ["run", "src/cli.ts", "route", "status"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`route status failed: ${result.stderr || result.stdout || result.status}`);
  }
  return JSON.parse(result.stdout);
}

try {
  mkdirSync(dirname(standalone), { recursive: true });
  copyFileSync(sourceCodex, standalone);
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  process.env.LOCALAPPDATA = localAppData;

  const [{ defaultConfig }, integration] = await Promise.all([
    import("../src/config"),
    import("../src/codex-integration"),
  ]);
  const config = defaultConfig("browser-only");
  integration.installCodexIntegration(config, { replaceExistingRoute: true });

  const first = runRouteStatus();
  if (first.installed !== true || first.active !== true || first.staticCatalogActive !== true) {
    throw new Error(`route status omitted or misreported staticCatalogActive: ${JSON.stringify(first)}`);
  }
  if (Array.isArray(first.errors) && first.errors.length > 0) {
    throw new Error(`fresh integration is inconsistent: ${JSON.stringify(first.errors)}`);
  }

  const configPath = integration.getCodexConfigPath();
  const current = readFileSync(configPath, "utf8");
  const manuallyRestoredNative = current
    .split(/(?<=\n)/)
    .filter(line => !/^openai_base_url\s*=/.test(line.trimStart()))
    .join("");
  writeFileSync(configPath, manuallyRestoredNative);

  const stale = runRouteStatus();
  if (!Array.isArray(stale.errors)
    || !stale.errors.some((value: unknown) => typeof value === "string" && value.includes("openai_base_url changed after setup"))) {
    throw new Error(`stale journal fixture did not reproduce the V6 startup inconsistency: ${JSON.stringify(stale)}`);
  }

  integration.installCodexIntegration(config, { replaceExistingRoute: true });
  const repaired = runRouteStatus();
  if (repaired.installed !== true || repaired.active !== true || repaired.staticCatalogActive !== true) {
    throw new Error(`replacement setup did not restore the managed Windows catalog: ${JSON.stringify(repaired)}`);
  }
  if (Array.isArray(repaired.errors) && repaired.errors.length > 0) {
    throw new Error(`replacement setup left an inconsistent route: ${JSON.stringify(repaired.errors)}`);
  }

  process.stdout.write("V7_ROUTE_STATUS_AND_STALE_JOURNAL_REPAIR_OK\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
