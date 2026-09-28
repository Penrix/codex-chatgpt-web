import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
} from "../src/chatgpt-web-models";
import { ManagedChatGptWebTransport } from "../src/transport";

describe("managed ChatGPT Web transport library", () => {
  it("constructs without the desktop Launcher or a Responses server", async () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-web-transport-"));
    const transport = new ManagedChatGptWebTransport({
      storageStatePath: join(root, "storage-state.json"),
      chromeExecutablePath: process.execPath,
      headed: true,
    });
    try {
      expect(transport.hasLogin()).toBe(false);
    } finally {
      await transport.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exports only automatic browser backend identities", () => {
    expect(CHATGPT_WEB_BACKEND_MODEL).toBe("gpt-5.6-sol");
    expect(CHATGPT_WEB_LUNA_BACKEND_MODEL).toBe("gpt-5.6-luna");
  });
});
