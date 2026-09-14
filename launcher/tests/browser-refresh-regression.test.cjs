const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  BrowserHost,
  IDLE_BROWSER_URL,
  TEMPORARY_CHAT_URL,
} = require("../electron/browser-host.cjs");

test("connector verification replaces an existing Temporary Chat document without hard reload", async () => {
  const calls = [];
  const contents = new EventEmitter();
  let currentUrl = TEMPORARY_CHAT_URL;
  contents.isDestroyed = () => false;
  contents.getURL = () => currentUrl;
  contents.stop = () => calls.push("stop");
  contents.loadURL = async (url) => {
    calls.push(["load", url]);
    currentUrl = url;
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    view: { webContents: contents },
    markOwnedSurface: async () => calls.push("owned"),
    waitForAuthenticated: async (timeoutMs) => calls.push(["authenticated", timeoutMs]),
  });

  await fixture.refreshChatGptHomeDocument();

  assert.deepEqual(calls, [
    ["load", IDLE_BROWSER_URL],
    ["load", TEMPORARY_CHAT_URL],
    "owned",
    ["authenticated", 60_000],
  ]);
});

test("connector verification opens Temporary Chat directly from the idle browser", async () => {
  const calls = [];
  const contents = new EventEmitter();
  let currentUrl = IDLE_BROWSER_URL;
  contents.isDestroyed = () => false;
  contents.getURL = () => currentUrl;
  contents.stop = () => calls.push("stop");
  contents.loadURL = async (url) => {
    calls.push(["load", url]);
    currentUrl = url;
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    view: { webContents: contents },
    markOwnedSurface: async () => calls.push("owned"),
    waitForAuthenticated: async (timeoutMs) => calls.push(["authenticated", timeoutMs]),
  });

  await fixture.refreshChatGptHomeDocument();

  assert.deepEqual(calls, [
    ["load", TEMPORARY_CHAT_URL],
    "owned",
    ["authenticated", 60_000],
  ]);
});
