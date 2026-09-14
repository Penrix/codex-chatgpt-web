import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig } from "./config";
import { getConfigPath, loadConfig, saveConfig } from "./config";
import { buildManagedWindowsCodexCatalog, getManagedCodexCatalogPath, type ManagedCodexCatalogArtifact } from "./codex-bundled-catalog";
import { installCodexInterruptHook, installCodexInterruptHookCommand } from "./codex-interrupt-hook";
import {
  CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
  getCodexConfigPath,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
  restoreFileSnapshot,
  routeUrl,
  sha256,
  snapshotFile,
  writeFileSnapshot,
  writeIntegrationState,
} from "./codex-integration-shared";
import type {
  AnyCodexIntegrationJournal,
  CodexIntegrationJournal,
  InstallCodexIntegrationOptions,
  LegacyCodexIntegrationJournalV4,
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  LegacyCodexIntegrationJournalV7,
  LegacyCodexIntegrationJournalV8,
  LegacyCodexIntegrationJournalV9,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";
import { assertJournalTargetsConfig, readJournal } from "./codex-integration-journal";
import {
  installManagedModelCatalog,
  restoreManagedModelCatalog,
  verifyManagedModelCatalogInstalled,
  verifyManagedModelCatalogRestored,
} from "./codex-static-catalog-route";
import {
  findTopLevelAssignment,
  installCompatibilityV1Features,
  splitLines,
  textFormat,
} from "./codex-integration-document";
import {
  assertPreservedPreviousAssignments,
  assertPreservedPreviousRealtimeAssignment,
  installRoute,
  managedJournalIsActive,
  replacementBaseline,
  restoreLegacyV2,
  restoreManagedRoute,
  verifyInstalledRoute,
  verifyManagedJournalState,
  verifyRestoredRoute,
} from "./codex-integration-route";

function catalogPrevious(journal: Exclude<AnyCodexIntegrationJournal, { version: 2 }>) {
  return journal.previous.model_catalog_json;
}

function verifyManagedCatalogFile(path: string): void {
  if (!existsSync(path)) throw new Error(`Managed Codex model catalog is missing: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Managed Codex model catalog is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const models = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { models?: unknown }).models
    : undefined;
  if (!Array.isArray(models)
    || !models.some(model => model && typeof model === "object" && !Array.isArray(model)
      && typeof (model as { slug?: unknown }).slug === "string"
      && (model as { slug: string }).slug.startsWith("chatgpt-web/"))) {
    throw new Error("Managed Codex model catalog does not contain ChatGPT Web models");
  }
}

function verifyManagedIntegrationState(
  text: string,
  journal: Exclude<AnyCodexIntegrationJournal, { version: 2 }>,
): boolean {
  verifyManagedJournalState(text, journal);
  if (journal.version !== 10 || process.platform !== "win32") return false;
  const catalogPath = getManagedCodexCatalogPath();
  if (verifyManagedModelCatalogInstalled(text, catalogPath)) {
    verifyManagedCatalogFile(catalogPath);
    return true;
  }
  verifyManagedModelCatalogRestored(text, catalogPrevious(journal));
  return false;
}

type RestorableIntegrationJournal =
  | CodexIntegrationJournal
  | LegacyCodexIntegrationJournalV9
  | LegacyCodexIntegrationJournalV8
  | LegacyCodexIntegrationJournalV7
  | LegacyCodexIntegrationJournalV6
  | LegacyCodexIntegrationJournalV5
  | LegacyCodexIntegrationJournalV4;

function verifyRestoredIntegrationState(
  text: string,
  journal: RestorableIntegrationJournal,
): void {
  verifyRestoredRoute(text, journal);
  if (journal.version === 10 && process.platform === "win32") {
    verifyManagedModelCatalogRestored(text, catalogPrevious(journal));
  }
}

function restoreManagedIntegrationRoute(
  text: string,
  journal: Exclude<AnyCodexIntegrationJournal, { version: 2 }>,
  options: { allowChangedCatalog?: boolean } = {},
): string {
  const restored = restoreManagedRoute(text, journal);
  if (journal.version !== 10 || process.platform !== "win32") return restored;
  return restoreManagedModelCatalog(
    restored,
    getManagedCodexCatalogPath(),
    catalogPrevious(journal),
    { allowChanged: options.allowChangedCatalog === true },
  );
}

function replacementIntegrationBaseline(
  currentText: string,
  configExists: boolean,
  journal: Exclude<AnyCodexIntegrationJournal, { version: 2 }>,
): string {
  const baseline = replacementBaseline(currentText, configExists, journal);
  if (journal.version !== 10 || process.platform !== "win32") return baseline;
  return restoreManagedModelCatalog(
    baseline,
    getManagedCodexCatalogPath(),
    catalogPrevious(journal),
    { allowChanged: true },
  );
}

function commitInstalledIntegration(
  journal: CodexIntegrationJournal,
  configText: string,
  managedCatalog: ManagedCodexCatalogArtifact | undefined,
): void {
  const catalogSnapshot = managedCatalog ? snapshotFile(managedCatalog.path) : undefined;
  try {
    if (managedCatalog && catalogSnapshot) writeFileSnapshot(catalogSnapshot, managedCatalog.data);
    writeIntegrationState(
      journal,
      { path: journal.configPath, data: configText },
      [getCodexModelsCachePath()],
    );
  } catch (error) {
    if (catalogSnapshot) {
      try { restoreFileSnapshot(catalogSnapshot); } catch { /* Integration state already rolls back its own files. */ }
    }
    throw error;
  }
}

function installConfiguredRoute(
  baseline: string,
  installedUrl: string,
  config: Pick<AppConfig, "subagentProtocol"> & (
    Pick<AppConfig, "runtimeCommand"> | { interruptHookCommand: string }
  ),
  replaceExistingRoute: boolean,
  replaceExistingRealtimeRoute: boolean,
): {
  text: string;
  previous: CodexIntegrationJournal["previous"];
  previousRealtimeWebrtcCallBaseUrl: CodexIntegrationJournal["previousRealtimeWebrtcCallBaseUrl"];
  previousMultiAgent?: CodexIntegrationJournal["previousMultiAgent"];
  previousMultiAgentV2?: CodexIntegrationJournal["previousMultiAgentV2"];
  previousAgentMaxDepth?: CodexIntegrationJournal["previousAgentMaxDepth"];
  installedAgentMaxDepth?: number;
  interruptHook: CodexIntegrationJournal["interruptHook"];
} {
  const route = installRoute(
    baseline,
    installedUrl,
    replaceExistingRoute,
    replaceExistingRealtimeRoute,
  );
  const routedText = process.platform === "win32"
    ? installManagedModelCatalog(route.text, getManagedCodexCatalogPath(), replaceExistingRoute)
    : route.text;
  const configured = config.subagentProtocol === "compatibility-v1"
    ? (() => {
        const features = installCompatibilityV1Features(routedText);
        return {
          text: features.text,
          previous: route.previous,
          previousRealtimeWebrtcCallBaseUrl: route.previousRealtimeWebrtcCallBaseUrl,
          previousMultiAgent: features.previousMultiAgent,
          previousMultiAgentV2: features.previousMultiAgentV2,
          previousAgentMaxDepth: features.previousAgentMaxDepth,
          installedAgentMaxDepth: features.installedAgentMaxDepth,
        };
      })()
    : { ...route, text: routedText };
  const hook = "interruptHookCommand" in config
    ? installCodexInterruptHookCommand(configured.text, getCodexConfigPath(), config.interruptHookCommand)
    : installCodexInterruptHook(configured.text, getCodexConfigPath(), config);
  return { ...configured, text: hook.text, interruptHook: hook.installed };
}

function journalProtocol(journal: Exclude<AnyCodexIntegrationJournal, { version: 2 }>): AppConfig["subagentProtocol"] {
  return journal.version === 8 || journal.version === 9 || journal.version === 10
    ? journal.installed.subagent_protocol
    : "native";
}

export {
  getCodexConfigPath,
  getCodexHome,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
} from "./codex-integration-shared";
export { readCodexModelContextOverride } from "./codex-integration-document";
export type {
  CodexIntegrationJournal,
  CodexModelContextOverride,
  InstallCodexIntegrationOptions,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";

export function readCodexSubagentProtocol(
  fallback: AppConfig["subagentProtocol"] = "compatibility-v1",
): AppConfig["subagentProtocol"] {
  const journal = readJournal();
  return journal?.version === 8 || journal?.version === 9 || journal?.version === 10
    ? journal.installed.subagent_protocol
    : fallback;
}

export function setCodexSubagentProtocol(
  config: AppConfig,
  protocol: AppConfig["subagentProtocol"],
): CodexIntegrationJournal {
  const status = inspectCodexIntegration();
  if (!status.installed) throw new Error("Codex integration is not installed; run setup first");
  if (!status.active) {
    throw new Error("Codex integration is disconnected; reconnect it before changing the subagent protocol");
  }
  const nextConfig = { ...config, subagentProtocol: protocol };
  // The runtime catalog and Codex feature surface are two halves of one protocol selection. If
  // either write fails, restore every participant so the next launcher/Codex restart cannot load a
  // split V1/V2 state.
  const snapshots = [
    getConfigPath(),
    getCodexConfigPath(),
    getCodexModelsCachePath(),
    getCodexJournalPath(),
    getCodexJournalRecoveryPath(),
  ].map(path => snapshotFile(path, { followSymlink: path === getCodexConfigPath() }));
  try {
    const journal = installCodexIntegration(nextConfig);
    saveConfig(nextConfig);
    return journal;
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [...snapshots].reverse()) {
      try {
        restoreFileSnapshot(snapshot);
      } catch (rollbackError) {
        rollbackFailures.push(
          `${snapshot.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackFailures.length > 0
      ? `${primary}; subagent protocol rollback also failed: ${rollbackFailures.join("; ")}`
      : primary);
  }
}

export function preflightCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): void {
  const configPath = getCodexConfigPath();
  const configSnapshot = snapshotFile(configPath, { followSymlink: true });
  const configExists = configSnapshot.exists;
  const currentText = configSnapshot.data?.toString("utf8") ?? "";
  const existing = readJournal();
  const installedUrl = routeUrl(config);
  if (existing) assertJournalTargetsConfig(existing, configPath);
  if (existing && existing.version !== 2) {
    if (!configExists) {
      if (options.replaceExistingRoute !== true) {
        throw new Error(`Codex config is missing: ${configPath}`);
      }
      installConfiguredRoute("", installedUrl, config, true, true);
      return;
    }
    try {
      verifyManagedIntegrationState(currentText, existing);
    } catch (error) {
      if (options.replaceExistingRoute !== true) throw error;
      installConfiguredRoute(
        replacementIntegrationBaseline(currentText, configExists, existing),
        installedUrl,
        config,
        true,
        true,
      );
      return;
    }
    if (existing.version === 10) return;
    const baseline = managedJournalIsActive(existing)
      ? restoreManagedIntegrationRoute(currentText, existing)
      : currentText;
    installConfiguredRoute(
      baseline,
      installedUrl,
      config,
      true,
      options.replaceExistingRoute === true,
    );
    return;
  }
  let baseline = currentText;
  if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  }
  installConfiguredRoute(
    baseline,
    installedUrl,
    config,
    options.replaceExistingRoute === true,
    options.replaceExistingRoute === true,
  );
}
export function installCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): CodexIntegrationJournal {
  const configPath = getCodexConfigPath();
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const configExists = existsSync(configPath);
  const currentText = configExists ? readFileSync(configPath, "utf8") : "";
  const existing = readJournal();
  const installedUrl = routeUrl(config);
  const managedCatalog = buildManagedWindowsCodexCatalog(config);
  if (existing) assertJournalTargetsConfig(existing, configPath);

  const hasManagedJournal = Boolean(existing && existing.version !== 2);
  if (hasManagedJournal && !configExists && options.replaceExistingRoute !== true) {
    throw new Error(`Codex config is missing: ${configPath}`);
  }

  if (hasManagedJournal && existing && existing.version !== 2) {
    let baseline: string;
    let preservePrevious = true;
    try {
      verifyManagedIntegrationState(currentText, existing);
      baseline = managedJournalIsActive(existing)
        ? restoreManagedIntegrationRoute(currentText, existing)
        : currentText;
    } catch (error) {
      if (options.replaceExistingRoute !== true) throw error;
      baseline = replacementIntegrationBaseline(currentText, configExists, existing);
      preservePrevious = false;
    }
    const patched = installConfiguredRoute(
      baseline,
      installedUrl,
      config,
      true,
      !preservePrevious || existing.version === 9 || existing.version === 10 || options.replaceExistingRoute === true,
    );
    if (preservePrevious) {
      assertPreservedPreviousAssignments(patched.previous, existing.previous);
      if (existing.version === 9 || existing.version === 10) {
        assertPreservedPreviousRealtimeAssignment(
          patched.previousRealtimeWebrtcCallBaseUrl,
          existing.previousRealtimeWebrtcCallBaseUrl,
        );
      }
    }
    const updated: CodexIntegrationJournal = {
      version: 10,
      active: true,
      configPath,
      installed: {
        openai_base_url: installedUrl,
        experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
        subagent_protocol: config.subagentProtocol,
        ...(config.subagentProtocol === "compatibility-v1" ? {
          agent_max_depth: patched.installedAgentMaxDepth,
        } : {}),
      },
      previous: preservePrevious ? existing.previous : patched.previous,
      previousRealtimeWebrtcCallBaseUrl: preservePrevious && (existing.version === 9 || existing.version === 10)
        ? existing.previousRealtimeWebrtcCallBaseUrl
        : patched.previousRealtimeWebrtcCallBaseUrl,
      interruptHook: patched.interruptHook,
      ...(config.subagentProtocol === "compatibility-v1" ? {
        previousMultiAgent: patched.previousMultiAgent,
        previousMultiAgentV2: patched.previousMultiAgentV2,
        previousAgentMaxDepth: patched.previousAgentMaxDepth,
      } : {}),
      ...(existing.format ? { format: existing.format } : {}),
    };
    commitInstalledIntegration(updated, patched.text, managedCatalog);
    return updated;
  }

  let baseline = currentText;
  if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  }
  const patched = installConfiguredRoute(
    baseline,
    installedUrl,
    config,
    options.replaceExistingRoute === true,
    options.replaceExistingRoute === true,
  );
  const journal: CodexIntegrationJournal = {
    version: 10,
    active: true,
    configPath,
    installed: {
      openai_base_url: installedUrl,
      experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
      subagent_protocol: config.subagentProtocol,
      ...(config.subagentProtocol === "compatibility-v1" ? {
        agent_max_depth: patched.installedAgentMaxDepth,
      } : {}),
    },
    previous: patched.previous,
    previousRealtimeWebrtcCallBaseUrl: patched.previousRealtimeWebrtcCallBaseUrl,
    interruptHook: patched.interruptHook,
    ...(config.subagentProtocol === "compatibility-v1" ? {
      previousMultiAgent: patched.previousMultiAgent,
      previousMultiAgentV2: patched.previousMultiAgentV2,
      previousAgentMaxDepth: patched.previousAgentMaxDepth,
    } : {}),
    format: textFormat(baseline),
  };
  commitInstalledIntegration(journal, patched.text, managedCatalog);
  if (existing?.version === 2 && existsSync(existing.catalogPath)) rmSync(existing.catalogPath);
  return journal;
}

