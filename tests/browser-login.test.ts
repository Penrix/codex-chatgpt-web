import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptPersistentBrowserLogin,
  browserLoginStateExists,
  browserProfileHasLoginEvidence,
  captureSystemBrowserLogin,
  loginToChatGpt,
  loginVerificationMarkerPath,
  openPersistentProfileCdpSession,
  sanitizeBrowserLoginStorageState,
} from "../src/browser-login";
import { CHATGPT_TEMPORARY_CHAT_URL } from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

test("login starts with normal Chrome and captures state in a headed Keychain-aware context", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousLog = process.env.CODEX_LOGIN_ARG_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    await loginToChatGpt(config, { timeoutMs: 100 }).catch(() => {});

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    const firstLaunch = launches[0] ?? "";
    expect(firstLaunch).toContain("--new-window");
    expect(firstLaunch).toContain("--user-data-dir=");
    expect(firstLaunch).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(firstLaunch).not.toContain("--remote-debugging-pipe");
    expect(launches[1]).not.toContain("--headless");
  } finally {
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy persistent profiles require ChatGPT-domain cookie evidence before reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-profile-evidence-"));
  try {
    expect(browserProfileHasLoginEvidence(root)).toBe(false);
    const network = join(root, "Default", "Network");
    mkdirSync(network, { recursive: true });
    writeFileSync(join(network, "Cookies"), "generic-cookie-db-without-target-domain");
    expect(browserProfileHasLoginEvidence(root)).toBe(false);
    writeFileSync(join(network, "Cookies-wal"), "row host_key=.chatgpt.com encrypted_value=...");
    expect(browserProfileHasLoginEvidence(root)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows legacy-profile adoption reads persisted cookie state through real Chrome CDP", async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-profile-cdp-"));
  const config = defaultConfig("browser-only");
  expect(existsSync(config.chromeExecutablePath)).toBe(true);

  const cookieName = "codex_cdp_profile_probe";
  const sessionCookieName = "codex_cdp_session_probe";
  let seeded: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  let session: Awaited<ReturnType<typeof openPersistentProfileCdpSession>> | undefined;
  let restoredBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // Seed a credential-free legacy profile independently of the production adoption helper.
    // Closing the persistent context proves the cookie is already durable before adoption begins.
    seeded = await chromium.launchPersistentContext(root, {
      executablePath: config.chromeExecutablePath,
      headless: true,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    await seeded.addCookies([
      {
        name: cookieName,
        value: "persisted",
        domain: ".chatgpt.com",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
      {
        name: sessionCookieName,
        value: "session",
        domain: ".chatgpt.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    const seededCookies = await seeded.cookies("https://chatgpt.com/");
    expect(seededCookies.some(cookie => cookie.name === cookieName && cookie.value === "persisted")).toBe(true);
    expect(seededCookies.some(cookie =>
      cookie.name === sessionCookieName && cookie.value === "session" && cookie.expires === -1
    )).toBe(true);
    await seeded.close();
    seeded = undefined;

    session = await openPersistentProfileCdpSession(config, root, 10_000);
    const restored = await session.context.cookies("https://chatgpt.com/");
    expect(restored.some(cookie => cookie.name === cookieName && cookie.value === "persisted")).toBe(true);
    expect(restored.some(cookie =>
      cookie.name === sessionCookieName && cookie.value === "session" && cookie.expires === -1
    )).toBe(true);

    const rawState = await session.context.storageState();
    const rawProbe = rawState.cookies.find(cookie => cookie.name === cookieName);
    if (!rawProbe) {
      throw new Error("CDP storageState omitted the persisted probe cookie");
    }
    expect(rawProbe.value).toBe("persisted");
    const rawSessionProbe = rawState.cookies.find(cookie => cookie.name === sessionCookieName);
    if (!rawSessionProbe) {
      throw new Error("CDP storageState omitted the restored session probe cookie");
    }
    expect(rawSessionProbe.value).toBe("session");
    expect(rawSessionProbe.expires).toBe(-1);

    const sanitized = sanitizeBrowserLoginStorageState(rawState);
    const sanitizedProbe = sanitized.cookies.find(cookie => cookie.name === cookieName);
    if (!sanitizedProbe) {
      throw new Error("Login-state sanitizer removed persisted probe cookie: " + JSON.stringify(rawProbe));
    }
    expect(sanitizedProbe.value).toBe("persisted");
    expect(["chatgpt.com", ".chatgpt.com"]).toContain(sanitizedProbe.domain);
    const sanitizedSessionProbe = sanitized.cookies.find(cookie => cookie.name === sessionCookieName);
    if (!sanitizedSessionProbe) {
      throw new Error("Login-state sanitizer removed restored session probe cookie");
    }
    expect(sanitizedSessionProbe.value).toBe("session");
    expect(sanitizedSessionProbe.expires).toBe(-1);

    restoredBrowser = await chromium.launch({
      executablePath: config.chromeExecutablePath,
      headless: true,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    const restoredContext = await restoredBrowser.newContext({ storageState: sanitized });
    try {
      const imported = await restoredContext.cookies("https://chatgpt.com/");
      expect(imported.some(cookie =>
        cookie.name === cookieName && cookie.value === "persisted"
      )).toBe(true);
      expect(imported.some(cookie =>
        cookie.name === sessionCookieName && cookie.value === "session"
      )).toBe(true);
    } finally {
      await restoredContext.close();
    }
  } finally {
    await restoredBrowser?.close();
    await session?.close();
    await seeded?.close();
    expect(existsSync(join(root, "DevToolsActivePort"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("passkey login authenticates in normal Chrome before isolated offline pipe capture", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-passkey-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  const pidLog = join(root, "pid.log");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"",
    "case \"$*\" in",
    "  *--remote-debugging-pipe*) exit 0 ;;",
    "esac",
    "printf '%s\\n' \"$$\" > \"$CODEX_LOGIN_PID_LOG\"",
    "trap 'exit 0' TERM INT HUP",
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousArgs = process.env.CODEX_LOGIN_ARG_LOG;
  const previousPid = process.env.CODEX_LOGIN_PID_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "transfer", "storage-state.json");
    let continueLogin!: () => void;
    const continuation = new Promise<void>(resolve => { continueLogin = resolve; });
    const capture = captureSystemBrowserLogin(config, { continuation, timeoutMs: 5_000 });
    for (let attempt = 0; attempt < 100 && !existsSync(pidLog); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(existsSync(pidLog)).toBe(true);
    continueLogin();
    const error = await capture.then(() => undefined, caught => caught as Error);
    expect(error).toBeInstanceOf(Error);

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(launches).toHaveLength(2);
    expect(launches[0]).toContain("--new-window");
    expect(launches[0]).toContain("--user-data-dir=");
    expect(launches[0]).not.toContain("--remote-debugging-pipe");
    expect(launches[0]).not.toContain("--enable-automation");
    expect(launches[1]).toContain("--remote-debugging-pipe");
    expect(launches[1]).toContain("--headless");
    expect(launches[1]).toContain("--restore-last-session");
    expect(launches[1]).toContain("--disable-background-networking");
    expect(readdirSync(join(root, "transfer")).filter(name => name.startsWith("login-profile-"))).toEqual([]);
  } finally {
    if (previousArgs === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousArgs;
    if (previousPid === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPid;
    rmSync(root, { recursive: true, force: true });
  }
});

test("passkey storage capture excludes identity-provider and partitioned state", () => {
  const cookie = (name: string, domain: string, extra = {}) => ({
    name,
    value: name,
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
    ...extra,
  });
  const state = sanitizeBrowserLoginStorageState({
    cookies: [
      cookie("chatgpt", ".chatgpt.com"),
      cookie("openai", "auth.openai.com"),
      cookie("first-party-partitioned", ".chatgpt.com", { partitionKey: "https://chatgpt.com" }),
      cookie("idp-partitioned", ".chatgpt.com", { partitionKey: "https://accounts.google.com" }),
      cookie("google", ".accounts.google.com"),
      cookie("lookalike", ".chatgpt.com.attacker.example"),
    ],
    origins: [
      { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
      { origin: "https://accounts.google.com", localStorage: [{ name: "idp", value: "removed" }] },
    ],
  });
  expect(state.cookies.map(value => value.name)).toEqual(["chatgpt", "openai", "first-party-partitioned"]);
  expect(state.origins).toEqual([
    { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
  ]);
});

test("a storage-state file is not trusted without a verification marker", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-state-"));
  try {
    const config = defaultConfig("browser-only");
    config.storageStatePath = join(root, "storage-state.json");
    writeFileSync(config.storageStatePath, "{}\n", { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({ version: 1, authenticated: true, verifiedAt: "2026-07-26T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
