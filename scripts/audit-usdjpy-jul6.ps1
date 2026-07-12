$ErrorActionPreference = 'Stop'

$h1 = ConvertFrom-Json (Get-Content -Raw scratch/usdjpy-h1.json)
$m15 = ConvertFrom-Json (Get-Content -Raw scratch/usdjpy-m15.json)
Write-Host "H1 candles fetched: $($h1.Count)"
Write-Host "M15 candles fetched: $($m15.Count)"

# JPY pair — pip = 0.01
$pd = 0.01

# ── Window of interest: 5 Jul 22:00 UTC -> 6 Jul 07:00 UTC ─────────────────
$windowStart = [datetime]::Parse('2026-07-05T22:00:00Z').ToUniversalTime()
$windowEnd   = [datetime]::Parse('2026-07-06T07:00:00Z').ToUniversalTime()

Write-Host ""
Write-Host "=== USD/JPY H1 candles in window (5 Jul 22:00 -> 6 Jul 07:00 UTC) ==="
$windowH1 = $h1 | Where-Object {
  $t = ([datetime]::Parse($_.time)).ToUniversalTime()
  $t -ge $windowStart -and $t -lt $windowEnd
} | Sort-Object time

$windowH1 | ForEach-Object {
  $t = ([datetime]::Parse($_.time)).ToUniversalTime()
  $tStr = $t.ToString('MM-dd HH:mm')
  $body = ([double]$_.close - [double]$_.open) / $pd
  $range = ([double]$_.high - [double]$_.low) / $pd
  $dir = if ($body -gt 0) { 'BULL' } else { 'BEAR' }
  Write-Host ("  {0}  O={1:F3}  H={2:F3}  L={3:F3}  C={4:F3}  body={5:F1}p  range={6:F1}p  {7}" -f `
    $tStr, [double]$_.open, [double]$_.high, [double]$_.low, [double]$_.close, $body, $range, $dir)
}

$overallOpen = [double]$windowH1[0].open
$overallClose = [double]$windowH1[-1].close
$overallMove = ($overallClose - $overallOpen) / $pd
Write-Host ""
Write-Host ("Window move: open {0:F3} -> close {1:F3}   ({2:F1} pips)" -f $overallOpen, $overallClose, $overallMove)

# ── Engine 1: H1 CLEAN BREAK ────────────────────────────────────────────────
Write-Host ""
Write-Host "=== ENGINE: H1 CLEAN BREAK ==="
Write-Host "Fires when H1 closes past prev H1 high/low AND all 4 M15s inside align."

$hits = 0
foreach ($c in $windowH1) {
  $t = ([datetime]::Parse($c.time)).ToUniversalTime()
  # Find prev H1
  $prev = $h1 | Where-Object {
    $pt = ([datetime]::Parse($_.time)).ToUniversalTime()
    $pt -lt $t
  } | Sort-Object time -Descending | Select-Object -First 1
  if (-not $prev) { continue }

  $cClose = [double]$c.close
  $cHigh  = [double]$c.high
  $cLow   = [double]$c.low
  $pHigh  = [double]$prev.high
  $pLow   = [double]$prev.low

  $dir = $null
  $lvl = $null
  if ($cClose -gt $pHigh) { $dir = 'BUY';  $lvl = $pHigh }
  elseif ($cClose -lt $pLow) { $dir = 'SELL'; $lvl = $pLow }

  if (-not $dir) { continue }

  # Grab 4 M15s inside this H1
  $insideM15 = $m15 | Where-Object {
    $mt = ([datetime]::Parse($_.time)).ToUniversalTime()
    $mt -ge $t -and $mt -lt $t.AddHours(1)
  } | Sort-Object time
  if ($insideM15.Count -ne 4) { continue }

  $aligned = $true
  foreach ($mm in $insideM15) {
    $mo = [double]$mm.open; $mc = [double]$mm.close
    if ($dir -eq 'BUY' -and $mc -le $mo)  { $aligned = $false; break }
    if ($dir -eq 'SELL' -and $mc -ge $mo) { $aligned = $false; break }
  }

  if (-not $aligned) { continue }

  $brk = ($cClose - $lvl) / $pd
  $tStr = $t.ToString('MM-dd HH:mm')
  Write-Host ("  * HIT  {0}  {1}  break level {2:F3}  ({3:+#0.0;-#0.0} pips past level)" -f $tStr, $dir, $lvl, [Math]::Abs($brk))
  $hits++
}
if ($hits -eq 0) {
  Write-Host "  (no clean-break hits)"
} else {
  Write-Host "  -> $hits H1 clean-break hit(s) in window"
}

# ── Engine 2: DAILY CONTINUATION direction ─────────────────────────────────
Write-Host ""
Write-Host "=== ENGINE: DAILY CONTINUATION (direction confirmation) ==="

# Build synthetic daily candles: forex day starts prev calendar day 21:00 UTC.
# For Mon 6 Jul, today's day starts Sun 5 Jul 21:00. D-1 (weekend-skipped) = Fri
# 3 Jul's forex day (Thu 2 21:00 -> Fri 3 21:00). D-2 = Thursday's, D-3 = Wed.
function BuildSyntheticDaily($startUtc, $endUtc) {
  $inWin = $h1 | Where-Object {
    $t = ([datetime]::Parse($_.time)).ToUniversalTime()
    $t -ge $startUtc -and $t -lt $endUtc
  } | Sort-Object time
  if ($inWin.Count -lt 5) { return $null }
  $open = [double]$inWin[0].open
  $close = [double]$inWin[-1].close
  $hi = ($inWin | ForEach-Object { [double]$_.high } | Measure-Object -Maximum).Maximum
  $lo = ($inWin | ForEach-Object { [double]$_.low  } | Measure-Object -Minimum).Minimum
  return [pscustomobject]@{ open=$open; close=$close; high=$hi; low=$lo; start=$startUtc; end=$endUtc }
}

# Anchor
$todayStart = [datetime]::Parse('2026-07-05T21:00:00Z').ToUniversalTime()
$d1Start    = [datetime]::Parse('2026-07-02T21:00:00Z').ToUniversalTime()  # Thu 21:00 -> Fri 21:00
$d1End      = [datetime]::Parse('2026-07-03T21:00:00Z').ToUniversalTime()
$d2Start    = [datetime]::Parse('2026-07-01T21:00:00Z').ToUniversalTime()  # Wed 21:00 -> Thu 21:00
$d2End      = [datetime]::Parse('2026-07-02T21:00:00Z').ToUniversalTime()
$d3Start    = [datetime]::Parse('2026-06-30T21:00:00Z').ToUniversalTime()  # Tue 21:00 -> Wed 21:00
$d3End      = [datetime]::Parse('2026-07-01T21:00:00Z').ToUniversalTime()

$d1 = BuildSyntheticDaily $d1Start $d1End
$d2 = BuildSyntheticDaily $d2Start $d2End
$d3 = BuildSyntheticDaily $d3Start $d3End

if ($d1) { Write-Host ("  D-1 (Fri 3 Jul): O={0:F3} H={1:F3} L={2:F3} C={3:F3}" -f $d1.open, $d1.high, $d1.low, $d1.close) }
if ($d2) { Write-Host ("  D-2 (Thu 2 Jul): O={0:F3} H={1:F3} L={2:F3} C={3:F3}" -f $d2.open, $d2.high, $d2.low, $d2.close) }
if ($d3) { Write-Host ("  D-3 (Wed 1 Jul): O={0:F3} H={1:F3} L={2:F3} C={3:F3}" -f $d3.open, $d3.high, $d3.low, $d3.close) }

if ($d1 -and $d2) {
  $d1BuyBrk  = $d1.close -gt $d2.high
  $d1SellBrk = $d1.close -lt $d2.low
  $d2BuyBrk  = $d3 -and $d2.close -gt $d3.high
  $d2SellBrk = $d3 -and $d2.close -lt $d3.low
  Write-Host ("  D-1 close vs D-2: BUY-break={0}  SELL-break={1}" -f $d1BuyBrk, $d1SellBrk)
  Write-Host ("  D-2 close vs D-3: BUY-break={0}  SELL-break={1}" -f $d2BuyBrk, $d2SellBrk)

  $buyConfirm = $d1BuyBrk -or $d2BuyBrk
  $sellConfirm = $d1SellBrk -or $d2SellBrk
  $direction = $null
  if ($buyConfirm -and -not $sellConfirm) { $direction = 'BUY' }
  elseif ($sellConfirm -and -not $buyConfirm) { $direction = 'SELL' }
  elseif ($buyConfirm -and $sellConfirm) {
    if ($d1BuyBrk) { $direction = 'BUY' }
    elseif ($d1SellBrk) { $direction = 'SELL' }
    else { $direction = if ($d2BuyBrk) { 'BUY' } else { 'SELL' } }
  }
  $dirLabel = if ($direction) { $direction } else { 'NONE (skip)' }
  Write-Host ("  -> Confirmed direction: {0}" -f $dirLabel)

  if ($direction) {
    Write-Host ""
    Write-Host "  Trigger candidates (H1 in today whose close breaks D-1 level in confirmed dir):"
    $todayH1 = $h1 | Where-Object {
      $t = ([datetime]::Parse($_.time)).ToUniversalTime()
      $t -ge $todayStart
    } | Sort-Object time
    foreach ($c in $todayH1) {
      $t = ([datetime]::Parse($c.time)).ToUniversalTime()
      # Blackout 21-22 UTC
      if ($t.Hour -eq 21) { continue }
      $close = [double]$c.close
      if ($direction -eq 'BUY' -and $close -gt $d1.high) {
        $brk = ($close - $d1.high) / $pd
        Write-Host ("    * TRIGGER  {0}  close {1:F3} > D-1 high {2:F3}  ({3:F1} pips past)" -f `
          $t.ToString('MM-dd HH:mm'), $close, $d1.high, $brk)
        break
      }
      if ($direction -eq 'SELL' -and $close -lt $d1.low) {
        $brk = ($d1.low - $close) / $pd
        Write-Host ("    * TRIGGER  {0}  close {1:F3} < D-1 low {2:F3}  ({3:F1} pips past)" -f `
          $t.ToString('MM-dd HH:mm'), $close, $d1.low, $brk)
        break
      }
    }
  }
}
