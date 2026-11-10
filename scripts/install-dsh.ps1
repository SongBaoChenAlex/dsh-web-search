<#
.SYNOPSIS
  Install the dsh-web-search plugins into a DeepSeek Harness (DSH) profile from this checkout.

.DESCRIPTION
  Runs `pnpm install` (third-party deps) and then `dsh plugin --profile <name> add ./packages/<pkg>`
  for every selected package. Re-running is safe: already-mounted plugins are reported and skipped.

.PARAMETER Profile
  DSH profile name (the directory under $DSH_HOME/profiles, default ~/.dsh/profiles). When omitted: uses the only
  existing profile, or lets you pick one when there are several.

.PARAMETER Packages
  Package directory names under ./packages to install. Default: the recommended set.
  Use -All to install every package.

.NOTES
  If PowerShell refuses to run this file ("not digitally signed" — typical after Download ZIP), either run
  scripts\install-dsh.cmd instead, or: powershell -ExecutionPolicy Bypass -File scripts\install-dsh.ps1

.EXAMPLE
  scripts\install-dsh.cmd
  pwsh scripts/install-dsh.ps1
  pwsh scripts/install-dsh.ps1 -All
  pwsh scripts/install-dsh.ps1 -Profile cli -Packages search-governor,search-http
#>
[CmdletBinding()]
param(
  [string]$Profile,
  [string[]]$Packages = @("search-governor", "search-http", "fetch-readability", "tavily-tools", "fetch-composite", "provider-selector"),
  [switch]$All,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

foreach ($tool in "pnpm", "dsh") {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Error "'$tool' not found on PATH. Install it first (pnpm: https://pnpm.io/installation, dsh: npm i -g @deepseek-ai/dsh)."
  }
}

# --- Pick the DSH profile: -Profile > the only existing profile > interactive choice > typed name ---
if (-not $Profile) {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
  $profilesDir = Join-Path $dshHome "profiles"
  $existing = @()
  if (Test-Path $profilesDir) {
    $existing = @(Get-ChildItem $profilesDir -Directory |
      Where-Object { $_.Name -ne "node_modules" -and $_.Name -ne "desktop" -and (Test-Path (Join-Path $_.FullName "package.json")) } |
      Select-Object -ExpandProperty Name)
  }
  if ($existing.Count -eq 1) {
    $Profile = $existing[0]
    Write-Host "Using the only DSH profile found: $Profile  ($profilesDir)" -ForegroundColor Yellow
  } elseif ($existing.Count -gt 1) {
    Write-Host "DSH profiles found in ${profilesDir}:" -ForegroundColor Yellow
    for ($i = 0; $i -lt $existing.Count; $i++) { Write-Host ("  [{0}] {1}" -f ($i + 1), $existing[$i]) }
    $default = if ($existing -contains "web") { "web" } else { $existing[0] }
    $answer = Read-Host "Install into which profile? (number or name, Enter = $default)"
    if (-not $answer) { $Profile = $default }
    elseif ($answer -match '^\d+$' -and [int]$answer -ge 1 -and [int]$answer -le $existing.Count) { $Profile = $existing[[int]$answer - 1] }
    else { $Profile = $answer }
  } else {
    Write-Host "No DSH profile found under $profilesDir." -ForegroundColor Yellow
    $answer = Read-Host "Profile name to create/use (Enter = web)"
    $Profile = if ($answer) { $answer } else { "web" }
  }
}
if ($Profile -ieq "desktop") { throw "profile 'desktop' is managed by the DSH Electron app; pick another profile" }
Write-Host "Target profile: $Profile" -ForegroundColor Cyan

if ($All) {
  $Packages = Get-ChildItem (Join-Path $root "packages") -Directory |
    Where-Object { $_.Name -ne "shared" -and (Test-Path (Join-Path $_.FullName "cordis.patch.yml")) } |
    Select-Object -ExpandProperty Name
}

if (-not $SkipInstall) {
  Write-Host "==> pnpm install" -ForegroundColor Cyan
  $env:CI = "true"
  pnpm install --prefer-offline
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
}

$ok = @(); $failed = @()
foreach ($name in $Packages) {
  $dir = Join-Path (Join-Path $root "packages") $name
  if (-not (Test-Path (Join-Path $dir "package.json"))) { Write-Warning "skip '$name': no such package"; continue }
  Write-Host "==> dsh plugin --profile $Profile add ./packages/$name" -ForegroundColor Cyan
  & dsh plugin --profile $Profile add "./packages/$name"
  if ($LASTEXITCODE -eq 0) { $ok += $name } else { $failed += $name }
}

Write-Host ""
Write-Host "Installed ($($ok.Count)): $($ok -join ', ')" -ForegroundColor Green
if ($failed.Count) { Write-Host "Failed ($($failed.Count)): $($failed -join ', ')" -ForegroundColor Red }
Write-Host ""
Write-Host "Next: restart DSH, open Settings > 'Web providers' in the Web GUI and enter your search API key (e.g. Tavily)."
Write-Host "Update later with: git pull; pwsh scripts/install-dsh.ps1 -SkipInstall   (or just 'pnpm install' — plugins are path-linked)."
if ($failed.Count) { exit 1 }
