param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int] $SenderId,
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int] $ReceiverId
)
$ErrorActionPreference = 'Stop'
$processIds = @($SenderId, $ReceiverId)
for ($sample = 0; $sample -lt 3000; $sample++) {
    $values = foreach ($id in $processIds) {
        try {
            $process = Get-Process -Id $id -ErrorAction Stop
            $process.PeakWorkingSet64
        } catch {
            if (Get-Process -Id $id -ErrorAction SilentlyContinue) { throw }
            0
        }
    }
    if ($values[0] -eq 0 -and $values[1] -eq 0) { exit 0 }
    [Console]::WriteLine(($values -join ','))
    Start-Sleep -Milliseconds 50
}
exit 2
