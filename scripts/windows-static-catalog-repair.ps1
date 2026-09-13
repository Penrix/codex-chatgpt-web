param(
  [switch]$Undo,
  [string]$CodexPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string]$Message) {
  Write-Host "`n== $Message ==" -ForegroundColor Cyan
}

function Ensure-Property($Object, [string]$Name, $Value) {
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  } else {
    $property.Value = $Value
  }
}

function Remove-Property($Object, [string]$Name) {
  if ($null -ne $Object.PSObject.Properties[$Name]) {
    $Object.PSObject.Properties.Remove($Name)
  }
}

function Clone-Json($Value) {
  return ($Value | ConvertTo-Json -Depth 100 -Compress | ConvertFrom-Json -Depth 100)
}

function Find-CodexExecutable {
  if ($CodexPath) {
    $resolved = [System.IO.Path]::GetFullPath($CodexPath)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
      throw "Codex executable does not exist: $resolved"
    }
    return $resolved
  }

  $running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'codex.exe' -and $_.ExecutablePath } |
    Select-Object -First 1 -ExpandProperty ExecutablePath
  if ($running -and (Test-Path -LiteralPath $running -PathType Leaf)) {
    return $running
  }

  $root = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  if (Test-Path -LiteralPath $root -PathType Container) {
    $candidate = Get-ChildItem -LiteralPath $root -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending |
      Select-Object -First 1 -ExpandProperty FullName
    if ($candidate) { return $candidate }
  }

  $command = Get-Command codex.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and $command.Source) { return $command.Source }
  throw 'Could not locate Codex Desktop codex.exe. Start Codex Desktop once or pass -CodexPath.'
}

function Get-LineEnding([string]$Text) {
  if ($Text.Contains("`r`n")) { return "`r`n" }
  if ($Text.Contains("`r")) { return "`r" }
  return "`n"
}

function Toml-String([string]$Value) {
  return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Find-TopLevelAssignmentIndex([string[]]$Lines, [string]$Key) {
  $insideTable = $false
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    $trimmed = $Lines[$i].Trim()
    if ($trimmed -match '^\s*\[') { $insideTable = $true }
    if (-not $insideTable -and $trimmed -match ('^' + [regex]::Escape($Key) + '\s*=')) {
      return $i
    }
  }
  return -1
}

function First-TableIndex([string[]]$Lines) {
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    if ($Lines[$i].Trim() -match '^\s*\[') { return $i }
  }
  return $Lines.Count
}

$webHome = if ($env:CODEX_CHATGPT_WEB_HOME) {
  [System.IO.Path]::GetFullPath($env:CODEX_CHATGPT_WEB_HOME)
} else {
  Join-Path $HOME '.codex-chatgpt-web'
}
$codexHome = if ($env:CODEX_HOME) {
  [System.IO.Path]::GetFullPath($env:CODEX_HOME)
} else {
  Join-Path $HOME '.codex'
}
$configPath = Join-Path $codexHome 'config.toml'
$webConfigPath = Join-Path $webHome 'config.json'
$managedDir = Join-Path $webHome 'codex'
$catalogPath = Join-Path $managedDir 'windows-static-model-catalog.json'
$statePath = Join-Path $managedDir 'windows-static-catalog-repair.json'
$marker = '# Managed by codex-chatgpt-web Windows catalog compatibility probe.'

