param(
  [string]$ConfigPath = "",
  [switch]$SetHighDefault,
  [switch]$Restore
)

$ErrorActionPreference = "Stop"

function Resolve-CodexConfigPath([string]$Explicit) {
  if ($Explicit) { return [System.IO.Path]::GetFullPath($Explicit) }
  if ($env:CODEX_HOME) { return Join-Path ([System.IO.Path]::GetFullPath($env:CODEX_HOME)) "config.toml" }
  return Join-Path $HOME ".codex\config.toml"
}

function Find-TopLevelIndex([string[]]$Lines, [string]$Key) {
  $firstTable = $Lines.Count
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    if ($Lines[$i] -match "^\s*\[") { $firstTable = $i; break }
  }
  $pattern = "^\s*" + [regex]::Escape($Key) + "\s*="
  $found = @()
  for ($i = 0; $i -lt $firstTable; $i++) { if ($Lines[$i] -match $pattern) { $found += $i } }
  if ($found.Count -gt 1) { throw "Duplicate top-level $Key assignments in $ConfigPath" }
  if ($found.Count -eq 0) { return -1 }
  return $found[0]
}

function First-TableIndex([string[]]$Lines) {
  for ($i = 0; $i -lt $Lines.Count; $i++) { if ($Lines[$i] -match "^\s*\[") { return $i } }
  return $Lines.Count
}

function Set-TopLevel([System.Collections.Generic.List[string]]$Lines, [string]$Key, [string]$ValueLine) {
  $index = Find-TopLevelIndex $Lines.ToArray() $Key
  if ($index -ge 0) { $Lines[$index] = $ValueLine; return }
  $Lines.Insert((First-TableIndex $Lines.ToArray()), $ValueLine)
}

function Remove-ProviderBlock([System.Collections.Generic.List[string]]$Lines) {
  $header = "[model_providers.codex_web_gpt]"
  $start = -1
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    if ($Lines[$i].Trim() -eq $header) {
      if ($start -ge 0) { throw "Duplicate $header tables in $ConfigPath" }
      $start = $i
    }
  }
  if ($start -lt 0) { return }
  $end = $Lines.Count
  for ($i = $start + 1; $i -lt $Lines.Count; $i++) { if ($Lines[$i] -match "^\s*\[") { $end = $i; break } }
  for ($i = $end - 1; $i -ge $start; $i--) { $Lines.RemoveAt($i) }
}

$ConfigPath = Resolve-CodexConfigPath $ConfigPath

if ($Restore) {
  $dir = Split-Path $ConfigPath -Parent
  $leaf = Split-Path $ConfigPath -Leaf
  $backup = Get-ChildItem -LiteralPath $dir -Filter ($leaf + ".penrix-desktop-provider-backup-*") | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $backup) { throw "No Penrix backup found for $ConfigPath" }
  Copy-Item -LiteralPath $backup.FullName -Destination $ConfigPath -Force
  Write-Host "Restored: $($backup.FullName)"
  Write-Host "Fully quit Codex Desktop including background codex.exe, then reopen it."
  exit 0
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Codex config not found: $ConfigPath. Run Codex Web GPT Install into Codex first."
}

$original = [System.IO.File]::ReadAllText($ConfigPath)
$lineEnding = if ($original.Contains([char]13 + [char]10)) { [char]13 + [char]10 } else { [char]10 }
$lines = [System.Collections.Generic.List[string]]::new()
foreach ($line in [regex]::Split($original, "\r\n|\n|\r")) { $lines.Add($line) }

$baseIndex = Find-TopLevelIndex $lines.ToArray() "openai_base_url"
if ($baseIndex -lt 0) { throw "openai_base_url is missing. Run Codex Web GPT Install into Codex first." }
$expectedBase = 'openai_base_url = "http://127.0.0.1:17841/v1"'
if ($lines[$baseIndex].Trim() -ne $expectedBase) {
  throw "Unexpected launcher route: $($lines[$baseIndex]). Expected $expectedBase"
}

$timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$backupPath = "$ConfigPath.penrix-desktop-provider-backup-$timestamp"
Copy-Item -LiteralPath $ConfigPath -Destination $backupPath

Set-TopLevel $lines "model_provider" 'model_provider = "codex_web_gpt"'
if ($SetHighDefault) { Set-TopLevel $lines "model" 'model = "chatgpt-web/high"' }
Remove-ProviderBlock $lines

if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -ne "") { $lines.Add("") }
$lines.Add("# Penrix Windows Desktop compatibility provider for upstream issue #452.")
$lines.Add("[model_providers.codex_web_gpt]")
$lines.Add('name = "Codex Web GPT local bridge"')
$lines.Add('base_url = "http://localhost:17841/v1"')
$lines.Add('wire_api = "responses"')
$lines.Add("requires_openai_auth = true")
$lines.Add("supports_websockets = false")

$patched = [string]::Join($lineEnding, $lines)
[System.IO.File]::WriteAllText($ConfigPath, $patched, [System.Text.UTF8Encoding]::new($false))

$check = [System.IO.File]::ReadAllText($ConfigPath)
$required = @(
  'openai_base_url = "http://127.0.0.1:17841/v1"',
  'model_provider = "codex_web_gpt"',
  '[model_providers.codex_web_gpt]',
  'base_url = "http://localhost:17841/v1"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'supports_websockets = false'
)
foreach ($item in $required) {
  if (-not $check.Contains($item)) {
    Copy-Item -LiteralPath $backupPath -Destination $ConfigPath -Force
    throw "Validation failed after write. Backup restored. Missing: $item"
  }
}

Write-Host "Penrix Windows Codex Desktop provider workaround installed."
Write-Host "Config: $ConfigPath"
Write-Host "Backup: $backupPath"
Write-Host "Keep the launcher open, fully quit Codex Desktop, reopen it, check chatgpt-web/*, then run chatgpt-web/high."