$ErrorActionPreference = 'Stop'

$pd = 0.01
$currencies = @('USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD')

$h1 = ConvertFrom-Json (Get-Content -Raw scratch/usdjpy-h1.json)
$m15 = ConvertFrom-Json (Get-Content -Raw scratch/usdjpy-m15-wide.json)
$strength = ConvertFrom-Json (Get-Content -Raw scratch/usdjpy-strength.json)
$m15Str = ConvertFrom-Json (Get-Content -Raw scratch/usdjpy-m15strength.json)
Write-Host ('H1={0}  M15={1}  strength={2}  m15Str={3}' -f $h1.Count, $m15.Count, $strength.Count, $m15Str.Count)

$windowStart = [datetime]::Parse('2026-07-05T22:00:00Z').ToUniversalTime()
$windowEnd   = [datetime]::Parse('2026-07-06T07:00:00Z').ToUniversalTime()

# ─────────────────────────────────────────────────────────────
# Currency Acceleration
# ─────────────────────────────────────────────────────────────
$strByTime = @{}
foreach ($r in $strength) {
  if (-not $strByTime.ContainsKey($r.time)) { $strByTime[$r.time] = @{} }
  $strByTime[$r.time][$r.currency] = @{
    s3 = [double]$r.smooth_3h * 10000
  }
}
Write-Host ''
Write-Host '=== ENGINE 3: CURRENCY ACCELERATION ==='

$times = $strByTime.Keys | Sort-Object
$hit3 = 0
for ($i = 1; $i -lt $times.Count; $i++) {
  $tk = $times[$i]
  $tk_prev = $times[$i - 1]
  $tDate = [datetime]::Parse($tk).ToUniversalTime()
  if ($tDate -lt $windowStart -or $tDate -ge $windowEnd) { continue }

  $cur = $strByTime[$tk]
  $prev = $strByTime[$tk_prev]
  if ($cur.Count -ne 8 -or $prev.Count -ne 8) { continue }

  $accels = @{}
  foreach ($c in $currencies) { $accels[$c] = $cur[$c].s3 - $prev[$c].s3 }
  $sortedByStrength = $currencies | Sort-Object { $cur[$_].s3 } -Descending
  $top2Str = $sortedByStrength[0..1]
  $bot2Str = $sortedByStrength[6..7]

  $usdTop = $top2Str -contains 'USD'
  $jpyBot = $bot2Str -contains 'JPY'
  $jpyTop = $top2Str -contains 'JPY'
  $usdBot = $bot2Str -contains 'USD'
  if (($usdTop -and $jpyBot) -or ($jpyTop -and $usdBot)) {
    $dir = 'BUY'
    if ($jpyTop -and $usdBot) { $dir = 'SELL' }
    $spread = $cur['USD'].s3 - $cur['JPY'].s3
    $line = '  HIT {0} USD/JPY {1} spread={2:F2} USDaccel={3:F2} JPYaccel={4:F2}' -f $tDate.ToString('MM-dd HH:mm'), $dir, $spread, $accels['USD'], $accels['JPY']
    Write-Host $line
    $hit3++
  }
}
Write-Host ('Currency Acceleration total hits: {0}' -f $hit3)

# ─────────────────────────────────────────────────────────────
# H4 Continuation
# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '=== ENGINE 4: H4 CONTINUATION ==='

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

$cutoff = $windowStart
$completeH4s = @($buckets.Values | Where-Object { $_.count -eq 4 -and $_.start.AddHours(4) -le $cutoff } | Sort-Object start)
Write-Host ('  Complete H4 buckets before {0}: {1}' -f $cutoff.ToString('MM-dd HH:mm'), $completeH4s.Count)
$last3 = @($completeH4s | Select-Object -Last 3)

