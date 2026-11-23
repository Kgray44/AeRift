param(
    [Parameter(Mandatory = $true)][string] $Executable,
    [Parameter(Mandatory = $true)][string] $ScratchDirectory,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string] $SourceSha
)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $Executable).Path
$scratch = (Resolve-Path -LiteralPath $ScratchDirectory).Path
$root = Join-Path $scratch ('aerift-peer-permission-' + [Guid]::NewGuid().ToString('N'))
$destination = Join-Path $root 'receive'
[IO.Directory]::CreateDirectory($destination) | Out-Null
$probe = Join-Path $destination 'write-probe.bin'
$original = Get-Acl -LiteralPath $destination
$blocked = Get-Acl -LiteralPath $destination
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    $deny = [Security.AccessControl.FileSystemAccessRule]::new(
        $identity.User, [Security.AccessControl.FileSystemRights]::CreateFiles,
        [Security.AccessControl.AccessControlType]::Deny
    )
    $blocked.AddAccessRule($deny)
} finally {
    $identity.Dispose()
}
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
try {
    $env:TEMP = $root
    $env:TMP = $root
    Set-Acl -LiteralPath $destination -AclObject $blocked
    try {
        [IO.File]::WriteAllBytes($probe, [byte[]](1))
        throw 'The scratch directory did not enforce write denial'
    } catch [UnauthorizedAccessException] {
        # Confirm the denial using the same account as the Rust receiver.
    }
    $driver = Join-Path $PSScriptRoot 'validate-peer-demo.mjs'
    $raw = node $driver $exe $root $SourceSha windows-permission $destination
    if ($LASTEXITCODE -ne 0) { throw 'The peer permission check failed' }
} finally {
    try {
        Set-Acl -LiteralPath $destination -AclObject $original
    } finally {
        $env:TEMP = $previousTemp
        $env:TMP = $previousTmp
    }
}
[IO.File]::WriteAllBytes($probe, [byte[]](1))
Remove-Item -LiteralPath $probe
$receipt = ($raw | Out-String) | ConvertFrom-Json
$summary = [pscustomobject]@{
    sourceSha = $receipt.sourceSha
    executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
    invalidDestinationsRejected = @('missing', 'regular-file')
    windowsWriteDenialVerified = $true
    destinationAclRestored = $true
    transfer = $receipt.receipts[0]
}
$json = $summary | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $root 'receipt.json'), $json, [Text.UTF8Encoding]::new($false))
$json
Write-Host "Permission receipt in $root"
