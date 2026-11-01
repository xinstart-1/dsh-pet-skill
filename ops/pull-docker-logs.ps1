<#
  pull-docker-logs.ps1 - collect `docker logs` from Linux hosts over SSH.

  Why: on most Linux servers logs are not persisted to files; they live in the
  container's stdout/stderr, so `docker logs` is the only source and it is
  rotated/lost when the container is recreated. This script makes a durable,
  local copy you can grep, diff and analyse without touching the server.

  Read-only: it runs `docker ps`, `docker inspect` and `docker logs` only.
  Nothing on the remote host is modified.

  Usage:
    copy config.example.json to config.json, fill hosts, then
    powershell -NoProfile -ExecutionPolicy Bypass -File .\pull-docker-logs.ps1
    powershell ... -File .\pull-docker-logs.ps1 -OnlyHost app-01
    powershell ... -File .\pull-docker-logs.ps1 -DryRun      # print the remote script, no SSH
#>
param(
  [string]$Config = '',
  [string[]]$OnlyHost = @(),
  [switch]$DryRun,
  [int]$SshTimeoutSec = 15
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Config)) { $Config = (Join-Path $PSScriptRoot 'config.json') }

# --- UTF-8 in/out so Chinese log lines are not mangled -----------------------
$prevOut = $null
try { $prevOut = [Console]::OutputEncoding } catch { }
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Utf8([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

if (-not (Test-Path $Config)) {
  Write-Host "config not found: $Config" -ForegroundColor Red
  Write-Host "copy config.example.json -> config.json and fill in your hosts." -ForegroundColor Yellow
  exit 2
}

$cfg = Get-Content -Path $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$outDir = $cfg.outDir
if ([string]::IsNullOrWhiteSpace($outDir)) { $outDir = Join-Path $PSScriptRoot 'logs' }
$keepDays = 7
if ($null -ne $cfg.keepDays) { $keepDays = [int]$cfg.keepDays }

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$hosts = @($cfg.hosts)
if ($OnlyHost.Count -gt 0) { $hosts = @($hosts | Where-Object { $OnlyHost -contains $_.name }) }

if ($hosts.Count -eq 0) { Write-Host "no hosts selected" -ForegroundColor Yellow; exit 0 }

$remoteTemplate = @'
set -u
SINCE="__SINCE__"
TAIL="__TAIL__"
FILTER="__FILTER__"
echo "@@@HOST $(hostname 2>/dev/null || echo unknown)@@@"
echo "@@@DOCKER $(docker --version 2>&1 | head -1)@@@"
echo "@@@UPTIME $(uptime -p 2>/dev/null | tr -d '\n' || uptime | tr -d '\n')@@@"
echo "@@@LOAD $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)@@@"
echo "@@@MEM $(free -m 2>/dev/null | awk '/^Mem:/{print "total="$2"MB used="$3"MB avail="$7"MB"}')@@@"
echo "@@@DISK $(df -h 2>/dev/null | awk 'NR>1 && $5+0>=80 {print $6"="$5}' | head -5 | tr '\n' ' ')@@@"
echo "@@@OOM $(dmesg 2>/dev/null | grep -iE 'out of memory|killed process' | tail -3 | tr '\n' '|')@@@"
echo "@@@PS@@@"
docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}' 2>&1
if [ -n "$FILTER" ]; then CONTAINERS="$FILTER"; else CONTAINERS=$(docker ps -a --format '{{.Names}}' 2>/dev/null); fi
for c in $CONTAINERS; do
  echo "@@@INSPECT $c@@@"
  docker inspect -f 'restarts={{.RestartCount}} exit={{.ExitCode}} oom={{.State.OOMKilled}} status={{.State.Status}} started={{.State.StartedAt}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>&1
  echo "@@@LOGS $c@@@"
  docker logs --timestamps --since "$SINCE" --tail "$TAIL" "$c" 2>&1 | tail -n "$TAIL"
done
echo "@@@END@@@"
'@

$summary = @()

foreach ($h in $hosts) {
  $name = [string]$h.name
  $target = [string]$h.ssh
  $since = '3h'
  if ($h.since) { $since = [string]$h.since }
  $tail = 4000
  if ($h.tail) { $tail = [int]$h.tail }
  $filter = ''
  if ($h.containers -and @($h.containers).Count -gt 0) { $filter = (@($h.containers) -join ' ') }

  $remote = $remoteTemplate.Replace('__SINCE__', $since).Replace('__TAIL__', [string]$tail).Replace('__FILTER__', $filter)

  if ($DryRun) {
    Write-Host ("=== {0} ({1}) remote script ===" -f $name, $target) -ForegroundColor Cyan
    Write-Host $remote
    continue
  }

  Write-Host ("[{0}] ssh {1} : docker logs --since {2} (tail {3}) ..." -f $name, $target, $since, $tail) -ForegroundColor Cyan

  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($remote))
  $remoteCmd = "echo $b64 | base64 -d | bash -s"

  $sshArgs = @(
    '-o', 'BatchMode=yes',
    '-o', ("ConnectTimeout={0}" -f $SshTimeoutSec),
    '-o', 'StrictHostKeyChecking=accept-new',
    $target,
    $remoteCmd
  )

  $raw = ''
  try {
    $raw = (& ssh @sshArgs 2>&1 | Out-String)
  } catch {
    Write-Host ("[{0}] ssh failed: {1}" -f $name, $_.Exception.Message) -ForegroundColor Red
    $summary += [pscustomobject]@{ Host = $name; Containers = 0; Lines = 0; Errors = 0; Note = 'ssh failed' }
    continue
  }

  # --- split the framed output ------------------------------------------------
  $sections = @{}
  $meta = New-Object System.Collections.Generic.List[string]
  $curKey = ''
  $curContainer = ''
  $logs = @{}
  $insp = @{}

  foreach ($line in ($raw -split "`r?`n")) {
    if ($line -match '^@@@([A-Z]+)(?: (.+))?@@@$') {
      $curKey = $Matches[1]
      $curContainer = ''
      if ($Matches[2]) { $curContainer = $Matches[2] }
      if ($curKey -eq 'LOGS') { $logs[$curContainer] = New-Object System.Collections.Generic.List[string] }
      if ($curKey -eq 'INSPECT') { $insp[$curContainer] = New-Object System.Collections.Generic.List[string] }
      if ($curKey -eq 'PS') { $meta.Add('--- docker ps -a ---') }
      if ($curKey -eq 'END') { $curKey = '' }
      continue
    }
    switch ($curKey) {
      'HOST'   { $meta.Add('host      : ' + $line) }
      'DOCKER' { $meta.Add('docker    : ' + $line) }
      'UPTIME' { $meta.Add('uptime    : ' + $line) }
      'LOAD'   { $meta.Add('loadavg   : ' + $line) }
      'MEM'    { $meta.Add('memory    : ' + $line) }
      'DISK'   { $meta.Add('disk>=80% : ' + $line) }
      'OOM'    { $meta.Add('dmesg oom : ' + $line) }
      'PS'     { if ($line.Trim()) { $meta.Add('  ' + $line) } }
      'INSPECT'{ if ($curContainer -and $insp.ContainsKey($curContainer)) { $insp[$curContainer].Add($line) } }
      'LOGS'   { if ($curContainer -and $logs.ContainsKey($curContainer)) { $logs[$curContainer].Add($line) } }
      default  { }
    }
  }

  $hostDir = Join-Path $outDir $name
  Write-Utf8 (Join-Path $hostDir ('_host.' + $stamp + '.txt')) (($meta -join "`n") + "`n")

  $containerCount = 0
  $totalLines = 0
  $totalErrors = 0

  foreach ($c in $logs.Keys) {
    $containerCount++
    $body = @($logs[$c])
    $safe = ($c -replace '[^\w\.\-]', '_')
    $logPath = Join-Path $hostDir ($safe + '.' + $stamp + '.log')
    Write-Utf8 $logPath (($body -join "`n") + "`n")

    $errLines = @($body | Where-Object { $_ -match '(?i)\bERROR\b|Exception|Traceback|panic:|fatal|ECONNREFUSED|ECONNRESET|timeout|OOMKilled|out of memory| 5\d\d ' })
    $totalLines += $body.Count
    $totalErrors += $errLines.Count

    $note = 'ok'
    if ($insp.ContainsKey($c)) { $note = (@($insp[$c]) -join ' ').Trim() }
    Write-Host ("  {0,-28} lines={1,-6} err~{2,-5} {3}" -f $c, $body.Count, $errLines.Count, $note)
  }

  $summary += [pscustomobject]@{ Host = $name; Containers = $containerCount; Lines = $totalLines; Errors = $totalErrors; Note = 'ok' }
}

# --- prune -------------------------------------------------------------------
if (-not $DryRun -and (Test-Path $outDir) -and $keepDays -gt 0) {
  $cut = (Get-Date).AddDays(-$keepDays)
  Get-ChildItem $outDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cut } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

if (-not $DryRun) {
  Write-Host ''
  $summary | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
  Write-Host ("logs: {0}   (keep {1} days)" -f $outDir, $keepDays)
  Write-Host "next: run .\log-digest.ps1 to build a compact error digest for analysis."
}

if ($prevOut) { try { [Console]::OutputEncoding = $prevOut } catch { } }