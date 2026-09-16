# The half of the install guard that needs REAL Windows.
#
# ci/test-connect-install.ps1 covers the helper's retry, rollback, naming and
# messaging, but it runs on Linux — where renaming and unlinking a running
# binary is simply allowed — so it shadows `Rename-Item` and cannot prove the
# one OS behaviour the whole approach rests on: that Windows refuses to
# OVERWRITE a loaded image but permits RENAMING it aside. That is the property
# the customer-visible bug came from, so it gets a real Windows runner.
#
# Seven cases. Case 0 is the control: overwriting a running image must FAIL
# here. If it succeeds, this host does not lock loaded images and every verdict
# below is meaningless — the script fails rather than report a green table of
# nonsense. Case 1 reproduces the shipped bug, so a future Windows or
# PowerShell change that quietly fixes it is noticed here instead of assumed.
#
# The test image is a copy of ping.exe, NOT of powershell.exe. A renamed script
# host carries the whole PowerShell startup path with it — $PSHOME lands in a
# temp directory with no powershell.exe.config and no Modules — and is also the
# textbook masquerading signature, so it has two ways to die that have nothing
# to do with what this file measures. It took one of them on 2026-09-16, exiting
# within three seconds and failing the job on its second ever run. ping.exe is a
# self-contained PE with no side files and no CLR: it holds the image lock the
# same way, `-t` keeps it resident until killed, and it keeps looping even where
# ICMP is unavailable.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string] $ConnectPs1)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Lift the helper out of the shipped installer, so this cannot drift from it.
$src = Get-Content $ConnectPs1 -Raw
$match = [regex]::Match($src, '(?ms)^function Install-AnyrayBinary \{.*?\r?\n\}\r?\n')
if (-not $match.Success) { throw 'Install-AnyrayBinary not found in connect.ps1' }
Invoke-Expression $match.Value

$work = Join-Path $env:TEMP ("anyray-install-win-" + [guid]::NewGuid().ToString('N'))
$binDir = Join-Path $work 'bin'
$logDir = Join-Path $work 'logs'
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$failures = [System.Collections.Generic.List[string]]::new()
function Check {
  param([string] $Case, [bool] $Pass, [string] $Detail)
  $verdict = if ($Pass) { 'PASS' } else { 'FAIL' }
  Write-Host ("  [{0}] {1} - {2}" -f $verdict, $Case, $Detail)
  if (-not $Pass) { $failures.Add($Case) }
}

# Whatever a launch had to say about itself, in one line. Polled rather than
# read once: a redirect file is written by the CHILD, and the handle can still
# be closing when the parent observes the exit, so a single read races an
# already-finished process to empty. Callers that expect nothing pass -Settle 0.
function Get-StreamHead {
  param([string] $Path, [int] $SettleMs = 0)
  $deadline = (Get-Date).AddMilliseconds($SettleMs)
  do {
    if (Test-Path -LiteralPath $Path) {
      $text = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
      if (-not [string]::IsNullOrWhiteSpace($text)) {
        $flat = ($text -replace '\s+', ' ').Trim()
        if ($flat.Length -gt 200) { return $flat.Substring(0, 200) + '...' }
        return $flat
      }
    }
    if ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  } while ((Get-Date) -lt $deadline)
  if (-not (Test-Path -LiteralPath $Path)) { return '(no file)' }
  return '(empty)'
}

