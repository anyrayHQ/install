[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [Parameter(Mandatory = $false)]
  [string]$ExpectedOrganization = 'Othentic Labs LTD'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$artifact = Get-Item -LiteralPath $Path
if ($artifact.PSIsContainer) {
  throw "Expected a signed artifact file, got directory: $($artifact.FullName)"
}

$signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Authenticode verification failed for $($artifact.Name): $($signature.Status) ($($signature.StatusMessage))"
}

if ($null -eq $signature.SignerCertificate) {
  throw "Authenticode verification returned no signer certificate for $($artifact.Name)"
}

$expected = [regex]::Escape($ExpectedOrganization)
if ($signature.SignerCertificate.Subject -notmatch "(?:^|,\s*)O=$expected(?:,|$)") {
  throw "Unexpected Authenticode publisher for $($artifact.Name): $($signature.SignerCertificate.Subject)"
}

if ($null -eq $signature.TimeStamperCertificate) {
  throw "Authenticode signature for $($artifact.Name) is not timestamped"
}

$timestampExpiry = $signature.TimeStamperCertificate.NotAfter.ToUniversalTime()
if ($timestampExpiry -le [DateTime]::UtcNow) {
  throw "Timestamp certificate for $($artifact.Name) expired at $timestampExpiry"
}

Write-Host "Verified Authenticode signature for $($artifact.Name)"
Write-Host "Publisher: $($signature.SignerCertificate.Subject)"
Write-Host "Timestamp authority: $($signature.TimeStamperCertificate.Subject)"