export function deactivateCodexIntegration(): SetCodexIntegrationActiveResult {
  const existing = readJournal();
  if (!existing) return { changed: false, active: false };
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be disconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if ((existing.version === 4 || existing.version === 5 || existing.version === 6 || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10) && !existing.active) {
    verifyRestoredIntegrationState(current, existing);
    return { changed: false, active: false };
  }
  const restored = restoreManagedIntegrationRoute(current, existing);
  const disconnected:
    | CodexIntegrationJournal
    | LegacyCodexIntegrationJournalV9
    | LegacyCodexIntegrationJournalV8
    | LegacyCodexIntegrationJournalV6
    | LegacyCodexIntegrationJournalV7
    | LegacyCodexIntegrationJournalV5
    | LegacyCodexIntegrationJournalV4 = existing.version === 6 || existing.version === 5
      || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10
      ? { ...existing, active: false }
      : { ...existing, version: 4, active: false };
  writeIntegrationState(disconnected, { path: existing.configPath, data: restored }, [getCodexModelsCachePath()]);
  return { changed: true, active: false };
}

export function activateCodexIntegration(): SetCodexIntegrationActiveResult {
  const existing = readJournal();
  if (!existing) throw new Error("Codex integration is not installed");
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be reconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if (existing.version === 10 && existing.active) {
    const staticCatalogActive = verifyManagedIntegrationState(current, existing);
    if (process.platform !== "win32" || staticCatalogActive) return { changed: false, active: true };
  }
  let baseline: string;
  if ((existing.version === 4 || existing.version === 5 || existing.version === 6 || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10) && !existing.active) {
    verifyRestoredIntegrationState(current, existing);
    baseline = current;
  } else {
    verifyManagedIntegrationState(current, existing);
    baseline = restoreManagedIntegrationRoute(current, existing);
  }
  const protocol = journalProtocol(existing);
  const managedCatalog = process.platform === "win32"
    ? buildManagedWindowsCodexCatalog(loadConfig())
    : undefined;
  const hookConfig = existing.version === 10
    ? { interruptHookCommand: existing.interruptHook.command }
    : { runtimeCommand: loadConfig().runtimeCommand };
  const route = installConfiguredRoute(
    baseline,
    existing.installed.openai_base_url,
    { subagentProtocol: protocol, ...hookConfig },
    true,
    existing.version === 9 || existing.version === 10,
  );
  assertPreservedPreviousAssignments(route.previous, existing.previous);
  if (existing.version === 9 || existing.version === 10) {
    assertPreservedPreviousRealtimeAssignment(
      route.previousRealtimeWebrtcCallBaseUrl,
      existing.previousRealtimeWebrtcCallBaseUrl,
    );
  }
  const connected: CodexIntegrationJournal = {
    version: 10,
    active: true,
    configPath: existing.configPath,
    installed: {
      openai_base_url: existing.installed.openai_base_url,
      experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
      subagent_protocol: protocol,
      ...(protocol === "compatibility-v1" ? {
        agent_max_depth: route.installedAgentMaxDepth,
      } : {}),
    },
    previous: existing.previous,
    previousRealtimeWebrtcCallBaseUrl: existing.version === 9 || existing.version === 10
      ? existing.previousRealtimeWebrtcCallBaseUrl
      : route.previousRealtimeWebrtcCallBaseUrl,
    interruptHook: route.interruptHook,
    ...(protocol === "compatibility-v1" ? {
      previousMultiAgent: route.previousMultiAgent,
      previousMultiAgentV2: route.previousMultiAgentV2,
      previousAgentMaxDepth: route.previousAgentMaxDepth,
    } : {}),
    ...(existing.format ? { format: existing.format } : {}),
  };
  commitInstalledIntegration(connected, route.text, managedCatalog);
  return { changed: true, active: true };
}

