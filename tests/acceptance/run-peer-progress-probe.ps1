param(
    [Parameter(Mandatory = $true)][string] $PeerSource,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string] $SourceSha,
    [Parameter(Mandatory = $true)][string] $Fixture,
    [Parameter(Mandatory = $true)][string] $ScratchDirectory,
    [switch] $Offline
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $PeerSource).Path
$scratch = (Resolve-Path -LiteralPath $ScratchDirectory).Path
$fixtureFile = (Resolve-Path -LiteralPath $Fixture).Path
if (Test-Path -LiteralPath (Join-Path $root '.git')) {
    $current = (git -C $root rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $current -ne $SourceSha) { throw 'The peer checkout has a different SHA' }
    $relevantChanges = git -C $root status --porcelain -- Cargo.toml Cargo.lock crates/peers crates/transfer
    if ($LASTEXITCODE -ne 0 -or $relevantChanges) { throw 'The peer checkout has unrecorded benchmark inputs' }
}

function Get-NearestRank($Values, $Percentile) {
    $ordered = @($Values | Sort-Object)
    $index = [int][Math]::Ceiling($ordered.Count * $Percentile) - 1
    $ordered[$index]
}

$settings = @{
    TEMP = $scratch
    TMP = $scratch
    CARGO_HOME = Join-Path $scratch 'cargo-cache'
    CARGO_PROFILE_DEV_DEBUG = '0'
    CARGO_INCREMENTAL = '0'
    AERIFT_VALIDATION_PEER_ROOT = $root
}
$original = @{}
foreach ($name in $settings.Keys) {
    $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process')
}
try {
    $target = Join-Path $scratch 'peer-demo-target'
    $output = Join-Path $scratch ('aerift-peer-progress-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($output) | Out-Null
    $cargo = (rustup which cargo).Trim()
    $rustc = (rustup which rustc).Trim()
    $cargoArguments = @('build', '--locked', '--manifest-path', (Join-Path $root 'Cargo.toml'),
        '-p', 'aerift-peers', '--example', 'loopback_node', '--message-format=json', '--target-dir', $target)
    if ($Offline) { $cargoArguments += '--offline' }
    $messages = & $cargo @cargoArguments
    if ($LASTEXITCODE -ne 0) { throw 'Locked peer build failed' }
    $libraries = @{}
    foreach ($message in $messages) {
        $artifact = $message | ConvertFrom-Json
        if ($artifact.reason -ne 'compiler-artifact') { continue }
        $library = $artifact.filenames | Where-Object { $_.EndsWith('.rlib') } | Select-Object -First 1
        if ($library) { $libraries[$artifact.target.name] = $library }
    }
    $exe = Join-Path $output 'peer-progress-probe.exe'
    $driver = Join-Path $PSScriptRoot 'peer-progress-probe.rs'
    $compile = @('--edition=2024', '-L', ('dependency=' + (Join-Path $target 'debug/deps')), '-o', $exe, $driver)
    foreach ($dependency in @('aerift_peers','aerift_transfer','tokio','tokio_util','tempfile','serde_json','sha2')) {
        if (!$libraries.ContainsKey($dependency)) { throw "Missing locked library $dependency" }
        $compile += @('--extern', ("$dependency=" + $libraries[$dependency]))
    }
    & $rustc @compile
    if ($LASTEXITCODE -ne 0) { throw 'Progress probe compile failed' }
    $lines = & $exe $fixtureFile $scratch
    if ($LASTEXITCODE -ne 0) { throw 'Progress probe failed' }
    $utf8 = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllLines((Join-Path $output 'trials.jsonl'), [string[]]$lines, $utf8)
    $measurements = @($lines | ConvertFrom-Json | Where-Object { !$_.warmup })
    $pairs = @(foreach ($pair in $measurements | Group-Object pair) {
        $forwarded = @($pair.Group | Where-Object forwarding)
        $baseline = @($pair.Group | Where-Object { !$_.forwarding })
        if ($forwarded.Count -ne 1 -or $baseline.Count -ne 1 -or $forwarded[0].sha256 -ne $baseline[0].sha256) {
            throw 'Missing paired measurement or inconsistent data'
        }
        $on = $forwarded[0]
        $off = $baseline[0]
        [pscustomobject]@{
            pair = $pair.Name
            extraTimedCallbackNs = $on.meanTimedCallbackNs - $off.meanTimedCallbackNs
            elapsedDifferenceMs = $on.firstProgressToConfirmationMs - $off.firstProgressToConfirmationMs
            baselineMiBPerSecond = $off.bytesAfterFirstProgress / 1048576 / ($off.firstProgressToConfirmationMs / 1000)
            forwardedMiBPerSecond = $on.bytesAfterFirstProgress / 1048576 / ($on.firstProgressToConfirmationMs / 1000)
        }
    })
    if ($pairs.Count -ne 5) { throw 'Expected five retained pairs' }
    $summary = [pscustomobject]@{
        sourceSha = $SourceSha
        lockSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root 'Cargo.lock')).Hash.ToLowerInvariant()
        probeSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
        retainedPairs = $pairs.Count
        payloadBytes = (Get-Item -LiteralPath $fixtureFile).Length
        payloadSha256 = $measurements[0].sha256
        invitationToConsentP50Ms = Get-NearestRank $measurements.invitationToConsentMs 0.5
        extraTimedCallbackP50Ns = Get-NearestRank $pairs.extraTimedCallbackNs 0.5
        extraTimedCallbackP95Ns = Get-NearestRank $pairs.extraTimedCallbackNs 0.95
        pairedElapsedP50Ms = Get-NearestRank $pairs.elapsedDifferenceMs 0.5
        baselineP50MiBPerSecond = Get-NearestRank $pairs.baselineMiBPerSecond 0.5
        forwardedP50MiBPerSecond = Get-NearestRank $pairs.forwardedMiBPerSecond 0.5
        pairs = $pairs
    }
    $summaryJson = $summary | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText((Join-Path $output 'summary.json'), $summaryJson, $utf8)
    $summaryJson
    Write-Host "Progress receipts in $output"
} finally {
    foreach ($name in $original.Keys) {
        [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process')
    }
}
