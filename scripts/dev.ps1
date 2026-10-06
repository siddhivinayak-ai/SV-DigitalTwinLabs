<#
.SYNOPSIS
  Start the TwinLabs API (http://localhost:5080) and the Vite UI dev server (http://localhost:5173) together.
.EXAMPLE
  ./scripts/dev.ps1            # live server + UI
  ./scripts/dev.ps1 -Mock      # UI only, in-browser demo data
#>
param([switch]$Mock, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'

if (-not (Test-Path "$root/ui/node_modules")) {
  Write-Host '[dev] installing UI dependencies...' -ForegroundColor Cyan
  Push-Location "$root/ui"; npm ci; Pop-Location
}

$jobs = @()
if (-not $Mock) {
  Write-Host '[dev] starting API on http://localhost:5080' -ForegroundColor Cyan
  $jobs += Start-Process dotnet -ArgumentList 'run', '--project', "$root/server/src/TwinLabs.Api" -PassThru -NoNewWindow
}
Write-Host '[dev] starting UI on http://localhost:5173' -ForegroundColor Cyan
$jobs += Start-Process npm.cmd -ArgumentList 'run', 'dev' -WorkingDirectory "$root/ui" -PassThru -NoNewWindow

if (-not $NoBrowser) {
  Start-Sleep -Seconds 4
  $url = if ($Mock) { 'http://localhost:5173/?source=mock' } else { 'http://localhost:5173/' }
  Start-Process $url
}

Write-Host '[dev] running. Press Ctrl+C to stop.' -ForegroundColor Green
try { Wait-Process -Id ($jobs | ForEach-Object Id) }
finally {
  foreach ($j in $jobs) { if (-not $j.HasExited) { taskkill /PID $j.Id /T /F | Out-Null } }
}
