<#
PAI Installed Hotfix Updater

Fetches a PAI release bundle, reads hotfix-manifest.json, and overlays only the
managed files listed there into an existing framework install. It intentionally
does not touch USER, MEMORY, settings.json, config.toml, auth, env files, or
hook trust state.
#>

[CmdletBinding()]
param(
  [string]$RepoUrl = "https://github.com/haydencj/Personal_AI_Infrastructure.git",
  [string]$Branch = "pai-codex-flawless-runtime",
  [string]$Framework = "",
  [string]$InstallRoot = "",
  [string]$AgentsSkillsRoot = "",
  [string]$SourceDir = "",
  [string]$ManifestPath = "",
  [switch]$DryRun,
  [switch]$NoPull,
  [switch]$KeepTemp
)

$ErrorActionPreference = "Stop"

function Info($Message) { Write-Host "  [INFO] $Message" -ForegroundColor Cyan }
function Success($Message) { Write-Host "  [OK] $Message" -ForegroundColor Green }
function Warn($Message) { Write-Host "  [WARN] $Message" -ForegroundColor Yellow }
function Fail($Message) { Write-Host "  [ERROR] $Message" -ForegroundColor Red }

function Resolve-AbsolutePath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Path))
}

$EffectiveHome = if ($env:HOME) { Resolve-AbsolutePath $env:HOME } else { Resolve-AbsolutePath $HOME }

function Read-FrameworkState {
  $statePath = Join-Path $EffectiveHome ".pai\framework.json"
  if (-not (Test-Path -LiteralPath $statePath)) { return $null }
  try {
    return Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  } catch {
    Warn "Could not read ${statePath}: $($_.Exception.Message)"
    return $null
  }
}

function Read-FrameworkStateAt([string]$DataDir) {
  $statePath = Join-Path $DataDir "framework.json"
  if (-not (Test-Path -LiteralPath $statePath)) { return $null }
  try {
    return Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  } catch {
    Warn "Could not read ${statePath}: $($_.Exception.Message)"
    return $null
  }
}

function Test-FrameworkStateUsable($State) {
  if (-not $State) { return $false }
  if ($State.root) {
    $root = Resolve-AbsolutePath $State.root
    if (-not (Test-Path -LiteralPath $root)) { return $false }
  }
  return $true
}

function Test-StaleFrameworkEnvironment {
  if ($env:PAI_FRAMEWORK_DIR) {
    $frameworkRoot = Resolve-AbsolutePath $env:PAI_FRAMEWORK_DIR
    if (-not (Test-Path -LiteralPath $frameworkRoot)) { return $true }
  }
  if ($env:PAI_DIR) {
    $paiRoot = Resolve-AbsolutePath $env:PAI_DIR
    if (-not (Test-Path -LiteralPath $paiRoot)) { return $true }
  }
  return $false
}

function Resolve-PaiDataDir {
  $defaultDataDir = Join-Path $EffectiveHome ".pai"
  $state = Read-FrameworkState
  if ($env:PAI_DATA_DIR) {
    $envDataDir = Resolve-AbsolutePath $env:PAI_DATA_DIR
    if (Test-Path -LiteralPath $envDataDir) {
      $envState = Read-FrameworkStateAt $envDataDir
      if ((-not $envState) -and ((-not (Test-FrameworkStateUsable $state)) -or (-not (Test-StaleFrameworkEnvironment)))) {
        return $envDataDir
      }
      if (Test-FrameworkStateUsable $envState) {
        return $envDataDir
      }
    }
  }

  if ((Test-FrameworkStateUsable $state) -and $state.dataDir) {
    return (Resolve-AbsolutePath $state.dataDir)
  }

  return $defaultDataDir
}

function Resolve-PaiConfigDir {
  if ($env:PAI_CONFIG_DIR) {
    $envConfigDir = Resolve-AbsolutePath $env:PAI_CONFIG_DIR
    if (Test-Path -LiteralPath $envConfigDir) { return $envConfigDir }
  }
  return (Join-Path $EffectiveHome ".config\PAI")
}