export function uninstallCodexIntegration(): UninstallCodexIntegrationResult {
  const journal = readJournal();
  if (!journal) return { changed: false };
  if (!existsSync(journal.configPath)) throw new Error(`Codex config is missing: ${journal.configPath}`);
  const current = readFileSync(journal.configPath, "utf8");
  let restored: string;
  if (journal.version === 2) {
    if (existsSync(journal.catalogPath) && sha256(readFileSync(journal.catalogPath)) !== journal.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup: ${journal.catalogPath}`);
    }
    restored = restoreLegacyV2(current, journal);
  } else if ((journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10) && !journal.active) {
    verifyRestoredIntegrationState(current, journal);
    restored = current;
  } else {
    restored = restoreManagedIntegrationRoute(current, journal);
  }
  const configSnapshot = snapshotFile(journal.configPath, { followSymlink: true });
  const catalogSnapshot = journal.version === 2 ? snapshotFile(journal.catalogPath) : undefined;
  const managedCatalogSnapshot = snapshotFile(getManagedCodexCatalogPath());
  const modelsCacheSnapshot = snapshotFile(getCodexModelsCachePath());
  const journalSnapshot = snapshotFile(getCodexJournalPath());
  const recoverySnapshot = snapshotFile(getCodexJournalRecoveryPath());
  try {
    writeFileSnapshot(configSnapshot, restored);
    if (catalogSnapshot?.exists) rmSync(catalogSnapshot.path);
    rmSync(managedCatalogSnapshot.path, { force: true });
    rmSync(modelsCacheSnapshot.path, { force: true });
    rmSync(getCodexJournalPath(), { force: true });
    rmSync(getCodexJournalRecoveryPath(), { force: true });
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [recoverySnapshot, journalSnapshot, modelsCacheSnapshot, managedCatalogSnapshot, catalogSnapshot, configSnapshot]) {
      if (!snapshot) continue;
      try {
        restoreFileSnapshot(snapshot);
      } catch (caught) {
        rollbackFailures.push(`${snapshot.path}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackFailures.length > 0
      ? `${primary}; Codex integration rollback also failed: ${rollbackFailures.join("; ")}`
      : primary);
  }
  return { changed: true };
}

