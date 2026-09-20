# Penrix Windows Codex Desktop explicit-provider trial

This branch targets one blocker only: Codex Desktop must show `chatgpt-web/*` and a fresh `chatgpt-web/high` task must complete.

It applies the configuration shape already verified on Windows in upstream issue #452:

```toml
openai_base_url = "http://127.0.0.1:17841/v1"
model_provider = "codex_web_gpt"

[model_providers.codex_web_gpt]
name = "Codex Web GPT local bridge"
base_url = "http://localhost:17841/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

The important split is intentional: the launcher-owned `openai_base_url` remains `127.0.0.1`, while the explicit provider uses `localhost` for actual model/catalog traffic.

## Apply

First run the launcher normally and complete **Install into Codex**. Then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-penrix-windows-desktop-provider.ps1 -SetHighDefault
```

The script refuses to run unless the launcher-managed `openai_base_url` already equals `http://127.0.0.1:17841/v1`. It creates a timestamped backup before changing anything.

Then:

1. Keep Codex Web GPT launcher open.
2. Fully quit Codex Desktop, including background `codex.exe`.
3. Reopen Codex Desktop.
4. Check whether the picker contains `chatgpt-web/*`.
5. Create a fresh task with `chatgpt-web/high` and send `Reply with exactly: PONG`.

Pass means both the picker and the real High turn work. Full Harness/MCP is deliberately out of scope.

## Roll back

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-penrix-windows-desktop-provider.ps1 -Restore
```

Then fully restart Codex Desktop.