function Set-PaiUserEnvironment([string]$InstallRoot, [string]$Framework) {
  $dataDir = Resolve-PaiDataDir
  $paiDir = Join-Path $InstallRoot "PAI"
  $configDir = Resolve-PaiConfigDir

  $values = @{
    PAI_DIR = $paiDir
    PAI_FRAMEWORK_DIR = $InstallRoot
    PAI_FRAMEWORK = $Framework
    PAI_DATA_DIR = $dataDir
    PAI_CONFIG_DIR = $configDir
  }

  foreach ($key in $values.Keys) {
    Set-Item -Path "Env:$key" -Value $values[$key]
  }

  if ($env:PAI_SKIP_USER_ENV_UPDATE -eq "1") {
    Info "Skipped Windows user environment update by request."
    return
  }

  $target = if ($env:PAI_USER_ENV_TARGET -eq "Process") { "Process" } else { "User" }
  foreach ($key in $values.Keys) {
    [Environment]::SetEnvironmentVariable($key, $values[$key], $target)
  }
  if ($target -eq "User") {
    try {
      Add-Type -Namespace Pai.Native -Name User32 -MemberDefinition @"
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
"@ -ErrorAction SilentlyContinue
      $result = [UIntPtr]::Zero
      [Pai.Native.User32]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result) | Out-Null
      Info "Broadcast Windows environment change for new terminals."
    } catch {
      Warn "Could not broadcast Windows environment change: $($_.Exception.Message)"
    }
  }
  Success "Updated PAI environment variables at ${target} scope."
}

function Normalize-Framework([string]$Value) {
  $v = ($Value | ForEach-Object { "$_".Trim().ToLowerInvariant() }) -replace "[\s_-]+", ""
  switch ($v) {
    "claude" { return "claude" }
    "claudecode" { return "claude" }
    "codex" { return "codex" }
    "openai" { return "codex" }
    "openaicodex" { return "codex" }
    "opencode" { return "opencode" }
    default { return "" }
  }
}

function Resolve-Target {
  $state = Read-FrameworkState
  $fw = Normalize-Framework $Framework
  if (-not $fw -and $env:PAI_FRAMEWORK) { $fw = Normalize-Framework $env:PAI_FRAMEWORK }
  if (-not $fw -and $state -and $state.active) { $fw = Normalize-Framework $state.active }
  if (-not $fw) {
    if ($env:CODEX_HOME -or (Test-Path -LiteralPath (Join-Path $EffectiveHome ".codex"))) { $fw = "codex" }
    elseif ($env:CLAUDE_HOME -or (Test-Path -LiteralPath (Join-Path $EffectiveHome ".claude"))) { $fw = "claude" }
    elseif ($env:OPENCODE_CONFIG_DIR -or (Test-Path -LiteralPath (Join-Path $EffectiveHome ".config\opencode"))) { $fw = "opencode" }
  }
  if (-not $fw) { throw "Could not determine framework. Pass -Framework codex|claude|opencode." }

  $root = $InstallRoot
  if (-not $root -and $state -and $state.active -and (Normalize-Framework $state.active) -eq $fw -and $state.root) {
    $root = $state.root
  }
  if (-not $root) {
    switch ($fw) {
      "codex" { $root = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $EffectiveHome ".codex" } }
      "claude" { $root = if ($env:CLAUDE_HOME) { $env:CLAUDE_HOME } else { Join-Path $EffectiveHome ".claude" } }
      "opencode" { $root = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $EffectiveHome ".config\opencode" } }
    }
  }

  $root = Resolve-AbsolutePath $root
  if (-not (Test-Path -LiteralPath $root)) { throw "Install root does not exist: $root" }
  return [pscustomobject]@{ Framework = $fw; Root = $root }
}

function Resolve-ReleaseRoot([string]$Path) {
  $pathAbs = Resolve-AbsolutePath $Path
  if ((Test-Path -LiteralPath (Join-Path $pathAbs "CLAUDE.md")) -and (Test-Path -LiteralPath (Join-Path $pathAbs "PAI"))) {
    return $pathAbs
  }
  $candidate = Join-Path $pathAbs "Releases\v5.0.0\.claude"
  if ((Test-Path -LiteralPath (Join-Path $candidate "CLAUDE.md")) -and (Test-Path -LiteralPath (Join-Path $candidate "PAI"))) {
    return (Resolve-AbsolutePath $candidate)
  }
  throw "Could not locate release root under $pathAbs"
}

