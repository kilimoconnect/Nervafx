$ErrorActionPreference = 'Stop'

$pd = 0.0001

$h1  = ConvertFrom-Json (Get-Content -Raw scratch/gbpchf-h1.json)
$m15 = ConvertFrom-Json (Get-Content -Raw scratch/gbpchf-m15.json)
Write-Host ('H1: {0}  M15: {1}' -f $h1.Count, $m15.Count)

# Convert candles to strong typed arrays
$h1 = $h1 | ForEach-Object {
  [pscustomobject]@{
    time  = [datetime]::Parse($_.time).ToUniversalTime()
    open  = [double]$_.open
    high  = [double]$_.high
    low   = [double]$_.low
    close = [double]$_.close
    volume = [double]$_.volume
  }
} | Sort-Object time

$m15 = $m15 | ForEach-Object {
  [pscustomobject]@{
    time  = [datetime]::Parse($_.time).ToUniversalTime()
    open  = [double]$_.open
    high  = [double]$_.high
    low   = [double]$_.low
    close = [double]$_.close
    volume = [double]$_.volume
  }
} | Sort-Object time

function Ema {
  param($values, [int]$period)
  if ($values.Count -lt $period) { return $null }
  $k = 2.0 / ($period + 1)
  $seed = ($values[0..($period-1)] | Measure-Object -Average).Average
  $e = $seed
  for ($i = $period; $i -lt $values.Count; $i++) {
    $e = $values[$i] * $k + $e * (1 - $k)
  }
  return $e
}

function Atr {
  param($candles, [int]$period)
  if ($candles.Count -lt ($period + 1)) { return $null }
  $trs = @()
  for ($i = 1; $i -lt $candles.Count; $i++) {
    $c = $candles[$i]; $p = $candles[$i-1]
    $tr = [Math]::Max([Math]::Max($c.high - $c.low, [Math]::Abs($c.high - $p.close)), [Math]::Abs($c.low - $p.close))
    $trs += $tr
  }
  $window = $trs[($trs.Count - $period)..($trs.Count - 1)]
  return ($window | Measure-Object -Average).Average
}

# Audit window: 6 Jul 2026 all M15 anchors
$auditStart = [datetime]::Parse('2026-07-06T00:00:00Z').ToUniversalTime()
$auditEnd   = [datetime]::Parse('2026-07-06T23:45:00Z').ToUniversalTime()

