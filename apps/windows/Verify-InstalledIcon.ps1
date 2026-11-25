param(
    [Parameter(Mandatory)][string[]] $Executable,
    [Parameter(Mandatory)][string] $SourceIco
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
foreach ($path in $Executable) {
    $actualIcon = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path -LiteralPath $path).Path)
    if ($null -eq $actualIcon) { throw "No Windows shell icon: $path" }
    $source = [System.Drawing.Icon]::new((Resolve-Path -LiteralPath $SourceIco).Path, $actualIcon.Size)
    $actual = $actualIcon.ToBitmap()
    $expected = $source.ToBitmap()
    try {
        if ($actual.Size -ne $expected.Size) { throw "Unexpected Windows icon size: $path" }
        $delta = 0
        $alphaDelta = 0
        $clear = 0
        $lit = 0
        for ($y = 0; $y -lt $actual.Height; $y++) {
            for ($x = 0; $x -lt $actual.Width; $x++) {
                $a = $actual.GetPixel($x, $y)
                $b = $expected.GetPixel($x, $y)
                $alphaDelta += [Math]::Abs($a.A - $b.A)
                if ($a.A -eq 0) { $clear++ }
                $delta += ([Math]::Abs($a.R * $a.A - $b.R * $b.A) +
                    [Math]::Abs($a.G * $a.A - $b.G * $b.A) +
                    [Math]::Abs($a.B * $a.A - $b.B * $b.A)) / 255
                if ($a.B -gt 140 -and $a.A -gt 0) { $lit++ }
            }
        }
        $mean = $delta / (3 * $actual.Width * $actual.Height)
        $alphaMean = $alphaDelta / ($actual.Width * $actual.Height)
        if ($mean -gt 5 -or $alphaMean -gt 5 -or $clear -eq 0 -or $lit -eq 0) { throw "Windows shell icon does not match the approved source: $path (mean delta $mean)" }
        Write-Host "Verified AeRift Windows shell icon: $([IO.Path]::GetFileName($path)), $($actual.Width)x$($actual.Height)"
    } finally {
        $expected.Dispose()
        $actual.Dispose()
        $source.Dispose()
        $actualIcon.Dispose()
    }
}
