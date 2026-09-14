from pathlib import Path

path = Path("launcher/electron/browser-host.cjs")
text = path.read_text(encoding="utf-8")
old = '''  async refreshChatGptHomeDocument() {\n    // A navigation from the idle host already creates a fresh ChatGPT document. Reload only an\n    // existing Temporary Chat document so the helper observes one authoritative SPA bootstrap.\n    if (isTemporaryChatUrl(this.view.webContents.getURL())) {\n      await this.hardRefreshHome();\n    } else {\n      await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);\n    }\n    await this.waitForAuthenticated(60_000);\n  }\n'''
new = '''  async refreshChatGptHomeDocument() {\n    const contents = this.view.webContents;\n    // Electron can surface a failed same-URL reload on Windows even though the existing Temporary\n    // Chat document is otherwise healthy. Reset through our local idle document instead, then\n    // create exactly one fresh ChatGPT document for connector/session verification.\n    if (isTemporaryChatUrl(contents.getURL())) {\n      await loadCommittedBrowserSurface(contents, IDLE_BROWSER_URL, BROWSER_NAVIGATION_TIMEOUT_MS);\n    }\n    await contents.loadURL(TEMPORARY_CHAT_URL);\n    // did-finish-load also marks the surface asynchronously. Await the mark here so the connector\n    // verifier never races the ownership contract on this explicit setup refresh.\n    await this.markOwnedSurface();\n    await this.waitForAuthenticated(60_000);\n  }\n'''
if old in text:
    if text.count(old) != 1:
        raise SystemExit(f"refresh block count was {text.count(old)}, expected 1")
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit("refreshChatGptHomeDocument patch anchor was not found")
path.write_text(text, encoding="utf-8")