function Get-ReleaseRoot {
  if ($SourceDir) {
    $sourceAbs = Resolve-AbsolutePath $SourceDir
    Info "Using local source: $sourceAbs"
    if (-not $NoPull -and (Test-Path -LiteralPath (Join-Path $sourceAbs ".git"))) {
      if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "Git is required to update local source. Install Git or pass -NoPull."
      }
      Info "Updating local source with git fetch + pull --ff-only"
      git -C $sourceAbs fetch --prune | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
      git -C $sourceAbs pull --ff-only | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed" }
    }
    return [pscustomobject]@{ Root = Resolve-ReleaseRoot $sourceAbs; Temp = "" }
  }

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is required for fetching hotfixes. Install Git or pass -SourceDir."
  }

  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pai-hotfix-" + [guid]::NewGuid().ToString("N"))
  Info "Fetching $RepoUrl ($Branch) into $tempRoot"
  git clone --depth 1 --branch $Branch $RepoUrl $tempRoot | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
  return [pscustomobject]@{ Root = Resolve-ReleaseRoot $tempRoot; Temp = $tempRoot }
}

function Convert-InstructionContent([string]$Text, [string]$Framework) {
  if ($Framework -eq "claude") { return $Text }
  $name = if ($Framework -eq "codex") { "Codex" } else { "OpenCode" }
  $converted = $Text `
    -replace "\bCLAUDE\.md\b", "AGENTS.md" `
    -replace "\bClaude Code\b", $name `
    -replace "~\/\.claude\/PAI", '$PAI_DIR' `
    -replace "~\/\.claude", '$PAI_FRAMEWORK_DIR' `
    -replace "\$PAI_FRAMEWORK_DIR\/PAI", '$PAI_DIR'
  return ($converted -replace "(?m)^#\s*AGENTS\.md\b.*$", "# AGENTS.md")
}

function Copy-DirectoryContents([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  }
  foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
    $target = Join-Path $Destination $item.Name
    Copy-Item -LiteralPath $item.FullName -Destination $target -Recurse -Force
  }
}

function Get-BackupRelativePath([string]$InstallRoot, [string]$Path) {
  $rootFull = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\", "/")
  $pathFull = [System.IO.Path]::GetFullPath($Path)
  $comparison = [System.StringComparison]::OrdinalIgnoreCase

  if ([string]::Equals($rootFull, $pathFull.TrimEnd("\", "/"), $comparison)) {
    return (Split-Path -Leaf $pathFull)
  }

  $rootPrefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
  if ($pathFull.StartsWith($rootPrefix, $comparison)) {
    return $pathFull.Substring($rootPrefix.Length)
  }

  return ($pathFull -replace "[:\\\/]+", "_")
}

function Backup-Existing([string]$InstallRoot, [string]$Path, [string]$BackupRoot) {
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  $relative = Get-BackupRelativePath $InstallRoot $Path
  $backupPath = Join-Path $BackupRoot $relative
  $backupDir = Split-Path -Parent $backupPath
  if ($backupDir) { New-Item -ItemType Directory -Force -Path $backupDir | Out-Null }
  Copy-Item -LiteralPath $Path -Destination $backupPath -Recurse -Force
  return $backupPath
}

function Get-EntryTarget($Entry, [string]$Framework) {
  if ($Entry.targets) {
    $value = $Entry.targets.$Framework
    if (-not $value) { return "" }
    return "$value"
  }
  if ($Entry.target) { return "$($Entry.target)" }
  return "$($Entry.source)"
}

function Apply-Entry($Entry, [string]$ReleaseRoot, [string]$InstallRoot, [string]$Framework, [string]$BackupRoot) {
  $sourceRel = "$($Entry.source)" -replace "/", "\"
  $source = Join-Path $ReleaseRoot $sourceRel
  $targetRel = Get-EntryTarget $Entry $Framework
  if (-not $targetRel) { return [pscustomobject]@{ Status = "skipped"; Detail = "No target for $Framework"; Target = "" } }
  $targetRel = $targetRel -replace "/", "\"
  $target = Join-Path $InstallRoot $targetRel

  if (-not (Test-Path -LiteralPath $source)) {
    throw "Manifest source missing: $source"
  }

  if ($DryRun) {
    return [pscustomobject]@{ Status = "dry-run"; Detail = "$sourceRel -> $targetRel"; Target = $target }
  }

  $backup = Backup-Existing $InstallRoot $target $BackupRoot
  $parent = Split-Path -Parent $target
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

  $sourceItem = Get-Item -LiteralPath $source -Force
  if ($sourceItem.PSIsContainer) {
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force
    }
    Copy-DirectoryContents $source $target
  } elseif ($Entry.transformInstructions) {
    $text = Get-Content -Raw -LiteralPath $source
    $text = Convert-InstructionContent $text $Framework
    Set-Content -LiteralPath $target -Value $text -NoNewline
  } else {
    Copy-Item -LiteralPath $source -Destination $target -Force
  }

  if ($Framework -eq "codex" -and $Entry.mirrorToCodexAgentsSkills -and $targetRel.StartsWith("skills\")) {
    $skillName = Split-Path -Leaf $targetRel
    $agentsSkillRoot = if ($AgentsSkillsRoot) { Resolve-AbsolutePath $AgentsSkillsRoot } else { Join-Path $EffectiveHome ".agents\skills" }
    $agentsTarget = Join-Path $agentsSkillRoot $skillName
    Backup-Existing $InstallRoot $agentsTarget $BackupRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $agentsSkillRoot | Out-Null
    if (Test-Path -LiteralPath $agentsTarget) {
      Remove-Item -LiteralPath $agentsTarget -Recurse -Force
    }
    Copy-DirectoryContents $source $agentsTarget
  }

  $detail = if ($backup) { "backup: $backup" } else { "new file/dir" }
  return [pscustomobject]@{ Status = "updated"; Detail = $detail; Target = $target }
}

function Verify-Install([string]$InstallRoot, [string]$Framework) {
  $paiDir = Join-Path $InstallRoot "PAI"
  $latestPath = Join-Path $paiDir "ALGORITHM\LATEST"
  if (Test-Path -LiteralPath $latestPath) {
    $latest = (Get-Content -Raw -LiteralPath $latestPath).Trim()
    $normalized = if ($latest.StartsWith("v")) { $latest } else { "v$latest" }
    $algoPath = Join-Path $paiDir "ALGORITHM\$normalized.md"
    if (-not (Test-Path -LiteralPath $algoPath)) { throw "Algorithm path does not resolve: $algoPath" }
    Success "Algorithm path resolves: $algoPath"
  }

  $instruction = if ($Framework -eq "claude") { Join-Path $InstallRoot "CLAUDE.md" } else { Join-Path $InstallRoot "AGENTS.md" }
  if (Test-Path -LiteralPath $instruction) {
    $text = Get-Content -Raw -LiteralPath $instruction
    if ($text -notmatch '\$PAI_DIR/ALGORITHM/LATEST') {
      if ($Framework -eq "codex") {
        throw "Instruction file does not mention `$PAI_DIR/ALGORITHM/LATEST: $instruction"
      }
      Warn "Instruction file does not mention `$PAI_DIR/ALGORITHM/LATEST: $instruction"
    } else {
      Success "Instruction file points at `$PAI_DIR/ALGORITHM/LATEST."
    }
  }
}

