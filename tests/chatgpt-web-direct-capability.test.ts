import { describe, expect, test } from "bun:test";
import { defaultConfig, providerConfig, ZERO_RISK_CHATGPT_CONNECTOR_NAME } from "../src/config";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  resolveChatGptWebModelMode,
} from "../src/adapters/chatgpt-web/model";

describe("browser-only direct tool capability", () => {
  test("automatic Sol browser-only exposes direct tools without MCP tools", () => {
    const config = defaultConfig("browser-only");
    config.browserInteractionMode = "automatic";
    config.solAvailable = true;
    config.proAvailable = false;
    const provider = providerConfig(config);
    expect(provider.chatgptWeb?.localToolsEnabled).toBe(false);
    expect(provider.chatgptWeb?.directToolsEnabled).toBe(true);
    const mode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", {
      localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
      directToolsEnabled: provider.chatgptWeb?.directToolsEnabled === true,
      solAvailable: true,
      proAvailable: false,
    });
    expect(mode.localTools).toBe(true);
  });

  test("Luna never inherits the Sol direct-tools capability", () => {
    const mode = resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_MODEL_ID, "medium", {
      localToolsEnabled: false,
      directToolsEnabled: true,
      solAvailable: false,
      proAvailable: false,
    });
    expect(mode.localTools).toBe(false);
  });

  test("stale Automatic Full mode still uses direct tools instead of a connector", () => {
    const automatic = defaultConfig("full");
    automatic.browserInteractionMode = "automatic";
    automatic.solAvailable = true;
    const automaticProvider = providerConfig(automatic);
    expect(automaticProvider.chatgptWeb?.localToolsEnabled).toBe(false);
    expect(automaticProvider.chatgptWeb?.directToolsEnabled).toBe(true);
  });

  test("Manual Zero Risk Full mode remains connector-backed", () => {
    const manual = defaultConfig("full");
    manual.browserInteractionMode = "manual";
    manual.appName = ZERO_RISK_CHATGPT_CONNECTOR_NAME;
    manual.solAvailable = true;
    const manualProvider = providerConfig(manual);
    expect(manualProvider.chatgptWeb?.localToolsEnabled).toBe(true);
    expect(manualProvider.chatgptWeb?.directToolsEnabled).toBe(false);
  });
});
