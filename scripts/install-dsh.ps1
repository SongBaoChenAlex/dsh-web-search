<#
.SYNOPSIS
  Install the dsh-web-search plugins into a DeepSeek Harness (DSH) profile from this checkout.

.DESCRIPTION
  Runs `pnpm install` (third-party deps) and then `dsh plugin --profile <name> add ./packages/<pkg>`
  for every selected package. Re-running is safe: already-mounted plugins are reported and skipped.

.PARAMETER Profile
  DSH profile name. Default: web.

.PARAMETER Packages
  Package directory names under ./packages to install. Default: the recommended set.
  Use -All to install every package.

.EXAMPLE
  pwsh scripts/install-dsh.ps1
  pwsh scripts/install-dsh.ps1 -All
  pwsh scripts/install-dsh.ps1 -Profile cli -Packages search-governor,search-http
#>
[CmdletBinding()]
param(
  [string]$Profile = "web",
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
  $dir = Join-Path $root "packages" $name
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