function Regenerate-CodexHooksJson([string]$InstallRoot, [string]$BackupRoot) {
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "Bun is required to regenerate Codex hooks.json after hotfix update."
  }

  $scriptPath = Join-Path $BackupRoot "regenerate-codex-hooks.ts"
  $script = @'
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const dataDir = process.argv[3];
const configDir = process.argv[4];

if (!root || !dataDir || !configDir) {
  console.error("Usage: regenerate-codex-hooks.ts <install-root> <data-dir> <config-dir>");
  process.exit(1);
}

const { generateCodexHooksJson } = await import(pathToFileURL(join(root, "PAI", "PAI-Install", "engine", "config-gen.ts")).href);
const config = {
  framework: "codex",
  principalName: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  aiName: "PAI",
  catchphrase: "",
  paiDir: root,
  configDir,
  dataDir,
};

await Bun.write(join(root, "hooks.json"), `${JSON.stringify(generateCodexHooksJson(config), null, 2)}\n`);
'@
  Set-Content -LiteralPath $scriptPath -Value $script -NoNewline

  $dataDir = Resolve-PaiDataDir
  $configDir = Resolve-PaiConfigDir

  Push-Location $InstallRoot
  try {
    & bun $scriptPath $InstallRoot $dataDir $configDir | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Codex hooks.json regeneration failed" }
  } finally {
    Pop-Location
  }
  Success "Regenerated Codex hooks.json from installed generator."
}

