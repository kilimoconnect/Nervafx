$ErrorActionPreference = 'Stop'
$pd = 0.01

$h1  = ConvertFrom-Json (Get-Content -Raw scratch/usdjpy-h1.json)
$m15 = ConvertFrom-Json (Get-Content -Raw scratch/usdjpy-m15-wide.json)

$windowStart = [datetime]::Parse('2026-07-05T22:00:00Z').ToUniversalTime()
$windowEnd   = [datetime]::Parse('2026-07-06T07:00:00Z').ToUniversalTime()

$windowH1 = @($h1 | Where-Object {
  $t = ([datetime]::Parse($_.time)).ToUniversalTime()
  $t -ge $windowStart -and $t -lt $windowEnd
} | Sort-Object time)

foreach ($threshold in @(4, 3)) {
  Write-Host ''
  Write-Host ('=== H1 Clean Break — requires >= {0} of 4 M15s aligned ===' -f $threshold)
  $hits = 0
  foreach ($c in $windowH1) {
    $t = ([datetime]::Parse($c.time)).ToUniversalTime()
    $prev = $h1 | Where-Object {
      $pt = ([datetime]::Parse($_.time)).ToUniversalTime()
      $pt -lt $t
    } | Sort-Object time -Descending | Select-Object -First 1
    if (-not $prev) { continue }

    $cClose = [double]$c.close
    $pHigh  = [double]$prev.high
    $pLow   = [double]$prev.low
    $dir = $null; $lvl = 0
    if ($cClose -gt $pHigh)     { $dir = 'BUY';  $lvl = $pHigh }
    elseif ($cClose -lt $pLow)  { $dir = 'SELL'; $lvl = $pLow  }
    if (-not $dir) { continue }

    $insideM15 = @($m15 | Where-Object {
      $mt = ([datetime]::Parse($_.time)).ToUniversalTime()
      $mt -ge $t -and $mt -lt $t.AddHours(1)
    } | Sort-Object time)
    if ($insideM15.Count -ne 4) { continue }

    $alignCount = 0
    foreach ($mm in $insideM15) {
      $mo = [double]$mm.open; $mc = [double]$mm.close
      if ($dir -eq 'BUY'  -and $mc -gt $mo) { $alignCount++ }
      if ($dir -eq 'SELL' -and $mc -lt $mo) { $alignCount++ }
    }

    if ($alignCount -ge $threshold) {
      $brk = ($cClose - $lvl) / $pd
      if ($dir -eq 'SELL') { $brk = ($lvl - $cClose) / $pd }
      $line = ('  HIT {0} {1} aligned={2}/4 break={3:F1}p body {4:F1}p range {5:F1}p' -f $t.ToString('MM-dd HH:mm'), $dir, $alignCount, $brk,
        (([double]$c.close - [double]$c.open) / $pd),
        (([double]$c.high  - [double]$c.low ) / $pd))
      Write-Host $line
      $hits++
    }
  }
  Write-Host ('Total hits at >= {0}: {1}' -f $threshold, $hits)
}
