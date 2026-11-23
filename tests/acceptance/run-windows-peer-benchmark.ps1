param(
    [Parameter(Mandatory = $true)][string] $Executable,
    [Parameter(Mandatory = $true)][string] $ScratchDirectory,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string] $SourceSha,
    [ValidateRange(1, 20)][int] $Trials = 5
)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $Executable).Path
$scratch = (Resolve-Path -LiteralPath $ScratchDirectory).Path
$env:TEMP = $scratch
$env:TMP = $scratch
$receiptDir = Join-Path $scratch ('aerift-peer-benchmark-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($receiptDir) | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
$exeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
$driver = Join-Path $PSScriptRoot 'validate-peer-demo.mjs'
$results = foreach ($trial in 1..$Trials) {
    $raw = node $driver $exe $scratch $SourceSha windows-benchmark
    if ($LASTEXITCODE -ne 0) { throw "Receiver benchmark trial $trial failed" }
    $json = $raw | Out-String
    $receipt = $json | ConvertFrom-Json
    [IO.File]::WriteAllText((Join-Path $receiptDir "trial-$trial.json"), $json, $utf8)
    $receipt.receipts[0]
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant() -ne $exeHash) {
    throw 'The peer executable changed during the series'
}

function Get-NearestRank($Values, $Percentile) {
    $ordered = @($Values | Sort-Object)
    $index = [int][Math]::Ceiling($ordered.Count * $Percentile) - 1
    $ordered[$index]
}

$summary = [pscustomobject]@{
    sourceSha = $SourceSha
    executableSha256 = $exeHash
    retainedTrials = $Trials
    payloadBytes = 67108864
    senderPeakWorkingSetP50Bytes = Get-NearestRank $results.senderPeakWorkingSetBytes 0.5
    senderPeakWorkingSetP95Bytes = Get-NearestRank $results.senderPeakWorkingSetBytes 0.95
    receiverPeakWorkingSetP50Bytes = Get-NearestRank $results.receiverPeakWorkingSetBytes 0.5
    receiverPeakWorkingSetP95Bytes = Get-NearestRank $results.receiverPeakWorkingSetBytes 0.95
    receiverWriteAndPublishP50Ms = Get-NearestRank $results.receiverWriteAndPublishMs 0.5
    receiverWriteAndPublishP95Ms = Get-NearestRank $results.receiverWriteAndPublishMs 0.95
    receiverEffectiveP50MiBPerSecond = Get-NearestRank $results.receiverEffectiveMiBPerSecond 0.5
    trials = @($results)
}
$json = $summary | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $receiptDir 'summary.json'), $json, $utf8)
$json
Write-Host "Benchmark receipts in $receiptDir"
