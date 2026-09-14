import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";

function nativeCatalog() {
  return {
    models: [
      {
        slug: "gpt-6-astra",
        display_name: "Astra",
        visibility: "list",
        priority: 0,
        base_instructions: "astra instructions",
        shell_type: "astra_shell",
        tool_mode: "code_mode_only",
        multi_agent_version: "v2",
        supported_reasoning_levels: [{ effort: "high", description: "Astra High" }],
      },
      {
        slug: "gpt-5.6-sol",
        display_name: "Sol",
        visibility: "list",
        priority: 2,
        base_instructions: "sol instructions",
        shell_type: "sol_shell",
        tool_mode: "code_mode_only",
        multi_agent_version: "v2",
        supported_reasoning_levels: [
          { effort: "low", description: "Sol Low" },
          { effort: "medium", description: "Sol Medium" },
          { effort: "high", description: "Sol High" },
          { effort: "xhigh", description: "Sol Extra High" },
        ],
      },
      {
        slug: "gpt-5.6-luna",
        display_name: "Luna",
        // The official 0.154 row is hidden from the ordinary picker but is still the authoritative
        // backend template for the Web Luna routes.
        visibility: "hide",
        priority: 8,
        base_instructions: "luna instructions",
        shell_type: "luna_shell",
        tool_mode: "code_mode_only",
        multi_agent_version: "v1",
        supported_reasoning_levels: [
          { effort: "low", description: "Luna" },
          { effort: "medium", description: "Luna Think" },
        ],
      },
    ],
  };
}

function webModels(result: Record<string, unknown>): Array<Record<string, unknown>> {
  return (result.models as Array<Record<string, unknown>>)
    .filter(model => String(model.slug).startsWith("chatgpt-web/"));
}

describe("route-aware native model templates", () => {
  test("Automatic Sol ignores catalog order and inherits the exact Sol CodeModeOnly surface", () => {
    const config = defaultConfig("browser-only");
    config.solAvailable = true;
    config.proAvailable = false;
    config.subagentProtocol = "native";

    const web = webModels(augmentNativeModelCatalog(nativeCatalog(), config));
    expect(web.map(model => model.slug)).toEqual([
      "chatgpt-web/light",
      "chatgpt-web/medium",
      "chatgpt-web/high",
    ]);
    for (const model of web) {
      expect(model.base_instructions).toBe("sol instructions");
      expect(model.shell_type).toBe("sol_shell");
      expect(model.priority).toBe(2);
      expect(model.multi_agent_version).toBe("v2");
      expect(model.tool_mode).toBe("code_mode_only");
    }
  });

  test("Luna routes may use the exact hidden Luna row without enabling Direct Sol tools", () => {
    const config = defaultConfig("browser-only");
    config.solAvailable = false;
    config.proAvailable = false;
    config.subagentProtocol = "native";

    const web = webModels(augmentNativeModelCatalog(nativeCatalog(), config));
    expect(web.map(model => model.slug)).toEqual(["chatgpt-web/luna", "chatgpt-web/think"]);
    for (const model of web) {
      expect(model.base_instructions).toBe("luna instructions");
      expect(model.shell_type).toBe("luna_shell");
      expect(model.priority).toBe(8);
      expect(model.multi_agent_version).toBe("v1");
      expect(model.tool_mode).toBeNull();
    }
  });

  test("Manual Zero Risk uses Sol as its native harness template but keeps the connector tool surface", () => {
    const config = defaultConfig("full");
    config.browserInteractionMode = "manual";
    config.solAvailable = false;
    config.proAvailable = false;
    config.subagentProtocol = "native";

    const web = webModels(augmentNativeModelCatalog(nativeCatalog(), config));
    expect(web).toHaveLength(1);
    expect(web[0]).toMatchObject({
      slug: "chatgpt-web/zero-risk",
      base_instructions: "sol instructions",
      shell_type: "sol_shell",
      priority: 2,
      multi_agent_version: "v2",
      tool_mode: null,
    });
  });

  test("falls back only when the preferred backend row is absent", () => {
    const catalog = nativeCatalog();
    catalog.models.splice(1, 1);
    const config = defaultConfig("browser-only");
    config.solAvailable = true;
    config.proAvailable = false;

    const web = webModels(augmentNativeModelCatalog(catalog, config));
    expect(web).toHaveLength(3);
    expect(web.every(model => model.base_instructions === "astra instructions")).toBe(true);
    expect(web.every(model => model.tool_mode === "code_mode_only")).toBe(true);
  });
});
