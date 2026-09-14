from pathlib import Path

path = Path("launcher/tests/runtime-host.test.cjs")
text = path.read_text(encoding="utf-8")
old = '''  host.runSetup = async (name, args, options = {}) => {\n    invocation = { name, args };\n    await options.afterRuntimeReady?.();\n    return { code: 0, stdout: "", stderr: "" };\n  };\n  return { host, invocation: () => invocation };\n'''
new = '''  host.runSetup = async (name, args, options = {}) => {\n    invocation = { name, args };\n    await options.afterRuntimeReady?.();\n    return { code: 0, stdout: "", stderr: "" };\n  };\n  host.bridgeStatus = async () => ({\n    installed: true,\n    active: true,\n    staticCatalogActive: true,\n    errors: [],\n  });\n  return { host, invocation: () => invocation };\n'''
if new not in text:
    if text.count(old) != 1:
        raise SystemExit(f"hostFor fixture anchor count was {text.count(old)}, expected 1")
    text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
