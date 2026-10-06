<#
.SYNOPSIS
  End-to-end smoke test against a running TwinLabs API. Exits non-zero on failure.
.EXAMPLE
  ./scripts/smoke.ps1 -Base http://localhost:5080
#>
param([string]$Base = 'http://localhost:5080')

$ErrorActionPreference = 'Stop'
$failures = 0
function Check([string]$name, [scriptblock]$test) {
  try { $r = & $test; Write-Host ("  PASS  {0} {1}" -f $name, $r) -ForegroundColor Green }
  catch { $script:failures++; Write-Host ("  FAIL  {0}: {1}" -f $name, $_.Exception.Message) -ForegroundColor Red }
}
function Api([string]$method, [string]$path, $body) {
  $req = @{ Method = $method; Uri = "$Base/api$path"; ContentType = 'application/json' }
  if ($null -ne $body) { $req.Body = ($body | ConvertTo-Json -Depth 8 -Compress) }
  Invoke-RestMethod @req
}

Write-Host "TwinLabs smoke test -> $Base"
Check 'health'      { $h = Api GET '/health'; if ($h.status -ne 'ok') { throw $h }; "v$($h.version)" }
Check 'plant'       { $p = Api GET '/plant'; if ($p.assets.Count -lt 2) { throw 'no assets' }; "$($p.assets.Count) assets, $($p.sensors.Count) sensors" }
Check 'start'       { $s = Api POST '/sim/start'; if ($s.state -ne 'running') { throw $s.state }; $s.state }
Check 'speed x50'   { $s = Api POST '/sim/speed' @{ speed = 50 }; if ($s.speed -ne 50) { throw $s.speed }; "x$($s.speed)" }
Start-Sleep -Seconds 3
Check 'state'       { $st = Api GET '/state'; if ($st.sim.simTimeMs -le 0) { throw 'clock not moving' }; "t=$([math]::Round($st.sim.simTimeMs/1000))s parts=$($st.parts.Count)" }
Check 'kpi'         { $k = Api GET '/kpi'; "OEE=$([math]::Round($k.line.oee,3)) thr=$([math]::Round($k.line.throughputPerHour,1))/h bottleneck=$($k.line.bottleneckAssetId)" }
Check 'history'     { $h = Api GET '/history/CNC-01.temp?seconds=600'; if ($h.t.Count -lt 1) { throw 'empty' }; "$($h.t.Count) pts" }
Check 'params'      { $a = Api PATCH '/assets/BUF-01/params' @{ params = @{ capacity = 12 } }; if ($a.params.capacity -ne 12) { throw 'not applied' }; 'BUF-01 capacity=12' }
Check 'params 404'  { try { Api PATCH '/assets/NOPE/params' @{ params = @{ capacity = 1 } } | Out-Null; throw 'expected 404' } catch { if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw } }; '404 ok' }
Check 'fault'       { $a = Api POST '/assets/CNC-02/fault' @{ durationS = 120 }; if ($a.state -ne 'fault') { throw $a.state }; 'CNC-02 fault' }
Check 'alarms'      { Start-Sleep -Milliseconds 1500; $al = Api GET '/alarms'; "$(@($al).Count) active" }
Check 'clear fault' { $a = Api DELETE '/assets/CNC-02/fault'; $a.state }
Check 'events'      { $e = Api GET '/events?limit=20'; "$(@($e).Count) events" }
Check 'what-if'     { $w = Api POST '/whatif' @{ durationS = 14400; overrides = @(@{ assetId = 'BUF-01'; params = @{ capacity = 30 } }) }; "thr $([math]::Round($w.baseline.line.throughputPerHour,1)) -> $([math]::Round($w.scenario.line.throughputPerHour,1)) in $($w.elapsedMs) ms" }
Check 'csv'         { $r = Invoke-WebRequest "$Base/api/export/csv?seconds=60" -UseBasicParsing; $first = ($r.Content -split "`n")[0]; if (-not $first.StartsWith('simTimeMs')) { throw $first }; "$(($r.Content -split "`n").Count) lines" }
Check 'websocket'   {
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  $uri = [Uri](($Base.TrimEnd('/') -replace '^http', 'ws') + '/ws')
  if (-not $ws.ConnectAsync($uri, [Threading.CancellationToken]::None).Wait(5000)) { throw "connect timeout $uri" }
  $types = @{}
  $buf = [byte[]]::new(1MB)
  $deadline = (Get-Date).AddSeconds(4)
  while ((Get-Date) -lt $deadline -and $types.Count -lt 3) {
    $sb = [Text.StringBuilder]::new()
    do {
      $seg = [ArraySegment[byte]]::new($buf)
      $res = $ws.ReceiveAsync($seg, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $res.Count))
    } while (-not $res.EndOfMessage)
    $msg = $sb.ToString() | ConvertFrom-Json
    $types[$msg.type] = 1 + [int]$types[$msg.type]
  }
  $ws.Dispose()
  foreach ($t in 'snapshot', 'tick', 'kpi') { if (-not $types.ContainsKey($t)) { throw "no '$t' frame (got $($types.Keys -join ','))" } }
  ($types.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' '
}
Api POST '/sim/speed' @{ speed = 1 } | Out-Null

if ($failures) { Write-Host "$failures check(s) failed" -ForegroundColor Red; exit 1 }
Write-Host 'All checks passed' -ForegroundColor Green
