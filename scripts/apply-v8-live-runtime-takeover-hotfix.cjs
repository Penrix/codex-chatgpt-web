const fs = require("node:fs");

function replaceExactlyOnce(file, before, after, label) {
  const source = fs.readFileSync(file, "utf8");
  const usesCrlf = source.includes("\r\n");
  const normalized = source.replace(/\r\n/g, "\n");
  const first = normalized.indexOf(before);
  if (first < 0) throw new Error(`${label}: expected source block was not found in ${file}`);
  if (normalized.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected source block is ambiguous in ${file}`);
  }
  const patched = normalized.slice(0, first) + after + normalized.slice(first + before.length);
  fs.writeFileSync(file, usesCrlf ? patched.replace(/\n/g, "\r\n") : patched);
}

replaceExactlyOnce(
  "launcher/electron/runtime.cjs",
  `    if (existing.owner !== "launcher"\n      || (existing.config?.releaseVersion === currentVersion\n        && !connectorMigrationRequired\n        && !tunnelProfileMigrationRequired\n        && !automaticDirectMigrationRequired)) {\n      return { updated: false };\n    }`,
  `    const externalAutomaticDirectMigration = existing.owner === "external"\n      && automaticDirectMigrationRequired;\n    if ((existing.owner !== "launcher" && !externalAutomaticDirectMigration)\n      || (existing.config?.releaseVersion === currentVersion\n        && !connectorMigrationRequired\n        && !tunnelProfileMigrationRequired\n        && !automaticDirectMigrationRequired)) {\n      return { updated: false };\n    }`,
  "Automatic Full migration must include safely recoverable external legacy runtime",
);

replaceExactlyOnce(
  "launcher/electron/runtime.cjs",
  `      timeoutMs: targetMode === "full" ? MCP_SETUP_TIMEOUT_MS : CORE_SETUP_TIMEOUT_MS,\n    });`,
  `      timeoutMs: targetMode === "full" ? MCP_SETUP_TIMEOUT_MS : CORE_SETUP_TIMEOUT_MS,\n      takeOverExternalRuntime: externalAutomaticDirectMigration,\n    });`,
  "Automatic Full migration must opt into external runtime takeover",
);

replaceExactlyOnce(
  "launcher/electron/runtime.cjs",
  `      runtimeTransitionStarted = true;\n      if (previousRuntime.owner === "external") this.supervisor.prepareExternalMigration();\n      else await this.supervisor.stopForSetup();`,
  `      runtimeTransitionStarted = true;\n      if (previousRuntime.owner === "external") {\n        if (options.takeOverExternalRuntime === true) {\n          await this.supervisor.prepareExternalMigrationFromConfig(previousRuntime.config);\n        } else {\n          this.supervisor.prepareExternalMigration();\n        }\n      } else await this.supervisor.stopForSetup();`,
  "External Automatic migration must prove and stop the old runtime before takeover",
);

replaceExactlyOnce(
  "launcher/electron/runtime-supervisor.cjs",
  `  prepareExternalMigration() {\n    if (this.daemon || this.tunnel) {\n      throw new Error("Launcher-owned runtime children exist while an external installation is configured");\n    }\n    const state = this.readState();\n    if (state && !runtimeOwnershipPredatesCurrentBoot(state) && (\n      processRunning(state.ownerPid)\n      || processRunning(state.daemonPid)\n      || processRunning(state.tunnelPid)\n    )) {\n      throw new Error("Launcher ownership processes are still alive while an external installation is configured");\n    }\n    this.clearState();\n  }`,
  `  prepareExternalMigration() {\n    if (this.daemon || this.tunnel) {\n      throw new Error("Launcher-owned runtime children exist while an external installation is configured");\n    }\n    const state = this.readState();\n    if (state && !runtimeOwnershipPredatesCurrentBoot(state) && (\n      processRunning(state.ownerPid)\n      || processRunning(state.daemonPid)\n      || processRunning(state.tunnelPid)\n    )) {\n      throw new Error("Launcher ownership processes are still alive while an external installation is configured");\n    }\n    this.clearState();\n  }\n\n  async prepareExternalMigrationFromConfig(config) {\n    if (this.daemon || this.tunnel) {\n      throw new Error("Launcher-owned runtime children exist while an external installation is configured");\n    }\n    const state = this.readState();\n    const runtimeMayBeLive = await this.proxyHealth(config) || runtimeOwnershipMayBeLive(state);\n    if (runtimeMayBeLive) {\n      const recovered = await this.stopStaleOwnedRuntime(config);\n      if (!recovered) {\n        throw new Error(\n          "The previous runtime is still live but could not be authenticated for safe launcher takeover",\n        );\n      }\n    }\n    this.prepareExternalMigration();\n  }`,
  "External migration needs authenticated stale-runtime takeover",
);

replaceExactlyOnce(
  "launcher/electron/runtime-supervisor.cjs",
  `  async stopStaleOwnedRuntime(config) {\n    const state = this.readState();\n    if (!state) return false;\n    if (runtimeOwnershipPredatesCurrentBoot(state)) {\n      this.clearState();\n      return false;\n    }`,
  `  async stopOrphanedConfiguredRuntime(config) {\n    const health = await this.proxyHealthPayload(config);\n    const daemonRunning = health?.service === "codex-chatgpt-web"\n      && health?.mode === config.mode\n      && health?.version === config.releaseVersion;\n    if (!daemonRunning) return false;\n\n    this.logger.warn("runtime.orphaned_daemon_recovery_started", {\n      pid: Number.isInteger(health.pid) ? health.pid : null,\n      port: config.port,\n    });\n    let drained = false;\n    try {\n      // The control token is the ownership proof. An unrelated process on the same port cannot\n      // pass this boundary, so no PID-only or process-name kill is ever used here.\n      drained = await this.acquireDrain(config);\n      const shutdown = await this.control(config, "shutdown");\n      if (shutdown.status !== "ok") {\n        throw new Error("orphaned daemon did not acknowledge authenticated shutdown");\n      }\n      if (Number.isInteger(health.pid) && health.pid > 0) {\n        await this.waitForProcessExit("orphaned daemon", health.pid);\n      }\n      await this.waitForPortRelease(config);\n    } catch (error) {\n      if (drained) {\n        try {\n          await this.control(config, "resume");\n        } catch (resumeError) {\n          throw new Error(appendFailure(\n            errorMessage(error),\n            "orphaned daemon resume compensation failed",\n            resumeError,\n          ));\n        }\n      }\n      throw error;\n    }\n\n    if (config.mode === "full") {\n      const tunnelHealth = await this.waitForKnownTunnelStatus(config);\n      if (!tunnelRuntimeStopped(tunnelHealth)) {\n        const stopped = await this.runTunnelStopCommand(config);\n        if (stopped.code !== 0) {\n          throw new Error("orphaned tunnel refused graceful shutdown: " + tunnelControlDiagnostic(stopped));\n        }\n        await this.waitForTunnelStopped(config, 10_000);\n      }\n    }\n    this.clearState();\n    this.logger.info("runtime.orphaned_daemon_recovered");\n    return true;\n  }\n\n  async stopStaleOwnedRuntime(config) {\n    const state = this.readState();\n    if (!state) return await this.stopOrphanedConfiguredRuntime(config);\n    if (runtimeOwnershipPredatesCurrentBoot(state)) {\n      this.clearState();\n      return await this.stopOrphanedConfiguredRuntime(config);\n    }`,
  "State-less orphaned V7 daemon must be recoverable by authenticated control token",
);

process.stdout.write("V8_LIVE_RUNTIME_TAKEOVER_HOTFIX_APPLIED\n");
