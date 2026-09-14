from pathlib import Path

runtime = Path("launcher/electron/runtime.cjs")
text = runtime.read_text(encoding="utf-8")
old = '''      const current = await this.bridgeStatus(name);\n      if (!current.installed) throw new Error("Install the Codex integration before connecting the bridge route");\n      if (current.active) return current;\n      try {\n'''
new = '''      const current = await this.bridgeStatus(name);\n      if (!current.installed) throw new Error("Install the Codex integration before connecting the bridge route");\n      const staticCatalogReady = this.platform !== "win32" || current.staticCatalogActive === true;\n      if (current.active && staticCatalogReady) return current;\n      try {\n'''
if old in text:
    if text.count(old) != 1:
        raise SystemExit(f"runtime anchor count was {text.count(old)}, expected 1")
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit("runtime connectBridgeRoute migration guard is missing")
runtime.write_text(text, encoding="utf-8")

tests = Path("launcher/tests/runtime-host.test.cjs")
test_text = tests.read_text(encoding="utf-8")
marker = 'test("launcher leaves an already connected route unchanged", async () => {'
if marker not in test_text:
    raise SystemExit("runtime-host bridge test marker not found")
regression = r'''
test("Windows startup repairs an active v10 route that is missing the managed static catalog", async () => {
  const fixture = bridgeFixture({ active: true });
  fixture.host.platform = "win32";
  let staticCatalogActive = false;
  fixture.host.bridgeStatus = async () => {
    fixture.calls.push("route status");
    return {
      installed: true,
      active: true,
      staticCatalogActive,
      errors: [],
    };
  };
  fixture.host.run = async (_name, args) => {
    const action = args.join(" ");
    fixture.calls.push(action);
    if (action !== "route connect") throw new Error(`Unexpected route action: ${action}`);
    staticCatalogActive = true;
    return { stdout: JSON.stringify({ changed: true, active: true }) };
  };

  const result = await fixture.host.connectBridgeRoute();

  assert.equal(result.active, true);
  assert.equal(staticCatalogActive, true);
  assert.deepEqual(fixture.calls, ["route status", "route connect", "route status"]);
});

'''
if "Windows startup repairs an active v10 route that is missing the managed static catalog" not in test_text:
    insert_at = test_text.index(marker)
    test_text = test_text[:insert_at] + regression + test_text[insert_at:]

fixture_old = "function bridgeFixture({ active }) {"
fixture_new = "function bridgeFixture({ active, staticCatalogActive = false }) {"
if fixture_old in test_text:
    test_text = test_text.replace(fixture_old, fixture_new, 1)
elif fixture_new not in test_text:
    raise SystemExit("bridgeFixture signature not found")

status_old = 'return { stdout: JSON.stringify({ installed: true, active: routeActive, errors: [] }) };'
status_new = 'return { stdout: JSON.stringify({ installed: true, active: routeActive, staticCatalogActive, errors: [] }) };'
if status_old in test_text:
    test_text = test_text.replace(status_old, status_new, 1)
elif status_new not in test_text:
    raise SystemExit("bridgeFixture route status response not found")

unchanged_old = '''test("launcher leaves an already connected route unchanged", async () => {\n  const fixture = bridgeFixture({ active: true });'''
unchanged_new = '''test("launcher leaves an already connected route unchanged", async () => {\n  const fixture = bridgeFixture({ active: true, staticCatalogActive: true });'''
if unchanged_old in test_text:
    test_text = test_text.replace(unchanged_old, unchanged_new, 1)
elif unchanged_new not in test_text:
    raise SystemExit("already-connected route test not found")

tests.write_text(test_text, encoding="utf-8")
