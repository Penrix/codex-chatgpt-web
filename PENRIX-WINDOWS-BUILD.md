# Penrix Windows Desktop test build

This branch packages upstream 5.0.8 plus the Windows explicit `codex_web_gpt` localhost provider compatibility layer.

## Local computer tools without the official Tunnel

The Penrix Windows build supports a Responses-level tool relay for automatic browser ChatGPT modes.

When Codex advertises native tools in a Responses turn and the official Full/Tunnel harness is not connected:

1. the provider sends the active Codex tool names and JSON schemas to ChatGPT Web;
2. ChatGPT Web returns a private structured tool-request envelope instead of pretending the local computer is unavailable;
3. the adapter validates every requested wire name against the tools Codex actually advertised;
4. the adapter converts the request into the existing Responses `function_call` / custom-tool path;
5. Codex Desktop executes the call with its normal local permissions and returns the real tool result;
6. the next browser turn resumes from the complete canonical Responses history.

This is intended to cover the same ordinary local work that Codex can already perform, including PowerShell commands, ADB, local files, APK/EXE installation workflows, and Chrome-related operations when the corresponding Codex tools are present.

The existing Full/Tunnel harness remains unchanged and takes precedence when it is available.
