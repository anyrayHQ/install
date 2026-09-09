# PowerShell half of ci/test-connect-download.sh — see that file for what each
# case proves. Driven from there, against its stub server.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string] $ConnectPs1)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$base = $env:ANYRAY_TEST_BASE
$want = $env:ANYRAY_TEST_WANT
if (-not $base -or -not $want) { throw 'ANYRAY_TEST_BASE and ANYRAY_TEST_WANT must be set' }

# Lift the helper out of the shipped installer, so this cannot drift from it.
$src = Get-Content $ConnectPs1 -Raw
$match = [regex]::Match($src, '(?ms)^function Get-AnyrayDownload \{.*?\r?\n\}\r?\n')
if (-not $match.Success) { throw 'Get-AnyrayDownload not found in connect.ps1' }
Invoke-Expression $match.Value

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
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
