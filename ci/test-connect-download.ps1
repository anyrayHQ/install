# PowerShell half of ci/test-connect-download.sh — see that file for what each
# case proves. Driven from there, against its stub server.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string] $ConnectPs1)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$base = $env:ANYRAY_TEST_BASE
$want = $env:ANYRAY_TEST_WANT
if (-not $base -or -not $want) { throw 'ANYRAY_TEST_BASE and ANYRAY_TEST_WANT must be set' }

# Lift the helpers out of the shipped installer, so this cannot drift from it.
$src = Get-Content $ConnectPs1 -Raw
foreach ($name in 'Get-AnyrayDownload', 'Get-AnyrayPointerTag', 'Get-AnyrayBases', 'Get-AnyrayRelease') {
  $match = [regex]::Match($src, "(?ms)^function $name \{.*?\r?\n\}\r?\n")
  if (-not $match.Success) { throw "$name not found in connect.ps1" }
  Invoke-Expression $match.Value
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("anyray-dl-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  function Assert-Bytes {
    param([string] $Case, [string] $Path)
    $got = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
    if ($got -ne $want.ToLower()) { throw "ps case ${Case}: downloaded bytes do not verify" }
  }

  $a = Join-Path $work 'a.bin'
  Get-AnyrayDownload -Uri "$base/ranged" -OutFile $a
  Assert-Bytes '1 (resume across drops)' $a

  $b = Join-Path $work 'b.bin'
  Get-AnyrayDownload -Uri "$base/norange" -OutFile $b
  Assert-Bytes '2 (restart when Range ignored)' $b

  $threw = $false
  try { Get-AnyrayDownload -Uri "$base/dead" -OutFile (Join-Path $work 'c.bin') -Attempts 2 }
  catch { $threw = $true }
  if (-not $threw) { throw 'ps case 3: returned success on a transfer that never completed' }

  # 4. The file on disk is already the whole asset, so the resume asks for a
  # range past the end (416). That must be accepted, not retried to exhaustion.
  Get-AnyrayDownload -Uri "$base/ranged" -OutFile $a
  Assert-Bytes '4 (already complete, 416)' $a

  Write-Host 'connect.ps1 download: 4/4 cases OK'

  # Release hosts (ANY-2024): see test-connect-download.sh for each case.
  $releaseWant = $env:ANYRAY_TEST_RELEASE_WANT
  $log = $env:ANYRAY_TEST_LOG
  $closed = 'http://127.0.0.1:1'
  function Get-Asked([string] $Prefix) { @(Get-Content -LiteralPath $log | Where-Object { $_.StartsWith($Prefix) }).Count }
  function Clear-Asked { Set-Content -LiteralPath $log -Value $null }
  $dl = Join-Path $work 'anyray-connect.exe'
  $sums = Join-Path $work 'SHA256SUMS'
  $asset = 'anyray-connect-test'
  function Assert-Release([string] $Case) {
    $got = (Get-FileHash -Algorithm SHA256 -Path $dl).Hash.ToLower()
    if ($got -ne $releaseWant.ToLower()) { throw "ps hosts ${Case}: wrong bytes" }
  }

  if ((Get-AnyrayPointerTag -Mirror "$base/up") -ne 'connect-v1.2.3') { throw "ps hosts pointer: the mirror's latest.json was not read" }
  foreach ($unanswered in $closed, "$base/missing") {
    if (Get-AnyrayPointerTag -Mirror $unanswered) { throw "ps hosts pointer: an unanswered pointer ($unanswered) named a release" }
  }
  $threw = $false
  try { Get-AnyrayPointerTag -Mirror "$base/bad" | Out-Null } catch { $threw = $true }
  if (-not $threw) { throw 'ps hosts pointer: a malformed pointer was accepted' }

  $order = @(Get-AnyrayBases -Tag 'connect-v1.2.3' -Mirror 'https://mirror.invalid/dl' -GithubDownload 'https://github.invalid/releases/download' -Repo 'owner/repo')
  if (($order -join ' ') -ne 'https://mirror.invalid/dl/connect-v1.2.3 https://github.invalid/releases/download/connect-v1.2.3') {
    throw 'ps hosts order: a known tag is not tried on the mirror first, then GitHub'
  }
  $order = @(Get-AnyrayBases -Tag '' -Mirror 'https://mirror.invalid/dl' -GithubDownload 'https://github.invalid/releases/download' -Repo 'owner/repo' 6>$null)
  if (($order -join ' ') -ne 'https://github.com/owner/repo/releases/latest/download') {
    throw "ps hosts order: an unanswered pointer does not leave GitHub's latest"
  }

  Clear-Asked
  $from = Get-AnyrayRelease -Bases "$base/m/connect-v1.2.3", "$base/g/connect-v1.2.3" -Mirror "$base/m" -Asset $asset -OutFile $dl -SumsFile $sums
  if ($from -ne "$base/m/connect-v1.2.3") { throw "ps hosts mirror: installed from $from" }
  Assert-Release 'mirror'
  if ((Get-Asked '/g/') -ne 0) { throw 'ps hosts mirror: GitHub was asked while the mirror answered' }

  Clear-Asked
  $from = Get-AnyrayRelease -Bases "$closed/connect-v1.2.3", "$base/g/connect-v1.2.3" -Mirror $closed -Asset $asset -OutFile $dl -SumsFile $sums
  if ($from -ne "$base/g/connect-v1.2.3") { throw "ps hosts down: installed from $from" }
  Assert-Release 'down'

  Clear-Asked
  $from = Get-AnyrayRelease -Bases "$base/n/connect-v1.2.3", "$base/g/connect-v1.2.3" -Mirror "$base/n" -Asset $asset -OutFile $dl -SumsFile $sums
  if ($from -ne "$base/g/connect-v1.2.3") { throw "ps hosts partial: installed from $from" }
  if ((Get-Asked '/g/connect-v1.2.3/SHA256SUMS') -ne 1) { throw 'ps hosts partial: the asset and its checksum came from different hosts' }
  Assert-Release 'partial'

  Clear-Asked
  $from = Get-AnyrayRelease -Bases "$base/t/connect-v1.2.3", "$base/g/connect-v1.2.3" -Mirror "$base/t" -Asset $asset -OutFile $dl -SumsFile $sums
  if ($from -ne "$base/t/connect-v1.2.3") { throw "ps hosts tamper: fell back to $from" }
  if ((Get-Asked '/g/') -ne 0) { throw 'ps hosts tamper: altered bytes sent the installer to GitHub' }

  $threw = $false
  try { Get-AnyrayRelease -Bases "$closed/connect-v1.2.3", "$closed/github" -Mirror $closed -Asset $asset -OutFile $dl -SumsFile $sums | Out-Null } catch { $threw = $true }
  if (-not $threw) { throw 'ps hosts none: reported success with no host answering' }

  Write-Host 'connect.ps1 release hosts: 7/7 cases OK'
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
