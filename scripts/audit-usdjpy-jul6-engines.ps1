$ErrorActionPreference = 'Stop'

$pd = 0.01  # JPY pair
$currencies = @('USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD')
$h1 = ConvertFrom-Json (Get-Content -Raw scratch/usdjpy-h1.json)
$m15 = ConvertFrom-Json (Get-Content -Raw scratch/usdjpy-m15-wide.json)
$strength = ConvertFrom-Json (Get-Content -Raw scratch/usdjpy-strength.json)
$m15Str = ConvertFrom-Json (Get-Content -Raw scratch/usdjpy-m15strength.json)
Write-Host ("H1: {0}   M15: {1}   currency_strength: {2}   m15_currency_strength: {3}" -f `
  $h1.Count, $m15.Count, $strength.Count, $m15Str.Count)

$windowStart = [datetime]::Parse('2026-07-05T22:00:00Z').ToUniversalTime()
$windowEnd   = [datetime]::Parse('2026-07-06T07:00:00Z').ToUniversalTime()

# ── Group currency_strength by time ────────────────────────────────────────
$strByTime = @{}
foreach ($r in $strength) {
  if (-not $strByTime.ContainsKey($r.time)) { $strByTime[$r.time] = @{} }
  $strByTime[$r.time][$r.currency] = @{
    s3 = [double]$r.smooth_3h * 10000
    s4 = [double]$r.smooth_4h * 10000
    s6 = [double]$r.smooth_6h * 10000
  }
}

# ══════════════════════════════════════════════════════════════════════════
# ENGINE 3: Currency Acceleration
# Hourly delta of 3H smooth strength; USD/JPY qualifies when USD (or JPY) is
# in top-2 accelerators and the other is in bottom-2 accelerators.
# ══════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "=== ENGINE 3: CURRENCY ACCELERATION (hourly delta of 3H strength) ==="

$times = $strByTime.Keys | Sort-Object
$hit = 0
foreach ($t in $times) {
  $tDate = [datetime]::Parse($t).ToUniversalTime()
  if ($tDate -lt $windowStart -or $tDate -ge $windowEnd) { continue }
  # Find prev hour
  $tPrevDate = $tDate.AddHours(-1)
  $tPrevKey = ($times | Where-Object { [datetime]::Parse($_).ToUniversalTime() -eq $tPrevDate } | Select-Object -First 1)
  if (-not $tPrevKey) { continue }

  $cur = $strByTime[$t]
  $prev = $strByTime[$tPrevKey]
  if ($cur.Count -ne 8 -or $prev.Count -ne 8) { continue }

  # Compute accel per currency
  $accels = @{}
  foreach ($c in $currencies) {
    $accels[$c] = $cur[$c].s3 - $prev[$c].s3
  }
  $sortedByAccel = $currencies | Sort-Object { $accels[$_] } -Descending
  $top2Accel = $sortedByAccel[0..1]
  $bot2Accel = $sortedByAccel[6..7]

  # Also need strength ranking (they use top2/bot2 by strength for the pair)
  $sortedByStrength = $currencies | Sort-Object { $cur[$_].s3 } -Descending
  $top2Str = $sortedByStrength[0..1]
  $bot2Str = $sortedByStrength[6..7]

  $usdInTopStr = $top2Str -contains 'USD'
  $jpyInBotStr = $bot2Str -contains 'JPY'
  $jpyInTopStr = $top2Str -contains 'JPY'
  $usdInBotStr = $bot2Str -contains 'USD'
  $pairEmerges = ($usdInTopStr -and $jpyInBotStr) -or ($jpyInTopStr -and $usdInBotStr)

  if ($pairEmerges) {
    $dir = if ($usdInTopStr -and $jpyInBotStr) { 'BUY' } else { 'SELL' }
    $spread = $cur['USD'].s3 - $cur['JPY'].s3
    $msg = '  * HIT  {0}  USD/JPY {1}  spread={2:F2}  USD accel={3:F2}  JPY accel={4:F2}' -f $tDate.ToString('MM-dd HH:mm'), $dir, $spread, $accels['USD'], $accels['JPY']
    Write-Host $msg
    $hit++
  }
}
if ($hit -eq 0) { Write-Host "  (no hits)" } else { Write-Host "  -> $hit currency-acceleration hits" }

# ══════════════════════════════════════════════════════════════════════════
# ENGINE 4: H4 CONTINUATION (H4 ref + M15 tracking, 24-M15 lookback)
# Direction confirmed via last 2 complete H4s vs their predecessors.
# Trigger = first M15 in current H4 window that closes beyond highest high /
# lowest low of the last 24 M15s in the confirmed direction. Then look for
# a monitoring candle with delta >= +6 AND score > 75 to promote to Trigger 2.
# ══════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "=== ENGINE 4: H4 CONTINUATION ==="

# Build H4 buckets from H1s. Buckets align to 00/04/08/12/16/20 UTC.
$buckets = @{}
foreach ($h in $h1) {
  $t = [datetime]::Parse($h.time).ToUniversalTime()
  $bucketHour = [Math]::Floor($t.Hour / 4) * 4
  $bucketStart = New-Object DateTime($t.Year, $t.Month, $t.Day, $bucketHour, 0, 0, [DateTimeKind]::Utc)
  $key = $bucketStart.ToString('o')
  if (-not $buckets.ContainsKey($key)) {
    $buckets[$key] = [pscustomobject]@{
      start = $bucketStart
      open  = [double]$h.open
      high  = [double]$h.high
      low   = [double]$h.low
      close = [double]$h.close
      count = 1
    }
  } else {
    $b = $buckets[$key]
    if ([double]$h.high -gt $b.high) { $b.high = [double]$h.high }
    if ([double]$h.low  -lt $b.low)  { $b.low  = [double]$h.low  }
    $b.close = [double]$h.close
    $b.count = $b.count + 1
  }
}

# Anchor at start of audit window (5 Jul 22:00 UTC — Sun evening)
$cutoff = $windowStart
$completeH4s = $buckets.Values | Where-Object {
  $_.count -eq 4 -and $_.start.AddHours(4) -le $cutoff
} | Sort-Object start

Write-Host ("  Complete H4 buckets before {0}: {1}" -f $cutoff.ToString('MM-dd HH:mm'), $completeH4s.Count)
$last3 = $completeH4s | Select-Object -Last 3
if ($last3.Count -lt 2) {
  Write-Host "  Not enough complete H4s to confirm direction - skip."
} else {
  $ref  = $last3[-1]
  $ref2 = $last3[-2]
  $ref3 = if ($last3.Count -ge 3) { $last3[-3] } else { $null }

  Write-Host ("  H4[-1] {0}: O={1:F3} H={2:F3} L={3:F3} C={4:F3}" -f $ref.start.ToString('MM-dd HH:mm'), $ref.open, $ref.high, $ref.low, $ref.close)
  Write-Host ("  H4[-2] {0}: O={1:F3} H={2:F3} L={3:F3} C={4:F3}" -f $ref2.start.ToString('MM-dd HH:mm'), $ref2.open, $ref2.high, $ref2.low, $ref2.close)
  if ($ref3) {
    Write-Host ("  H4[-3] {0}: O={1:F3} H={2:F3} L={3:F3} C={4:F3}" -f $ref3.start.ToString('MM-dd HH:mm'), $ref3.open, $ref3.high, $ref3.low, $ref3.close)
  }

  $r1Buy  = $ref.close  -gt $ref2.high
  $r1Sell = $ref.close  -lt $ref2.low
  $r2Buy  = $ref3 -and $ref2.close -gt $ref3.high
  $r2Sell = $ref3 -and $ref2.close -lt $ref3.low
  Write-Host ("  H4[-1] close vs H4[-2]: BUY-break={0}  SELL-break={1}" -f $r1Buy, $r1Sell)
  Write-Host ("  H4[-2] close vs H4[-3]: BUY-break={0}  SELL-break={1}" -f $r2Buy, $r2Sell)

  $buyC = $r1Buy -or $r2Buy
  $sellC = $r1Sell -or $r2Sell
  $direction = $null
  if ($buyC -and -not $sellC) { $direction = 'BUY' }
  elseif ($sellC -and -not $buyC) { $direction = 'SELL' }
  elseif ($buyC -and $sellC) {
    if ($r1Buy) { $direction = 'BUY' }
    elseif ($r1Sell) { $direction = 'SELL' }
    elseif ($r2Buy) { $direction = 'BUY' }
    else { $direction = 'SELL' }
  }
  $dirLabel = 'NONE (skip)'
  if ($direction) { $dirLabel = $direction }
  Write-Host ("  -> Confirmed direction: {0}" -f $dirLabel)

  if ($direction) {
    # Locate trigger: first M15 in current window past 24-M15 rolling max/min
    $trackStart = $ref.start.AddHours(4)
    Write-Host ("  Track from {0}" -f $trackStart.ToString('MM-dd HH:mm'))

    # Sort M15s by time
    $sortedM15 = $m15 | Sort-Object time
    for ($i = 24; $i -lt $sortedM15.Count; $i++) {
      $c = $sortedM15[$i]
      $t = [datetime]::Parse($c.time).ToUniversalTime()
      if ($t -lt $trackStart) { continue }
      if ($t -ge $windowEnd) { break }
      if ($t.Hour -eq 21) { continue } # blackout

      $maxH = -1e18; $minL = 1e18
      for ($j = $i - 24; $j -lt $i; $j++) {
        $hh = [double]$sortedM15[$j].high
        $ll = [double]$sortedM15[$j].low
        if ($hh -gt $maxH) { $maxH = $hh }
        if ($ll -lt $minL) { $minL = $ll }
      }
      $close = [double]$c.close
      if ($direction -eq 'BUY' -and $close -gt $maxH) {
        $brk = ($close - $maxH) / $pd
        $msg = '  * TRIGGER 1  {0}  close {1:F3} above 24-M15 high {2:F3}  ({3:F1} pips)' -f $t.ToString('MM-dd HH:mm'), $close, $maxH, $brk
        Write-Host $msg
        break
      }
      if ($direction -eq 'SELL' -and $close -lt $minL) {
        $brk = ($minL - $close) / $pd
        $msg = '  * TRIGGER 1  {0}  close {1:F3} below 24-M15 low {2:F3}  ({3:F1} pips)' -f $t.ToString('MM-dd HH:mm'), $close, $minL, $brk
        Write-Host $msg
        break
      }
    }
  }
}

# ══════════════════════════════════════════════════════════════════════════
# ENGINE 5: M15 Break Impulse (approximation)
# Flags M15 candles where body% > 65 AND range > 10 pips AND breaks prev M15
# ══════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "=== ENGINE 5: M15 BREAK IMPULSE (approx: body>=65% AND range>=10p AND closes past prev M15) ==="
$sortedM15 = $m15 | Sort-Object time
$m15Hits = 0
for ($i = 1; $i -lt $sortedM15.Count; $i++) {
  $c = $sortedM15[$i]
  $t = [datetime]::Parse($c.time).ToUniversalTime()
  if ($t -lt $windowStart -or $t -ge $windowEnd) { continue }
  $prev = $sortedM15[$i - 1]

  $co = [double]$c.open; $cc = [double]$c.close; $ch = [double]$c.high; $cl = [double]$c.low
  $po = [double]$prev.open; $pc = [double]$prev.close; $ph = [double]$prev.high; $pl = [double]$prev.low

  $rangeP = ($ch - $cl) / $pd
  $bodyP  = [Math]::Abs($cc - $co) / $pd
  $bodyPct = if ($rangeP -gt 0) { $bodyP / $rangeP * 100 } else { 0 }
  $dir = if ($cc -gt $co) { 'BUY' } else { 'SELL' }
  $broke = ($dir -eq 'BUY' -and $cc -gt $ph) -or ($dir -eq 'SELL' -and $cc -lt $pl)

  if ($rangeP -ge 10 -and $bodyPct -ge 65 -and $broke) {
    $msg = '  * IMPULSE  {0}  {1}  body={2:F1}p bodyPct={3:F0}pct  range={4:F1}p' -f $t.ToString('MM-dd HH:mm'), $dir, $bodyP, $bodyPct, $rangeP
    Write-Host $msg
    $m15Hits++
  }
}
if ($m15Hits -eq 0) { Write-Host "  (no impulses)" } else { Write-Host "  -> $m15Hits M15 impulse candle(s)" }

# ══════════════════════════════════════════════════════════════════════════
# ENGINE 6: Market Imbalance M15 (USD/JPY perspective)
# Show for each M15 timestamp in window whether the M15 strength put USD in top2
# and JPY in bot2 (or vice versa)
# ══════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "=== ENGINE 6: M15 STRENGTH — is USD/JPY a top vs bottom pair? ==="
$m15Hits2 = 0
foreach ($r in $m15Str) {
  $t = [datetime]::Parse($r.time).ToUniversalTime()
  if ($t -lt $windowStart -or $t -ge $windowEnd) { continue }
  $vals = $r.values
  $strengthMap = @{}
  foreach ($c in $currencies) {
    $v = $vals.$c
    if ($v -ne $null) { $strengthMap[$c] = [double]$v * 10000 } else { $strengthMap[$c] = 0 }
  }
  if ($strengthMap.Count -ne 8) { continue }
  $sorted = $currencies | Sort-Object { $strengthMap[$_] } -Descending
  $top2 = $sorted[0..1]
  $bot2 = $sorted[6..7]
  $usdTop = $top2 -contains 'USD'
  $jpyBot = $bot2 -contains 'JPY'
  $jpyTop = $top2 -contains 'JPY'
  $usdBot = $bot2 -contains 'USD'
  if (($usdTop -and $jpyBot) -or ($jpyTop -and $usdBot)) {
    $dir = if ($usdTop -and $jpyBot) { 'BUY' } else { 'SELL' }
    $spread = $strengthMap['USD'] - $strengthMap['JPY']
    $msg = '  * {0}  USD/JPY {1}  USD={2:F2}  JPY={3:F2}  spread={4:F2}' -f $t.ToString('MM-dd HH:mm'), $dir, $strengthMap['USD'], $strengthMap['JPY'], $spread
    Write-Host $msg
    $m15Hits2++
  }
}
Write-Host "  Total M15 timestamps where USD/JPY was top-vs-bot pair: $m15Hits2"
