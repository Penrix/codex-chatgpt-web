const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../launcher/electron/runtime.cjs");
const { RuntimeSupervisor } = require("../launcher/electron/runtime-supervisor.cjs");

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function fakeRuntimeServer(expectedToken, version = "5.0.6") {
  let closed = false;
  const server = http.createServer((request, response) => {
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET" && request.url === "/healthz") {
      send(200, {
        service: "codex-chatgpt-web",
        status: "ok",
        mode: "browser-only",
        version,
        accepting_turns: true,
      });
      return;
    }
    const authorized = request.headers.authorization === `Bearer ${expectedToken}`;
    if (!authorized) {
      send(401, { status: "error" });
      return;
    }
    if (request.method === "POST" && request.url === "/admin/drain") {
      send(200, {
        status: "ok",
        accepting_turns: false,
        active_http_turns: 0,
        active_browser_turns: 0,
      });
      return;
    }
    if (request.method === "POST" && request.url === "/admin/resume") {
      send(200, { status: "ok", accepting_turns: true });
      return;
    }
    if (request.method === "POST" && request.url === "/admin/shutdown") {
      send(200, { status: "ok" });
      setImmediate(() => server.close(() => { closed = true; }));
      return;
    }
    send(404, { status: "missing" });
  });
  return { server, wasClosed: () => closed };
}

async function smokeExternalAutomaticMigration() {
  const root = tempRoot("codex-v8-external-upgrade-");
  try {
    const config = {
      version: 3,
      releaseVersion: "5.0.6",
      mode: "full",
      browserHost: "managed-chrome",
      browserInteractionMode: "automatic",
      appName: "Codex Native2",
    };
    const supervisor = {
      readSetupConfig: () => structuredClone(config),
      readConfig: () => structuredClone(config),
    };
    const host = new RuntimeHost({
      app: {
        getPath: () => root,
        getVersion: () => "5.0.6",
      },
      logger,
      sourceRoot: root,
      installedRuntimeRoot: root,
      browserDescriptorPath: path.join(root, "launcher-browser.json"),
      coreHome: root,
      codexHome: path.join(root, ".codex"),
      launcherProfile: "production",
      supervisor,
      getBrowserInteractionMode: () => "automatic",
    });
    let observed;
    host.runSetup = async (name, args, options) => {
      observed = { name, args, options };
      return { stdout: "ok" };
    };
    const result = await host.upgradeManagedRuntime();
    assert.equal(result.updated, true);
    assert.equal(result.mode, "browser-only");
    assert.equal(observed.name, "runtime-upgrade");
    assert(observed.args.includes("--browser-only"));
    assert.equal(observed.options.takeOverExternalRuntime, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function supervisorFor(root) {
  return new RuntimeSupervisor({
    app: { getVersion: () => "5.0.6" },
    logger,
    sourceRoot: root,
    installedRuntimeRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher-browser.json"),
    launcherProfile: "production",
    runtimeInvocationFactory: () => ({ executable: process.execPath, args: [], cwd: root }),
  });
}

async function smokeOrphanTakeover() {
  const root = tempRoot("codex-v8-orphan-takeover-");
  const token = "A".repeat(48);
  const fake = fakeRuntimeServer(token);
  try {
    const port = await listen(fake.server);
    const supervisor = supervisorFor(root);
    const recovered = await supervisor.stopStaleOwnedRuntime({
      host: "127.0.0.1",
      port,
      mode: "browser-only",
      releaseVersion: "5.0.6",
      controlToken: token,
    });
    assert.equal(recovered, true);
    assert.equal(fake.wasClosed(), true);
  } finally {
    try { fake.server.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function smokeWrongTokenFailsClosed() {
  const root = tempRoot("codex-v8-orphan-deny-");
  const expectedToken = "B".repeat(48);
  const fake = fakeRuntimeServer(expectedToken);
  try {
    const port = await listen(fake.server);
    const supervisor = supervisorFor(root);
    await assert.rejects(
      supervisor.stopStaleOwnedRuntime({
        host: "127.0.0.1",
        port,
        mode: "browser-only",
        releaseVersion: "5.0.6",
        controlToken: "C".repeat(48),
      }),
      /HTTP 401|resume compensation failed/,
    );
    assert.equal(fake.wasClosed(), false);
  } finally {
    await new Promise(resolve => fake.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  await smokeExternalAutomaticMigration();
  await smokeOrphanTakeover();
  await smokeWrongTokenFailsClosed();
  process.stdout.write("V8_LIVE_RUNTIME_TAKEOVER_SMOKE_OK\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
