import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
} from "../src/chatgpt-web-models";
import { ManagedChatGptWebTransport } from "../src/transport";
import { ChatGptBrowserWorker, type ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";

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

  it("creates independent browser workers for library ownership", () => {
    const config: ResolvedBrowserConfig = {
      appName: "test",
      browserHost: "managed-chrome",
      storageStatePath: "/tmp/unused-storage-state.json",
      chromeExecutablePath: process.execPath,
      headed: true,
      autoApproveToolCalls: false,
    };
    expect(ChatGptBrowserWorker.create(config)).not.toBe(ChatGptBrowserWorker.create(config));
  });

  it("keeps each library transport lifecycle independent", async () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-web-transport-owner-"));
    const options = {
      storageStatePath: join(root, "storage-state.json"),
      chromeExecutablePath: process.execPath,
      headed: true,
    };
    const first = new ManagedChatGptWebTransport(options);
    const second = new ManagedChatGptWebTransport(options);
    try {
      expect(first).not.toBe(second);
      expect(first.hasLogin()).toBe(false);
      expect(second.hasLogin()).toBe(false);
    } finally {
      await first.close();
      await second.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not ask for another login when verified storage state already exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-web-transport-stored-login-"));
    const storageStatePath = join(root, "storage-state.json");
    writeFileSync(storageStatePath, JSON.stringify({ cookies: [], origins: [] }));
    writeFileSync(
      storageStatePath + ".verified.json",
      JSON.stringify({
        version: 1,
        authenticated: true,
        verifiedAt: "2026-09-29T00:00:00.000Z",
        solAvailable: true,
        proAvailable: false,
      }),
    );
    const transport = new ManagedChatGptWebTransport({
      storageStatePath,
      chromeExecutablePath: process.execPath,
      loginProfileDir: root,
      reusableLoginProfileDirs: [root],
    });
    try {
      expect(await transport.ensureLogin(1)).toBe("stored");
    } finally {
      await transport.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("can forbid interactive login without launching a browser", async () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-web-transport-no-login-"));
    const transport = new ManagedChatGptWebTransport({
      storageStatePath: join(root, "storage-state.json"),
      chromeExecutablePath: process.execPath,
      loginProfileDir: root,
      reusableLoginProfileDirs: [],
      allowInteractiveLogin: false,
    });
    try {
      await expect(transport.ensureLogin(1)).rejects.toThrow(
        "interactive login is disabled for this run",
      );
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
