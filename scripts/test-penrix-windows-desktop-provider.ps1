$ErrorActionPreference = "Stop"

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("penrix-codex-provider-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $root | Out-Null
$config = Join-Path $root "config.toml"
$installer = Join-Path $PSScriptRoot "install-penrix-windows-desktop-provider.ps1"

$original = @'
model = "gpt-5.6-sol"
approval_policy = "never"
openai_base_url = "http://127.0.0.1:17841/v1"
experimental_realtime_webrtc_call_base_url = "https://chatgpt.com/backend-api/codex"

[features]
multi_agent = true
'@

try {
  [System.IO.File]::WriteAllText($config, $original, [System.Text.UTF8Encoding]::new($false))
  & powershell -NoProfile -ExecutionPolicy Bypass -File $installer -ConfigPath $config -SetHighDefault
  if ($LASTEXITCODE -ne 0) { throw "installer exited $LASTEXITCODE" }

  $patched = [System.IO.File]::ReadAllText($config)
  $required = @(
    'model = "chatgpt-web/high"',
    'openai_base_url = "http://127.0.0.1:17841/v1"',
    'model_provider = "codex_web_gpt"',
    '[model_providers.codex_web_gpt]',
    'base_url = "http://localhost:17841/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'supports_websockets = false',
    '[features]',
    'multi_agent = true'
  )
  foreach ($item in $required) { if (-not $patched.Contains($item)) { throw "missing expected config: $item" } }

  & powershell -NoProfile -ExecutionPolicy Bypass -File $installer -ConfigPath $config -SetHighDefault
  if ($LASTEXITCODE -ne 0) { throw "second installer exited $LASTEXITCODE" }
  $second = [System.IO.File]::ReadAllText($config)
  if (([regex]::Matches($second, "\[model_providers\.codex_web_gpt\]")).Count -ne 1) { throw "provider table duplicated" }
  if (([regex]::Matches($second, "(?m)^\s*model_provider\s*=")).Count -ne 1) { throw "model_provider duplicated" }
  if (-not $second.Contains('openai_base_url = "http://127.0.0.1:17841/v1"')) { throw "managed route changed" }

  Write-Host "PENRIX_WINDOWS_DESKTOP_PROVIDER_TEST_OK"
}
finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}