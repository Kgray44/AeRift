[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory=$true)][string]$FixtureExecutable,
  [Parameter(Mandatory=$true)][switch]$GuestIsolationAttested
)
$ErrorActionPreference = 'Stop'
if (!$GuestIsolationAttested) { throw 'Require management-plane evidence of a disposable guest with no virtual network adapter.' }
if (Get-NetAdapter -IncludeHidden | Where-Object { $_.Status -eq 'Up' }) { throw 'An active adapter was found; refusing to start.' }
if (Get-NetRoute | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0', '::/0') }) { throw 'A default route was found; refusing to start.' }
$file = Get-Item -LiteralPath $FixtureExecutable
if ($file.PSIsContainer -or $file.Extension -ne '.exe' -or $file.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
  throw 'Expected a sealed native fixture executable.'
}
if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne $ExpectedSha256) {
  throw 'Fixture hash does not match the trusted build receipt.'
}
$env:AERIFT_ISOLATED_WEBVIEW_FIXTURE = '1'
try {
  $child = Start-Process -FilePath $file.FullName -ArgumentList @(
      'native_closed_fixture_has_no_bridge_and_denies_unlisted_resource', '--ignored', '--exact', '--test-threads=1'
    ) -PassThru -NoNewWindow
  if (!$child.WaitForExit(45000)) {
    $child.Kill()
    throw 'Native fixture exceeded its 45-second watchdog; discard the guest.'
  }
  if ($child.ExitCode -ne 0) { throw "Native fixture failed with exit code $($child.ExitCode)." }
} finally {
  Remove-Item Env:\AERIFT_ISOLATED_WEBVIEW_FIXTURE -ErrorAction SilentlyContinue
}