if ($Undo) {
  Write-Step 'Undo static catalog probe'
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    Write-Host 'No repair state exists; nothing to undo.'
    exit 0
  }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -Depth 20
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Codex config is missing: $configPath"
  }
  $text = Get-Content -LiteralPath $configPath -Raw
  $ending = Get-LineEnding $text
  $lines = @($text -split "`r`n|`n|`r", 0, 'SimpleMatch')
  # PowerShell's -split with SimpleMatch cannot express alternatives; fall back to regex if it did not split.
  if ($lines.Count -le 1) { $lines = @([regex]::Split($text, "\r\n|\n|\r")) }
  if ($lines.Count -gt 0 -and $lines[-1] -eq '' -and $text.EndsWith($ending)) {
    $lines = @($lines[0..($lines.Count - 2)])
    $trailing = $true
  } else {
    $trailing = $false
  }
  $index = Find-TopLevelAssignmentIndex $lines 'model_catalog_json'
  if ($index -lt 0) { throw 'Managed model_catalog_json assignment is missing; refusing to overwrite newer config.' }
  $expected = 'model_catalog_json = ' + (Toml-String $catalogPath)
  if ($lines[$index].Trim() -ne $expected) {
    throw 'model_catalog_json changed after the probe; refusing to overwrite the newer value.'
  }
  $newLines = [System.Collections.Generic.List[string]]::new()
  $newLines.AddRange([string[]]$lines)
  if ($state.previousPresent -eq $true) {
    $newLines[$index] = [string]$state.previousRawLine
  } else {
    $newLines.RemoveAt($index)
  }
  $markerIndex = $newLines.IndexOf($marker)
  if ($markerIndex -ge 0) { $newLines.RemoveAt($markerIndex) }
  $output = [string]::Join($ending, $newLines)
  if ($trailing) { $output += $ending }
  [System.IO.File]::WriteAllText($configPath, $output, [System.Text.UTF8Encoding]::new($false))
  Remove-Item -LiteralPath $catalogPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  Write-Host 'Restored the previous model_catalog_json setting. Restart Codex Desktop.' -ForegroundColor Green
  exit 0
}