function Get-PowerShellProfileCandidates {
  $items = @()
  if ($env:PAI_POWERSHELL_PROFILE) { $items += (Resolve-AbsolutePath $env:PAI_POWERSHELL_PROFILE) }
  if ($env:OneDrive) {
    $items += (Join-Path $env:OneDrive "Documents\PowerShell\profile.ps1")
    $items += (Join-Path $env:OneDrive "Documents\PowerShell\Microsoft.PowerShell_profile.ps1")
    $items += (Join-Path $env:OneDrive "Documents\WindowsPowerShell\profile.ps1")
    $items += (Join-Path $env:OneDrive "Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1")
  }
  $items += (Join-Path $EffectiveHome "Documents\PowerShell\profile.ps1")
  $items += (Join-Path $EffectiveHome "Documents\PowerShell\Microsoft.PowerShell_profile.ps1")
  $items += (Join-Path $EffectiveHome "Documents\WindowsPowerShell\profile.ps1")
  $items += (Join-Path $EffectiveHome "Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1")
  $items | Where-Object { $_ } | Select-Object -Unique
}

function Get-PaiPowerShellBlock([string]$InstallRoot, [string]$Framework) {
  $dataDir = Resolve-PaiDataDir
  $paiDir = Join-Path $InstallRoot "PAI"
  $configDir = Resolve-PaiConfigDir
  $paiScript = Join-Path $paiDir "TOOLS\pai.ts"
  $qData = $dataDir.Replace("'", "''")
  $qRoot = $InstallRoot.Replace("'", "''")
  $qPai = $paiDir.Replace("'", "''")
  $qFramework = $Framework.Replace("'", "''")
  $qConfig = $configDir.Replace("'", "''")
  $qScript = $paiScript.Replace("'", "''")
@"
# PAI aliases
function Initialize-PAIEnvironment {
  `$defaultPaiDataDir = '$qData'
  if (-not `$env:PAI_DATA_DIR -or -not (Test-Path -LiteralPath (Join-Path `$env:PAI_DATA_DIR 'framework.json'))) { `$env:PAI_DATA_DIR = `$defaultPaiDataDir }
  `$stateUsable = `$false
  `$statePath = Join-Path `$env:PAI_DATA_DIR 'framework.json'
  if (Test-Path -LiteralPath `$statePath) {
    try {
      `$state = Get-Content -Raw -LiteralPath `$statePath | ConvertFrom-Json
      if (`$state.root) {
        `$stateRoot = [string]`$state.root
        if (Test-Path -LiteralPath `$stateRoot) {
          `$env:PAI_FRAMEWORK_DIR = `$stateRoot
          `$env:PAI_DIR = Join-Path `$env:PAI_FRAMEWORK_DIR 'PAI'
          `$stateUsable = `$true
        }
      }
      if (`$state.active) { `$env:PAI_FRAMEWORK = [string]`$state.active }
      if (`$state.dataDir -and `$stateUsable -and (Test-Path -LiteralPath ([string]`$state.dataDir))) { `$env:PAI_DATA_DIR = [string]`$state.dataDir }
    } catch {}
  }
  if (-not `$stateUsable -and (Test-Path -LiteralPath (Join-Path `$defaultPaiDataDir 'framework.json'))) { `$env:PAI_DATA_DIR = `$defaultPaiDataDir }
  if (-not `$env:PAI_FRAMEWORK_DIR -or -not (Test-Path -LiteralPath `$env:PAI_FRAMEWORK_DIR)) { `$env:PAI_FRAMEWORK_DIR = '$qRoot' }
  if (-not `$env:PAI_DIR -or -not (Test-Path -LiteralPath `$env:PAI_DIR)) { `$env:PAI_DIR = '$qPai' }
  if (-not `$env:PAI_FRAMEWORK) { `$env:PAI_FRAMEWORK = '$qFramework' }
  if (-not `$env:PAI_CONFIG_DIR -or -not (Test-Path -LiteralPath `$env:PAI_CONFIG_DIR)) { `$env:PAI_CONFIG_DIR = '$qConfig' }
}
Initialize-PAIEnvironment
function Invoke-PAI {
  Initialize-PAIEnvironment
  bun '$qScript' @args
}
function pai {
  Invoke-PAI @args
}
function k {
  Invoke-PAI @args
}
"@
}

function Repair-PowerShellProfiles([string]$InstallRoot, [string]$Framework, [string]$BackupRoot) {
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { return }
  $block = Get-PaiPowerShellBlock $InstallRoot $Framework
  foreach ($profilePath in Get-PowerShellProfileCandidates) {
    if ($DryRun) {
      Info "DRY RUN repair PowerShell profile $profilePath"
      continue
    }
    if (Test-Path -LiteralPath $profilePath) {
      Backup-Existing $InstallRoot $profilePath $BackupRoot | Out-Null
      $content = Get-Content -Raw -LiteralPath $profilePath
      $content = $content -replace "(?ms)^# PAI aliases.*?(?=^# |\z)", ""
      $content = $content -replace "(?ms)^function Initialize-PAIEnvironment \{.*?^function k \{.*?^\}", ""
      $content = $content.TrimEnd() + "`n`n$block`n"
      Set-Content -LiteralPath $profilePath -Value $content -NoNewline
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profilePath) | Out-Null
      Set-Content -LiteralPath $profilePath -Value ($block + "`n") -NoNewline
    }
    Success "Repaired PowerShell PAI bootstrap: $profilePath"
  }
}

