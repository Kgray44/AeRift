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
        $lit = 0
        for ($y = 0; $y -lt $actual.Height; $y++) {
            for ($x = 0; $x -lt $actual.Width; $x++) {
                $a = $actual.GetPixel($x, $y)
                $b = $expected.GetPixel($x, $y)
                $delta += [Math]::Abs($a.R - $b.R) + [Math]::Abs($a.G - $b.G) + [Math]::Abs($a.B - $b.B)
                if ($a.B -gt 140) { $lit++ }
            }
        }
        $mean = $delta / (3 * $actual.Width * $actual.Height)
        if ($mean -gt 5 -or $lit -eq 0) { throw "Windows shell icon does not match the approved source: $path (mean delta $mean)" }
        Write-Host "Verified AeRift Windows shell icon: $([IO.Path]::GetFileName($path)), $($actual.Width)x$($actual.Height)"
    } finally {
        $expected.Dispose()
        $actual.Dispose()
        $source.Dispose()
        $actualIcon.Dispose()
    }
}
