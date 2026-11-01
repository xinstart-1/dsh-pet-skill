<#
  log-digest.ps1 - turn a pile of container logs into a compact, low-token digest.

  The point: never paste whole logs into a model context. This script clusters
  error lines into fingerprints (normalised message + count + first/last seen +
  a few samples with stack context), so an analysis costs hundreds of tokens
  instead of hundreds of thousands.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\log-digest.ps1
    powershell ... -File .\log-digest.ps1 -Hours 2 -Top 20
    powershell ... -File .\log-digest.ps1 -LogsDir D:\ops\logs -OutMarkdown D:\ops\digest.md
#>
param(
  [string]$LogsDir = '',
  [int]$Hours = 0,
  [int]$Top = 15,
  [int]$Samples = 2,
  [string]$OutMarkdown = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($LogsDir)) { $LogsDir = (Join-Path $PSScriptRoot 'logs') }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$errPattern = '(?i)\bERROR\b|\bERRO\b|\bFATAL\b|Exception|Traceback \(most recent call last\)|panic:|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out|timeout|OOMKilled|out of memory|no space left|permission denied| 5\d\d |\bfail(ed|ure)?\b'

function Normalize([string]$line) {
  $s = $line
  # strip common timestamp prefixes (docker --timestamps, syslog, ISO)
  $s = $s -replace '^\d{4}-\d{2}-\d{2}T[0-9:\.\+\-Z]+ ?', ''
  $s = $s -replace '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:[.,]\d+)? ?', ''
  $s = $s -replace '^[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} ?', ''
  # strip ids / numbers / addresses so variants collapse
  $s = $s -replace '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<uuid>'
  $s = $s -replace '\b[0-9a-f]{12,64}\b', '<hex>'
  $s = $s -replace '\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b', '<ip>'
  $s = $s -replace '\b\d+\b', '<n>'
  $s = $s -replace '\s+', ' '
  return $s.Trim()
}

if (-not (Test-Path $LogsDir)) {
  Write-Host "logs dir not found: $LogsDir" -ForegroundColor Yellow
  Write-Host "run pull-docker-logs.ps1 first."
  exit 2
}

$files = @(Get-ChildItem $LogsDir -Recurse -File -Filter *.log -ErrorAction SilentlyContinue)
if ($Hours -gt 0) {
  $cut = (Get-Date).AddHours(-$Hours)
  $files = @($files | Where-Object { $_.LastWriteTime -ge $cut })
}
if ($files.Count -eq 0) { Write-Host "no .log files found (Hours=$Hours)" -ForegroundColor Yellow; exit 0 }

$clusters = @{}
$totalLines = 0
$totalErr = 0
$perSource = @{}

foreach ($f in $files) {
  $source = $f.Directory.Name + '/' + ($f.Name -replace '\.\d{8}-\d{6}\.log$', '')
  if (-not $perSource.ContainsKey($source)) { $perSource[$source] = @{ Lines = 0; Errors = 0 } }

  $lines = @(Get-Content -Path $f.FullName -Encoding UTF8)
  $totalLines += $lines.Count
  $perSource[$source].Lines += $lines.Count

  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = [string]$lines[$i]
    if ($line -notmatch $errPattern) { continue }
    $totalErr++
    $perSource[$source].Errors++

    $fp = Normalize $line
    if ($fp.Length -gt 220) { $fp = $fp.Substring(0, 220) }

    if (-not $clusters.ContainsKey($fp)) {
      $clusters[$fp] = [pscustomobject]@{
        Count   = 0
        First   = $line
        Last    = $line
        Sources = @{}
        Samples = New-Object System.Collections.Generic.List[string]
      }
    }
    $c = $clusters[$fp]
    $c.Count++
    $c.Last = $line
    if (-not $c.Sources.ContainsKey($source)) { $c.Sources[$source] = 0 }
    $c.Sources[$source] = $c.Sources[$source] + 1

    if ($c.Samples.Count -lt $Samples) {
      $ctx = New-Object System.Collections.Generic.List[string]
      $ctx.Add($line)
      $maxCtx = [Math]::Min($lines.Count - 1, $i + 4)
      for ($j = $i + 1; $j -le $maxCtx; $j++) { $ctx.Add('    ' + [string]$lines[$j]) }
      $c.Samples.Add(($ctx -join "`n"))
    }
  }
}

$rows = @($clusters.GetEnumerator() | ForEach-Object {
  $v = $_.Value
  $srcSummary = ($v.Sources.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 3 | ForEach-Object { "$($_.Key) x$($_.Value)" }) -join ', '
  [pscustomobject]@{
    Count   = $v.Count
    Sources = $srcSummary
    Message = $_.Key
    Samples = $v.Samples
    First   = $v.First
    Last    = $v.Last
  }
} | Sort-Object Count -Descending)

$topRows = @($rows | Select-Object -First $Top)

# --- console digest (this is what goes into the model context) ---------------
Write-Host ''
Write-Host ("=== log digest: {0} files, {1} lines, {2} error-ish lines, {3} distinct fingerprints ===" -f $files.Count, $totalLines, $totalErr, $rows.Count)
Write-Host ''
Write-Host '--- per source ---'
$perSource.GetEnumerator() | Sort-Object { $_.Value.Errors } -Descending | ForEach-Object {
  Write-Host ("  {0,-40} lines={1,-8} errors={2}" -f $_.Key, $_.Value.Lines, $_.Value.Errors)
}
Write-Host ''
Write-Host '--- top fingerprints ---'
$idx = 0
foreach ($r in $topRows) {
  $idx++
  Write-Host ("[{0}] x{1}  {2}" -f $idx, $r.Count, $r.Message)
  Write-Host ("     sources: {0}" -f $r.Sources)
  if ($r.Samples.Count -gt 0) { Write-Host ("     sample : " + ($r.Samples[0] -split "`n")[0]) }
}

if ($OutMarkdown -ne '') {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine("# Log digest $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine(("- files: {0} / lines: {1} / error-ish: {2} / fingerprints: {3}" -f $files.Count, $totalLines, $totalErr, $rows.Count))
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('| # | count | sources | message |')
  [void]$sb.AppendLine('|---|---|---|---|')
  $k = 0
  foreach ($r in $topRows) {
    $k++
    $m = $r.Message -replace '\|', '\|'
    [void]$sb.AppendLine(("| {0} | {1} | {2} | ``{3}`` |" -f $k, $r.Count, ($r.Sources -replace '\|', '\|'), $m))
  }
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('## samples')
  $k = 0
  foreach ($r in $topRows) {
    $k++
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine(("### [{0}] x{1} - {2}" -f $k, $r.Count, $r.Message))
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('```')
    [void]$sb.AppendLine($r.Samples[0])
    [void]$sb.AppendLine('```')
  }
  $dir = Split-Path -Parent $OutMarkdown
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($OutMarkdown, $sb.ToString(), $utf8NoBom)
  Write-Host ''
  Write-Host ("markdown written: {0}" -f $OutMarkdown)
}