export function inspectCodexIntegration(): {
  installed: boolean;
  active: boolean;
  configPath: string;
  routeUrl?: string;
  journal?: AnyCodexIntegrationJournal;
  staticCatalogActive: boolean;
  errors: string[];
} {
  const journal = readJournal();
  const errors: string[] = [];
  let staticCatalogActive = false;
  if (journal) {
    try {
      assertJournalTargetsConfig(journal, getCodexConfigPath());
      const text = readFileSync(journal.configPath, "utf8");
      if ((journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10) && !journal.active) {
        verifyRestoredIntegrationState(text, journal);
      }
      else if (journal.version === 3 || journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10) {
        staticCatalogActive = verifyManagedIntegrationState(text, journal);
      }
      else {
        const lines = splitLines(text);
        for (const key of ["model_provider", "model_catalog_json"] as const) {
          if (findTopLevelAssignment(lines, key).value !== journal.installed[key]) {
            errors.push(`Codex ${key} no longer matches this installation`);
          }
        }
        if (!text.includes(journal.providerBlock)) errors.push("Managed legacy Codex provider block no longer matches this installation");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    installed: Boolean(journal),
    active: journal?.version === 4 || journal?.version === 5 || journal?.version === 6 || journal?.version === 7 || journal?.version === 8 || journal?.version === 9 || journal?.version === 10
      ? journal.active
      : Boolean(journal),
    configPath: getCodexConfigPath(),
    ...(journal?.version === 3 || journal?.version === 4 || journal?.version === 5 || journal?.version === 6 || journal?.version === 7 || journal?.version === 8 || journal?.version === 9 || journal?.version === 10
      ? { routeUrl: journal.installed.openai_base_url }
      : {}),
    ...(journal ? { journal } : {}),
    staticCatalogActive,
    errors,
  };
}