# Start the test image and prove it is resident before anything is measured
# against it. The version this replaces slept three seconds and then threw a
# bare string, so a launch failure reported nothing about itself and the job
# had to be re-run to learn anything. Capture the exit code and both streams,
# and give a slow or on-access-scanned start two more chances.
function Start-TestImage {
  param(
    [Parameter(Mandatory = $true)][string] $Path,
    [Parameter(Mandatory = $true)][string] $LogDir,
    [Parameter(Mandatory = $true)][string] $Tag
  )
  $details = [System.Collections.Generic.List[string]]::new()
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $out = Join-Path $LogDir "$Tag-$attempt.out"
    $err = Join-Path $LogDir "$Tag-$attempt.err"
    $p = Start-Process -FilePath $Path -ArgumentList '-t', '127.0.0.1' -PassThru -NoNewWindow `
      -RedirectStandardOutput $out -RedirectStandardError $err
    # An image that is going to fault does it in the first moments; past that
    # it is loaded and holding its own file.
    $settled = (Get-Date).AddSeconds(3)
    while ((Get-Date) -lt $settled -and -not $p.HasExited) { Start-Sleep -Milliseconds 250 }
    if (-not $p.HasExited) { return $p }

    $line = "attempt ${attempt}: exit $($p.ExitCode), stderr: $(Get-StreamHead $err), stdout: $(Get-StreamHead $out)"
    $details.Add($line)
    Write-Host "  [warn] $Tag exited before the run started - $line"
  }
  throw "the test image ($Tag) exited before the run started - $($details -join ' | ')"
}

$stub = Join-Path $env:SystemRoot 'System32\ping.exe'
if (-not (Test-Path -LiteralPath $stub)) { throw "no ping.exe at $stub to use as a test image" }

$live = $null
try {
  $bin = Join-Path $binDir 'anyray-connect.exe'
  Copy-Item -LiteralPath $stub -Destination $bin -Force

  # Hold it open the way a hook, the MCP server or the tray would.
  $live = Start-TestImage -Path $bin -LogDir $logDir -Tag 'held'

  # 0. control: a running image cannot be overwritten.
  $blocked = $false
  $detail = ''
  try {
    Copy-Item -LiteralPath $stub -Destination $bin -Force
    $detail = 'the overwrite SUCCEEDED - this host does not lock loaded images'
  } catch {
    $blocked = $true
    $detail = "refused as expected: $($_.Exception.GetType().Name)"
  }
  Check '0 control: a running image cannot be overwritten' $blocked $detail
  if (-not $blocked) { throw 'the control did not hold; the cases below would prove nothing' }

  # 1. the shipped bug, reproduced: this is what reached the customer.
  $dl = Join-Path $work 'download-1.exe'
  Copy-Item -LiteralPath $stub -Destination $dl -Force
  $oldWayFailed = $false
  $detail = ''
  try {
    Move-Item -Force -Path $dl -Destination $bin
    $detail = 'Move-Item -Force SUCCEEDED over a running image - the original bug no longer reproduces'
  } catch {
    $oldWayFailed = $true
    $detail = "Move-Item -Force failed: $($_.Exception.Message)"
  }
  Check '1 repro: Move-Item -Force fails over a running image' $oldWayFailed $detail

  # 2. the fix: the shipped helper replaces a RUNNING binary.
  $dl = Join-Path $work 'download-2.exe'
  Copy-Item -LiteralPath $stub -Destination $dl -Force
  $installed = $false
  $detail = ''
  try {
    Install-AnyrayBinary -Source $dl -Destination $bin
    $installed = (Test-Path -LiteralPath $bin) -and -not (Test-Path -LiteralPath $dl)
    $detail = if ($installed) { 'the running binary was replaced' } else { 'the helper returned but the destination is wrong' }
  } catch {
    $detail = "the helper threw: $($_.Exception.Message)"
  }
  Check '2 fix: the helper replaces a running image' $installed $detail

  # 3. renaming the file out from under a live process must not kill it: an
  # employee mid-session keeps working, new bytes take effect on next launch.
  $alive = -not $live.HasExited
  Check '3 the replaced process keeps running' $alive $(if ($alive) { "pid $($live.Id) still alive" } else { "pid $($live.Id) died during the swap" })

  # 4. the aside cannot be deleted while its image is loaded, so it must still
  # be on disk for the next install to sweep.
  $asides = @(Get-ChildItem -LiteralPath $binDir -File | Where-Object { $_.Name -like 'anyray-connect.exe.old-*' })
  Check '4 the held aside survives for the next sweep' ($asides.Count -eq 1) "$($asides.Count) aside(s) present"

  # 5. once the holder exits, the next install sweeps it — otherwise every
  # re-enrollment leaves another ~100 MB copy behind.
  $live.Kill()
  $live.WaitForExit(30000) | Out-Null
  Start-Sleep -Seconds 2
  $dl = Join-Path $work 'download-3.exe'
  Copy-Item -LiteralPath $stub -Destination $dl -Force
  Install-AnyrayBinary -Source $dl -Destination $bin
  $left = @(Get-ChildItem -LiteralPath $binDir -File | Where-Object { $_.Name -like 'anyray-connect.exe.old-*' -or $_.Name -like 'anyray-connect.exe.new-*' })
  Check '5 the freed aside is swept by the next install' ($left.Count -eq 0) "$($left.Count) file(s) left beside the binary"

  # 6. the swap produced a working PE, not a truncated or half-copied file.
  # Matched on the address echoed back, which is the one part of ping's output
  # no locale translates, and the exit code is ignored: a container that drops
  # ICMP still proves the image loaded and ran. Run through Start-Process with
  # the streams on disk rather than `& $bin ... 2>&1`, which turns a native
  # stderr line into an ErrorRecord that $ErrorActionPreference = 'Stop' would
  # make terminating.
  $ran = $false
  $detail = ''
  try {
    $out = Join-Path $logDir 'run.out'
    $err = Join-Path $logDir 'run.err'
    $p = Start-Process -FilePath $bin -ArgumentList '-n', '1', '127.0.0.1' -PassThru -NoNewWindow `
      -RedirectStandardOutput $out -RedirectStandardError $err
    if (-not $p.WaitForExit(30000)) { $p.Kill(); throw 'the installed binary did not exit within 30s' }
    # The timeout overload above returns as soon as the process is gone; only
    # the parameterless one also waits for the redirected streams to finish.
    # Without it this read the file mid-flush and scored a working binary as
    # broken (run 35075535460: "exit 0, stdout: (empty), stderr: (empty)").
    $p.WaitForExit()
    $text = Get-StreamHead -Path $out -SettleMs 5000
    $ran = $text -match '127\.0\.0\.1'
    $detail = "exit $($p.ExitCode), stdout: $text, stderr: $(Get-StreamHead $err)"
  } catch {
    $detail = "could not execute the installed binary: $($_.Exception.Message)"
  }
  Check '6 the installed binary executes' $ran $detail

  if ($failures.Count -ne 0) {
    throw "connect.ps1 install (Windows): $($failures.Count) case(s) failed - $($failures -join '; ')"
  }
  Write-Host 'connect.ps1 install (Windows): 7/7 cases OK'
}
finally {
  if ($live -and -not $live.HasExited) { $live.Kill(); $live.WaitForExit(10000) | Out-Null }
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