Write-Step 'Locate Codex Desktop runtime'
$codex = Find-CodexExecutable
Write-Host "Codex: $codex"
$version = (& $codex --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Could not query Codex version: $version" }
Write-Host "Version: $version"

Write-Step 'Read Codex Web GPT configuration'
if (-not (Test-Path -LiteralPath $webConfigPath -PathType Leaf)) {
  throw "Codex Web GPT config is missing: $webConfigPath"
}
$web = Get-Content -LiteralPath $webConfigPath -Raw | ConvertFrom-Json -Depth 100
Write-Host "Mode: $($web.mode)"
Write-Host "Browser interaction: $($web.browserInteractionMode)"
Write-Host "Sol available: $($web.solAvailable)"
Write-Host "Pro available: $($web.proAvailable)"
Write-Host "Subagent protocol: $($web.subagentProtocol)"

Write-Step 'Read bundled Codex model catalog'
$bundledText = (& $codex debug models --bundled 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "codex debug models --bundled failed:`n$bundledText" }
try {
  $catalog = $bundledText | ConvertFrom-Json -Depth 100
} catch {
  throw "Codex did not return a JSON bundled model catalog: $($_.Exception.Message)"
}
if ($null -eq $catalog.models) { throw 'Bundled Codex model catalog is missing models.' }

$nativeModels = @()
foreach ($source in @($catalog.models)) {
  if (-not $source.slug -or ([string]$source.slug).StartsWith('chatgpt-web/')) { continue }
  $model = Clone-Json $source
  if ($web.subagentProtocol -eq 'compatibility-v1' -and $model.multi_agent_version -ne 'disabled') {
    Ensure-Property $model 'multi_agent_version' 'v1'
  }
  $nativeModels += $model
}
$template = $nativeModels |
  Where-Object { $_.visibility -eq 'list' -and $null -ne $_.supported_reasoning_levels } |
  Select-Object -First 1
if ($null -eq $template) { throw 'No list-visible native Codex model can be used as a Web model template.' }
Write-Host "Template: $($template.slug)"

$routes = @()
if ($web.browserInteractionMode -eq 'manual') {
  $routes += [pscustomobject]@{ slug='chatgpt-web/zero-risk'; name='ChatGPT Web — Zero Risk'; description='Zero Risk keeps model selection and prompt submission under your control while preserving the native Codex harness.'; effort='low'; adapter='low'; input=@('text'); pro=$false; backend='zero-risk' }
  if ($web.zeroRiskProEnabled -eq $true) {
    $routes += [pscustomobject]@{ slug='chatgpt-web/zero-risk-pro'; name='ChatGPT Web — Zero Risk Pro'; description='Explicit Pro-sized Zero Risk context; select ChatGPT Pro manually for every turn.'; effort='low'; adapter='low'; input=@('text'); pro=$true; backend='zero-risk-pro' }
  }
} elseif ($web.solAvailable -ne $true) {
  $routes += [pscustomobject]@{ slug='chatgpt-web/luna'; name='ChatGPT Web — Luna'; description='ChatGPT Web Luna for accounts without the Sol model selector.'; effort='low'; adapter='low'; input=@('text','image'); pro=$false; backend='luna' }
  $routes += [pscustomobject]@{ slug='chatgpt-web/think'; name='ChatGPT Web — Think'; description='ChatGPT Web Think for Luna-only accounts.'; effort='low'; adapter='medium'; input=@('text','image'); pro=$false; backend='luna' }
} else {
  $routes += [pscustomobject]@{ slug='chatgpt-web/light'; name='ChatGPT Web — Instant'; description='ChatGPT Web Instant through the native Codex harness.'; effort='low'; adapter='low'; input=@('text','image'); pro=$false; backend='sol' }
  $routes += [pscustomobject]@{ slug='chatgpt-web/medium'; name='ChatGPT Web — Medium'; description='ChatGPT Web Medium through the native Codex harness.'; effort='medium'; adapter='medium'; input=@('text','image'); pro=$false; backend='sol' }
  $routes += [pscustomobject]@{ slug='chatgpt-web/high'; name='ChatGPT Web — High'; description='ChatGPT Web High through the native Codex harness.'; effort='high'; adapter='high'; input=@('text','image'); pro=$false; backend='sol' }
  if ($web.proAvailable -eq $true) {
    $routes += [pscustomobject]@{ slug='chatgpt-web/extra-high'; name='ChatGPT Web — Extra High'; description='Account-gated ChatGPT Web Extra High through the native Codex harness.'; effort='xhigh'; adapter='xhigh'; input=@('text','image'); pro=$true; backend='sol' }
    $routes += [pscustomobject]@{ slug='chatgpt-web/pro'; name='ChatGPT Web — Pro'; description='Account-gated ChatGPT Pro through the native Codex harness.'; effort='ultra'; adapter='max'; input=@('text','image'); pro=$true; backend='sol' }
  }
}

function Get-Limits($Route, $WebConfig) {
  if ($Route.backend -eq 'zero-risk-pro') { return @(336579, 285000) }
  if ($Route.backend -eq 'zero-risk') { return @(123000, 96000) }
  if ($Route.backend -eq 'luna') { return @(1050000, 1050000) }

  if ($WebConfig.proAvailable -eq $true) {
    $window = if ($Route.adapter -eq 'max') { 112193 } else { 111193 }
    $compact = 95000
  } elseif ($Route.adapter -eq 'low') {
    $window = 41000
    $compact = 32000
  } else {
    $window = 90000
    $compact = 80000
  }
  if ($WebConfig.experimentalBiggerContext -eq $true) {
    $window *= 3
    $compact *= 3
  }
  return @($window, $compact)
}

$webModels = @()
foreach ($route in $routes) {
  $model = Clone-Json $template
  Ensure-Property $model 'slug' $route.slug
  Ensure-Property $model 'display_name' $route.name
  Ensure-Property $model 'description' $route.description
  Ensure-Property $model 'input_modalities' @($route.input)
  Ensure-Property $model 'visibility' 'list'
  Ensure-Property $model 'supported_in_api' $true

  if ($null -ne $template.priority) {
    $priority = [int64]$template.priority
    if ($web.subagentProtocol -eq 'compatibility-v1' -and $route.slug -eq 'chatgpt-web/light') { $priority += 1 }
    Ensure-Property $model 'priority' $priority
  }
  if ($web.subagentProtocol -eq 'compatibility-v1') {
    if ($template.multi_agent_version -ne 'disabled') { Ensure-Property $model 'multi_agent_version' 'v1' }
  } elseif ($null -ne $template.multi_agent_version) {
    Ensure-Property $model 'multi_agent_version' $template.multi_agent_version
  }

  Ensure-Property $model 'tool_mode' $null
  Ensure-Property $model 'upgrade' $null
  Ensure-Property $model 'default_reasoning_level' $route.effort
  $sourceLevel = @($template.supported_reasoning_levels | Where-Object { $_.effort -eq $route.effort } | Select-Object -First 1)
  if ($sourceLevel.Count -gt 0 -and $null -ne $sourceLevel[0]) {
    $level = Clone-Json $sourceLevel[0]
  } else {
    $level = [pscustomobject]@{}
  }
  Ensure-Property $level 'effort' $route.effort
  Ensure-Property $level 'description' $route.name
  Ensure-Property $model 'supported_reasoning_levels' @($level)

  $limits = Get-Limits $route $web
  $window = [int64]$limits[0]
  $compact = [int64]$limits[1]
  Ensure-Property $model 'context_window' $window
  Ensure-Property $model 'max_context_window' $window
  Ensure-Property $model 'effective_context_window_percent' ([math]::Round(($compact / $window) * 100))
  Ensure-Property $model 'auto_compact_token_limit' $compact
  Ensure-Property $model 'additional_speed_tiers' @()
  Ensure-Property $model 'service_tiers' @()
  Ensure-Property $model 'default_service_tier' $null
  Remove-Property $model 'comp_hash'
  Remove-Property $model 'availability_nux'
  $webModels += $model
}

$augmented = Clone-Json $catalog
Ensure-Property $augmented 'models' @($nativeModels + $webModels)
New-Item -ItemType Directory -Path $managedDir -Force | Out-Null
$catalogJson = $augmented | ConvertTo-Json -Depth 100 -Compress
[System.IO.File]::WriteAllText($catalogPath, $catalogJson + "`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "Catalog: $catalogPath"
Write-Host "Added models: $([string]::Join(', ', @($webModels.slug)))"

Write-Step 'Install static catalog override into Codex config'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "Codex config is missing: $configPath"
}
$text = Get-Content -LiteralPath $configPath -Raw
$ending = Get-LineEnding $text
$trailing = $text.EndsWith($ending)
$lines = @([regex]::Split($text, "\r\n|\n|\r"))
if ($trailing -and $lines.Count -gt 0 -and $lines[-1] -eq '') {
  $lines = @($lines[0..($lines.Count - 2)])
}
$index = Find-TopLevelAssignmentIndex $lines 'model_catalog_json'
$previousPresent = $index -ge 0
$previousRawLine = if ($previousPresent) { $lines[$index] } else { $null }
$managedLine = 'model_catalog_json = ' + (Toml-String $catalogPath)
$list = [System.Collections.Generic.List[string]]::new()
$list.AddRange([string[]]$lines)
if ($previousPresent) {
  $list[$index] = $managedLine
  if ($index -eq 0 -or $list[$index - 1] -ne $marker) { $list.Insert($index, $marker) }
} else {
  $insert = First-TableIndex $list.ToArray()
  $list.Insert($insert, $managedLine)
  $list.Insert($insert, $marker)
}
$output = [string]::Join($ending, $list)
if ($trailing) { $output += $ending }

$state = [ordered]@{
  version = 1
  createdAt = [DateTime]::UtcNow.ToString('o')
  configPath = $configPath
  catalogPath = $catalogPath
  previousPresent = $previousPresent
  previousRawLine = $previousRawLine
  codexExecutable = $codex
  codexVersion = $version
}
[System.IO.File]::WriteAllText($statePath, (($state | ConvertTo-Json -Depth 20) + "`n"), [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($configPath, $output, [System.Text.UTF8Encoding]::new($false))

Write-Step 'Done'
Write-Host 'Static Web model catalog installed.' -ForegroundColor Green
Write-Host 'Fully quit Codex Desktop and reopen it. Keep Codex Web GPT running.'
Write-Host "To undo later: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Undo"
