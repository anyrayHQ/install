# The half of the install guard that needs REAL Windows.
#
# ci/test-connect-install.ps1 covers the helper's retry, rollback, naming and
# messaging, but it runs on Linux — where renaming and unlinking a running
# binary is simply allowed — so it shadows `Rename-Item` and cannot prove the
# one OS behaviour the whole approach rests on: that Windows refuses to
# OVERWRITE a loaded image but permits RENAMING it aside. That is the property
# the customer-visible bug came from, so it gets a real Windows runner.
#
# Six cases. Case 0 is the control: overwriting a running image must FAIL here.
# If it succeeds, this host does not lock loaded images and every verdict below
# is meaningless — the script fails rather than report a green table of
# nonsense. Case 1 reproduces the shipped bug, so a future Windows or
# PowerShell change that quietly fixes it is noticed here instead of assumed.
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
New-Item -ItemType Directory -Path $binDir -Force | Out-Null

$failures = [System.Collections.Generic.List[string]]::new()
function Check {
  param([string] $Case, [bool] $Pass, [string] $Detail)
  $verdict = if ($Pass) { 'PASS' } else { 'FAIL'; }
  Write-Host ("  [{0}] {1} - {2}" -f $verdict, $Case, $Detail)
  if (-not $Pass) { $failures.Add($Case) }
}

# A real PE we can run and hold open. A copy of powershell.exe rather than a
# compiled stub: it needs no toolchain, and only a genuine loaded image takes
# the lock this file exists to measure.
$stub = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $stub)) { throw "no powershell.exe at $stub to use as a test image" }

$live = $null
try {
  $bin = Join-Path $binDir 'anyray-connect.exe'
  Copy-Item -LiteralPath $stub -Destination $bin -Force

  # Hold it open the way a hook, the MCP server or the tray would.
  $live = Start-Process -FilePath $bin -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 300' -PassThru
  Start-Sleep -Seconds 3
  if ($live.HasExited) { throw 'the test image exited before the run started' }

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
  $ran = $false
  $detail = ''
  try {
    $out = & $bin -NoProfile -Command 'Write-Output anyray-ok'
    $ran = "$out".Trim() -eq 'anyray-ok'
    $detail = "executed, output: $out"
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
  if ($live -and -not $live.HasExited) { $live.Kill() }
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
