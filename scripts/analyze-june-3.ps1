$ErrorActionPreference = 'Stop'

$currencies = @('USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD')
$timeframes = @(
  [pscustomobject]@{ Label='3H'; Col='smooth_3h' },
  [pscustomobject]@{ Label='4H'; Col='smooth_4h' },
  [pscustomobject]@{ Label='6H'; Col='smooth_6h' }
)
$MagMap = @{ '3H'=10; '4H'=10; '6H'=15 }
$allowedStruct = @('1v7','7v1','2v6','6v2','3v5','5v3')
$RATIO_T = 0.70
$EXT_T = 0.28
$EXTREMES_T = 0.60

$rawJson = Get-Content -Raw -Path scratch/june-3.json
$rows = ConvertFrom-Json $rawJson
Write-Host "Loaded $($rows.Count) currency_strength rows"

# Group by time -> { currency: {3H, 4H, 6H} }
$byTime = @{}
foreach ($r in $rows) {
  if (-not $byTime.ContainsKey($r.time)) { $byTime[$r.time] = @{} }
  $byTime[$r.time][$r.currency] = @{
    '3H' = [double]$r.smooth_3h * 10000
    '4H' = [double]$r.smooth_4h * 10000
    '6H' = [double]$r.smooth_6h * 10000
  }
}

function Analyse($strength) {
  # Sort by value desc
  $sortedNames = @($currencies | Sort-Object -Property @{ Expression = { $strength[$_] } } -Descending)
  $top1 = $sortedNames[0]; $top2 = $sortedNames[1]
  $bot1 = $sortedNames[7]; $bot2 = $sortedNames[6]

  $top1Val = $strength[$top1]
  $bot8Val = $strength[$bot1]

  $A = $strength[$top1] + $strength[$top2]
  $B = -1 * ($strength[$bot1] + $strength[$bot2])
  $sidesValid = ($A -gt 0) -and ($B -gt 0)
  $ratio = if ($sidesValid) { [Math]::Min($A,$B) / [Math]::Max($A,$B) } else { 1 }
  $ratioValid = $sidesValid -and ($ratio -lt $RATIO_T)

  $leaderRatio = if ($top1Val -ne 0) { $strength[$top2] / $top1Val } else { 1 }
  $leaderValid = ($top1Val -gt 0) -and ($leaderRatio -lt $EXT_T)

  $loserRatio = if ($bot8Val -ne 0) { $strength[$bot2] / $bot8Val } else { 1 }
  $loserValid = ($bot8Val -lt 0) -and ($loserRatio -lt $EXT_T)

  $absTop = [Math]::Abs($top1Val)
  $absBot = [Math]::Abs($bot8Val)
  $extRatio = if (($absTop -gt 0) -and ($absBot -gt 0)) { [Math]::Min($absTop,$absBot) / [Math]::Max($absTop,$absBot) } else { 1 }
  $extValid = $extRatio -lt $EXTREMES_T

  $strongCount = ($currencies | Where-Object { $strength[$_] -gt 0 }).Count
  $weakCount = ($currencies | Where-Object { $strength[$_] -lt 0 }).Count
  $structure = "${strongCount}v${weakCount}"

  return [pscustomobject]@{
    top1=$top1; top1Val=$top1Val; bot8=$bot1; bot8Val=$bot8Val
    top2Sum=$A; bot2Sum=$B
    ratio=$ratio; ratioValid=$ratioValid
    leaderRatio=$leaderRatio; leaderValid=$leaderValid
    loserRatio=$loserRatio; loserValid=$loserValid
    extRatio=$extRatio; extValid=$extValid
    structure=$structure
  }
}

$out = New-Object System.Collections.ArrayList
$header = 'time,tf,structure,top1,top1Val,bot8,bot8Val,top2Sum,bot2Sum,TB_pct,ratioValid,leader_pct,leaderValid,loser_pct,loserValid,ext_pct,extValid,magPass,structPass,anyGate,qualifies,' + ($currencies -join ',')
[void]$out.Add($header)

foreach ($t in ($byTime.Keys | Sort-Object)) {
  $ccyData = $byTime[$t]
  if ($ccyData.Count -ne 8) { continue }
  foreach ($tf in $timeframes) {
    $strength = @{}
    foreach ($c in $currencies) { $strength[$c] = $ccyData[$c][$tf.Label] }

    $r = Analyse $strength
    $mag = $MagMap[$tf.Label]
    $magPass = ($r.top1Val -gt $mag) -or ($r.bot8Val -lt (-1 * $mag))
    $structPass = $allowedStruct -contains $r.structure
    $extremesTFs = ($tf.Label -eq '3H') -or ($tf.Label -eq '6H')
    $anyGate = $r.ratioValid -or $r.leaderValid -or $r.loserValid -or ($extremesTFs -and $r.extValid)
    $qualifies = $anyGate -and $structPass -and $magPass

    $vals = foreach ($c in $currencies) { ('{0:F2}' -f $strength[$c]) }
    $line = @(
      $t, $tf.Label, $r.structure,
      $r.top1, ('{0:F2}' -f $r.top1Val), $r.bot8, ('{0:F2}' -f $r.bot8Val),
      ('{0:F2}' -f $r.top2Sum), ('{0:F2}' -f $r.bot2Sum),
      ('{0:F1}' -f ($r.ratio * 100)), $r.ratioValid,
      ('{0:F1}' -f ($r.leaderRatio * 100)), $r.leaderValid,
      ('{0:F1}' -f ($r.loserRatio * 100)), $r.loserValid,
      ('{0:F1}' -f ($r.extRatio * 100)), $r.extValid,
      $magPass, $structPass, $anyGate, $qualifies
    ) + $vals
    [void]$out.Add(($line -join ','))
  }
}

$out | Out-File -FilePath scratch/june-3-imbalance.csv -Encoding utf8
Write-Host ("Wrote {0} rows to scratch/june-3-imbalance.csv" -f ($out.Count - 1))

# Quick summary
$data = Import-Csv -Path scratch/june-3-imbalance.csv

Write-Host ''
Write-Host '=== Summary — how each gate performed on 2026-06-03 ==='
foreach ($tf in @('3H','4H','6H')) {
  $tfRows = $data | Where-Object { $_.tf -eq $tf }
  $total = $tfRows.Count
  Write-Host ("[{0}] total hours: {1}" -f $tf, $total)
  Write-Host ("    ratioValid  passes: {0}" -f ($tfRows | Where-Object { $_.ratioValid -eq 'True' }).Count)
  Write-Host ("    leaderValid passes: {0}" -f ($tfRows | Where-Object { $_.leaderValid -eq 'True' }).Count)
  Write-Host ("    loserValid  passes: {0}" -f ($tfRows | Where-Object { $_.loserValid -eq 'True' }).Count)
  Write-Host ("    extValid    passes: {0}" -f ($tfRows | Where-Object { $_.extValid -eq 'True' }).Count)
  Write-Host ("    magPass     passes: {0}" -f ($tfRows | Where-Object { $_.magPass -eq 'True' }).Count)
  Write-Host ("    structPass  passes: {0}" -f ($tfRows | Where-Object { $_.structPass -eq 'True' }).Count)
  Write-Host ("    anyGate     passes: {0}" -f ($tfRows | Where-Object { $_.anyGate -eq 'True' }).Count)
  Write-Host ("    qualifies (all gates): {0}" -f ($tfRows | Where-Object { $_.qualifies -eq 'True' }).Count)
}

Write-Host ''
Write-Host '=== Structure distribution ==='
$data | Group-Object structure | Sort-Object Count -Descending | Select-Object Count,Name | Format-Table -AutoSize