$results = @()
$anchor = $auditStart
while ($anchor -le $auditEnd) {
  $anchorMs = $anchor.Ticks
  $h1Slice  = @($h1  | Where-Object { $_.time -le $anchor })
  $m15Slice = @($m15 | Where-Object { $_.time -le $anchor })
  if ($h1Slice.Count -lt 51 -or $m15Slice.Count -lt 51) {
    $anchor = $anchor.AddMinutes(15); continue
  }

  # H1 bias
  $closes = $h1Slice | ForEach-Object { $_.close }
  $closesPrev = $closes[0..($closes.Count - 2)]
  $e20Now  = Ema $closes 20
  $e50Now  = Ema $closes 50
  $e20Prev = Ema $closesPrev 20
  $e50Prev = Ema $closesPrev 50
  $cNow    = $closes[-1]
  $cPrev   = $closes[-2]
  $hPrev   = $h1Slice[-2].high
  $lPrev   = $h1Slice[-2].low

  $breakoutUp   = $cNow -gt $hPrev
  $breakoutDown = $cNow -lt $lPrev
  $bullish = ($cNow -gt $e20Now) -and ($cPrev -gt $e20Prev) -and ($e20Now -gt $e50Now) -and ($e20Prev -gt $e50Prev) -and $breakoutUp
  $bearish = ($cNow -lt $e20Now) -and ($cPrev -lt $e20Prev) -and ($e20Now -lt $e50Now) -and ($e20Prev -lt $e50Prev) -and $breakoutDown
  $h1Dir = $null; $h1Score = 0
  if ($bullish) { $h1Dir = 'BUY'; $h1Score = 100 }
  elseif ($bearish) { $h1Dir = 'SELL'; $h1Score = 100 }

  # M15 velocity
  $atr14M15 = Atr $m15Slice 14
  $c0 = $m15Slice[-1].close
  $c4 = $m15Slice[-5].close
  $c8 = $m15Slice[-9].close
  $signedVel = ($c0 - $c4) / $atr14M15
  $velRaw = [Math]::Abs($signedVel)
  $velScore = [Math]::Min($velRaw * 33, 100)

  # M15 acceleration
  $v1 = [Math]::Abs($c0 - $c4) / $atr14M15
  $v2 = [Math]::Abs($c4 - $c8) / $atr14M15
  $accel = $v1 - $v2
  $accelScore = [Math]::Min([Math]::Max($accel * 50, 0), 100)

  # Compression
  $atr50M15 = Atr $m15Slice 50
  $compRatio = $atr14M15 / $atr50M15
  $compScore = 60
  if ($compRatio -lt 0.70) { $compScore = 100 }
  elseif ($compRatio -le 0.85) { $compScore = 80 }
  elseif ($compRatio -le 1.20) { $compScore = 60 }
  else { $compScore = 40 }

  # Candle control
  $cc = $m15Slice[-1]
  $range = $cc.high - $cc.low
  $eff = 0
  if ($range -gt 0) { $eff = [Math]::Abs($cc.close - $cc.open) / $range }
  $candScore = $eff * 100

  # Final score
  $finalScore = [Math]::Round(
    $h1Score  * 0.30 +
    $velScore * 0.20 +
    $accelScore * 0.30 +
    $compScore * 0.10 +
    $candScore * 0.10
  )

  $m15Aligned = $false
  if ($h1Dir -eq 'BUY' -and $signedVel -gt 0) { $m15Aligned = $true }
  elseif ($h1Dir -eq 'SELL' -and $signedVel -lt 0) { $m15Aligned = $true }

  # Current production gates
  $qualifiesFull = ($h1Dir -ne $null) -and $m15Aligned -and ($accelScore -gt 55) -and ($velScore -gt 55) -and ($finalScore -ge 75)
  $qualifiesRelaxed = ($h1Dir -ne $null) -and $m15Aligned -and ($accelScore -gt 40) -and ($velScore -gt 40) -and ($finalScore -ge 70)

  $results += [pscustomobject]@{
    time = $anchor
    h1Dir = $h1Dir
    accel = [Math]::Round($accelScore, 1)
    vel = [Math]::Round($velScore, 1)
    comp = $compScore
    cand = [Math]::Round($candScore, 1)
    final = $finalScore
    breakoutUp = $breakoutUp
    breakoutDown = $breakoutDown
    qual = $qualifiesFull
    relaxed = $qualifiesRelaxed
  }

  $anchor = $anchor.AddMinutes(15)
}

Write-Host ''
Write-Host '=== GBP/CHF timeline on 6 Jul 2026 (all anchors) ==='
Write-Host 'Time         H1   Acc   Vel  Cmp   Cand   FIN   Brk  Full  Relaxed'

foreach ($r in $results) {
  if ($r.h1Dir -eq $null) {
    Write-Host ('{0}  NULL  (H1 EMA alignment or breakout failed)' -f $r.time.ToString('HH:mm'))
    continue
  }
  $brk = ''
  if ($r.breakoutUp) { $brk = 'UP' } elseif ($r.breakoutDown) { $brk = 'DN' }
  $line = ('{0}  {1,-4}  {2,5:F1}  {3,5:F1}  {4,3}  {5,5:F1}  {6,4}  {7,-3}  {8,-4}  {9}' -f `
    $r.time.ToString('HH:mm'), $r.h1Dir, $r.accel, $r.vel, $r.comp, $r.cand, $r.final, $brk, $r.qual, $r.relaxed)
  Write-Host $line
}

Write-Host ''
$fullQual = $results | Where-Object { $_.qual }
$relaxedQual = $results | Where-Object { $_.relaxed -and -not $_.qual }
Write-Host ('Full qualification (existing thresholds): {0} anchors' -f $fullQual.Count)
Write-Host ('Relaxed qualification (accel>40, vel>40, final>75): {0} additional anchors' -f $relaxedQual.Count)

Write-Host ''
Write-Host '=== H1 candles 6 Jul 2026 ==='
foreach ($h in ($h1 | Where-Object { $_.time -ge $auditStart -and $_.time -le $auditEnd })) {
  $body = ($h.close - $h.open) / $pd
  $range = ($h.high - $h.low) / $pd
  $dir = 'BULL'
  if ($body -lt 0) { $dir = 'BEAR' }
  $line = ('{0}  O={1:F5}  H={2:F5}  L={3:F5}  C={4:F5}  body={5:F1}p  range={6:F1}p  {7}' -f `
    $h.time.ToString('HH:mm'), $h.open, $h.high, $h.low, $h.close, $body, $range, $dir)
  Write-Host $line
}