Write-Host ""
Write-Host "PAI | Installed Hotfix Updater" -ForegroundColor Cyan
Write-Host ""

$target = Resolve-Target
Info "Framework: $($target.Framework)"
Info "Install root: $($target.Root)"

$fetched = Get-ReleaseRoot
$releaseRoot = $fetched.Root
Info "Release root: $releaseRoot"

try {
  $manifestFile = if ($ManifestPath) { Resolve-AbsolutePath $ManifestPath } else { Join-Path $releaseRoot "hotfix-manifest.json" }
  if (-not (Test-Path -LiteralPath $manifestFile)) { throw "Manifest not found: $manifestFile" }
  $manifest = Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json
  Info "Manifest: $manifestFile"

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupRoot = Join-Path $EffectiveHome ".pai\BACKUPS\hotfix-$stamp"
  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    Info "Backups: $backupRoot"
  }

  $results = @()
  foreach ($entry in $manifest.entries) {
    $results += Apply-Entry $entry $releaseRoot $target.Root $target.Framework $backupRoot
  }

  foreach ($result in $results) {
    if ($result.Status -eq "updated") { Success "$($result.Target) ($($result.Detail))" }
    elseif ($result.Status -eq "dry-run") { Info "DRY RUN $($result.Detail)" }
    else { Warn "$($result.Status): $($result.Detail)" }
  }

  if (-not $DryRun) {
    if ($target.Framework -eq "codex") {
      Regenerate-CodexHooksJson $target.Root $backupRoot
    }
    Set-PaiUserEnvironment $target.Root $target.Framework
    Repair-PowerShellProfiles $target.Root $target.Framework $backupRoot
    Verify-Install $target.Root $target.Framework
    Success "Hotfix update complete. Restart the agent session so instructions reload."
  } else {
    Info "Dry run complete. No files changed."
  }
} finally {
  if ($fetched.Temp -and -not $KeepTemp) {
    $resolved = [System.IO.Path]::GetFullPath($fetched.Temp)
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolved.StartsWith($tempRoot) -and (Split-Path -Leaf $resolved).StartsWith("pai-hotfix-")) {
      Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
  } elseif ($fetched.Temp) {
    Info "Kept temp checkout: $($fetched.Temp)"
  }
}