if ($last3.Count -lt 2) {
  Write-Host '  Not enough H4s.'
} else {
  $ref  = $last3[-1]
  $ref2 = $last3[-2]
  $ref3 = $null
  if ($last3.Count -ge 3) { $ref3 = $last3[-3] }

  Write-Host ('  H4[-1] {0}: O={1:F3} H={2:F3} L={3:F3} C={4:F3}' -f $ref.start.ToString('MM-dd HH:mm'), $ref.open, $ref.high, $ref.low, $ref.close)
  Write-Host ('  H4[-2] {0}: O={1:F3} H={2:F3} L={3:F3} C={4:F3}' -f $ref2.start.ToString('MM-dd HH:mm'), $ref2.open, $ref2.high, $ref2.low, $ref2.close)
  if ($ref3) {
    Write-Host ('  H4[-3] {0}: O={1:F3} H={2:F3} L={3:F3} C={4:F3}' -f $ref3.start.ToString('MM-dd HH:mm'), $ref3.open, $ref3.high, $ref3.low, $ref3.close)
  }

  $r1Buy  = $ref.close  -gt $ref2.high
  $r1Sell = $ref.close  -lt $ref2.low
  $r2Buy  = $false; $r2Sell = $false
  if ($ref3) { $r2Buy = $ref2.close -gt $ref3.high; $r2Sell = $ref2.close -lt $ref3.low }
  Write-Host ('  H4[-1] vs H4[-2]: BUY={0} SELL={1}' -f $r1Buy, $r1Sell)
  Write-Host ('  H4[-2] vs H4[-3]: BUY={0} SELL={1}' -f $r2Buy, $r2Sell)

  $direction = $null
  $buyC = $r1Buy -or $r2Buy
  $sellC = $r1Sell -or $r2Sell
  if ($buyC -and -not $sellC) { $direction = 'BUY' }
  elseif ($sellC -and -not $buyC) { $direction = 'SELL' }
  elseif ($buyC -and $sellC) {
    if ($r1Buy) { $direction = 'BUY' }
    elseif ($r1Sell) { $direction = 'SELL' }
    elseif ($r2Buy) { $direction = 'BUY' }
    else { $direction = 'SELL' }
  }
  if ($direction) {
    Write-Host ('  Confirmed direction: {0}' -f $direction)
  } else {
    Write-Host '  Confirmed direction: NONE (skip)'
  }

  if ($direction) {
    $trackStart = $ref.start.AddHours(4)
    Write-Host ('  Track from {0}' -f $trackStart.ToString('MM-dd HH:mm'))
    $sortedM15 = @($m15 | Sort-Object time)
    $foundTrig = $false
    for ($i = 24; $i -lt $sortedM15.Count; $i++) {
      $c = $sortedM15[$i]
      $t = [datetime]::Parse($c.time).ToUniversalTime()
      if ($t -lt $trackStart) { continue }
      if ($t -ge $windowEnd) { break }
      if ($t.Hour -eq 21) { continue }

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
        $line = '  TRIGGER 1  {0}  close={1:F3}  24-M15 high={2:F3}  break={3:F1} pips' -f $t.ToString('MM-dd HH:mm'), $close, $maxH, $brk
        Write-Host $line
        $foundTrig = $true
        break
      }
      if ($direction -eq 'SELL' -and $close -lt $minL) {
        $brk = ($minL - $close) / $pd
        $line = '  TRIGGER 1  {0}  close={1:F3}  24-M15 low={2:F3}  break={3:F1} pips' -f $t.ToString('MM-dd HH:mm'), $close, $minL, $brk
        Write-Host $line
        $foundTrig = $true
        break
      }
    }
    if (-not $foundTrig) { Write-Host '  No trigger in window.' }
  }
}

# ─────────────────────────────────────────────────────────────
# M15 Impulse approximation
# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '=== ENGINE 5: M15 IMPULSE (approx: body>=65pct AND range>=10p AND breaks prev M15) ==='
$sortedM15 = @($m15 | Sort-Object time)
$hit5 = 0
for ($i = 1; $i -lt $sortedM15.Count; $i++) {
  $c = $sortedM15[$i]
  $t = [datetime]::Parse($c.time).ToUniversalTime()
  if ($t -lt $windowStart -or $t -ge $windowEnd) { continue }
  $prev = $sortedM15[$i - 1]
  $co = [double]$c.open; $cc = [double]$c.close; $ch = [double]$c.high; $cl = [double]$c.low
  $ph = [double]$prev.high; $pl = [double]$prev.low
  $rangeP = ($ch - $cl) / $pd
  $bodyP  = [Math]::Abs($cc - $co) / $pd
  $bodyPct = 0
  if ($rangeP -gt 0) { $bodyPct = $bodyP / $rangeP * 100 }
  $dir = 'SELL'
  if ($cc -gt $co) { $dir = 'BUY' }
  $broke = $false
  if ($dir -eq 'BUY' -and $cc -gt $ph) { $broke = $true }
  if ($dir -eq 'SELL' -and $cc -lt $pl) { $broke = $true }
  if ($rangeP -ge 10 -and $bodyPct -ge 65 -and $broke) {
    $line = '  IMPULSE {0} {1} body={2:F1}p bodyPct={3:F0} range={4:F1}p' -f $t.ToString('MM-dd HH:mm'), $dir, $bodyP, $bodyPct, $rangeP
    Write-Host $line
    $hit5++
  }
}
Write-Host ('M15 Impulse total hits: {0}' -f $hit5)

# ─────────────────────────────────────────────────────────────
# Market Imbalance M15 (USD/JPY)
# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '=== ENGINE 6: M15 STRENGTH — USD/JPY top-vs-bot check ==='
$hit6 = 0
foreach ($r in $m15Str) {
  $t = [datetime]::Parse($r.time).ToUniversalTime()
  if ($t -lt $windowStart -or $t -ge $windowEnd) { continue }
  $vals = $r.values
  $strengthMap = @{}
  $ok = $true
  foreach ($c in $currencies) {
    $v = $vals.$c
    if ($null -eq $v) { $ok = $false; break }
    $strengthMap[$c] = [double]$v * 10000
  }
  if (-not $ok) { continue }
  $sorted = $currencies | Sort-Object { $strengthMap[$_] } -Descending
  $top2 = $sorted[0..1]
  $bot2 = $sorted[6..7]
  $usdTop = $top2 -contains 'USD'
  $jpyBot = $bot2 -contains 'JPY'
  $jpyTop = $top2 -contains 'JPY'
  $usdBot = $bot2 -contains 'USD'
  if (($usdTop -and $jpyBot) -or ($jpyTop -and $usdBot)) {
    $dir = 'BUY'
    if ($jpyTop -and $usdBot) { $dir = 'SELL' }
    $spread = $strengthMap['USD'] - $strengthMap['JPY']
    $line = '  {0}  USD/JPY {1}  USD={2:F2}  JPY={3:F2}  spread={4:F2}' -f $t.ToString('MM-dd HH:mm'), $dir, $strengthMap['USD'], $strengthMap['JPY'], $spread
    Write-Host $line
    $hit6++
  }
}
Write-Host ('M15 Imbalance total: {0}' -f $hit6)
