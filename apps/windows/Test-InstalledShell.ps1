$ErrorActionPreference = 'Stop'

function Invoke-Cdp {
    param($Socket, [int]$Id, [string]$Method, [hashtable]$Arguments, $Timeout)

    $request = @{ id = $Id; method = $Method; params = $Arguments } | ConvertTo-Json -Depth 8 -Compress
    $requestBytes = [Text.Encoding]::UTF8.GetBytes($request)
    $Socket.SendAsync([ArraySegment[byte]]::new($requestBytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $Timeout).GetAwaiter().GetResult() | Out-Null
    $buffer = [byte[]]::new(65536)
    do {
        $message = [IO.MemoryStream]::new()
        try {
            do {
                $part = $Socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $Timeout).GetAwaiter().GetResult()
                if ($part.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
                    throw 'WebView closed the debugging connection.'
                }
                $message.Write($buffer, 0, $part.Count)
            } until ($part.EndOfMessage)
            $response = [Text.Encoding]::UTF8.GetString($message.ToArray()) | ConvertFrom-Json
        } finally {
            $message.Dispose()
        }
    } until ($response.id -eq $Id)
    if ($response.error) {
        throw "$Method failed: $($response.error.message)"
    }
    return $response.result
}

$installerPath = Join-Path $PSScriptRoot '..\aerift\src-tauri\target\release\bundle\nsis'
$installers = @(Get-ChildItem -LiteralPath $installerPath -Filter '*-setup.exe')
if ($installers.Count -ne 1) { throw 'Expected exactly one NSIS installer.' }
$installer = $installers[0]
$evidence = Join-Path $env:RUNNER_TEMP 'aerift-evidence'
$installDirectory = Join-Path $env:RUNNER_TEMP 'AeRiftSmoke'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null

$install = Start-Process -FilePath $installer.FullName -ArgumentList "/S /D=$installDirectory" -Wait -PassThru -WindowStyle Hidden
if ($install.ExitCode -ne 0) { throw "NSIS exited with code $($install.ExitCode)." }

# Scope the local debugging endpoint to this disposable CI launch.
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
$process = Start-Process -FilePath (Join-Path $installDirectory 'aerift.exe') -PassThru -WindowStyle Hidden
$socket = [Net.WebSockets.ClientWebSocket]::new()
$deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(80))

try {
    $target = $null
    while (-not $deadline.IsCancellationRequested -and -not $target) {
        if ($process.HasExited) { throw "AeRift exited before launch verification ($($process.ExitCode))." }
        try {
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 2
            $target = $targets | Where-Object { $_.type -eq 'page' -and $_.url -match '^https?://tauri\.localhost' } | Select-Object -First 1
        } catch {
            Start-Sleep -Milliseconds 500
        }
        if (-not $target) { Start-Sleep -Milliseconds 250 }
    }
    if (-not $target) { throw 'AeRift WebView did not become available.' }

    $socket.ConnectAsync([uri]$target.webSocketDebuggerUrl, $deadline.Token).GetAwaiter().GetResult() | Out-Null
    $assertion = @{
        expression = "document.querySelector('h1')?.textContent === 'AeRift' && document.querySelector('main')?.textContent.includes('New transfer') && [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Choose a file' && !button.disabled)"
        returnByValue = $true
    }
    $id = 0
    do {
        $id += 1
        $launch = Invoke-Cdp $socket $id 'Runtime.evaluate' $assertion $deadline.Token
        if (-not $launch.result.value) { Start-Sleep -Milliseconds 250 }
    } until ($launch.result.value -or $deadline.IsCancellationRequested)
    if (-not $launch.result.value) { throw 'AeRift WebView did not render the launch screen.' }

    $image = Invoke-Cdp $socket ($id + 1) 'Page.captureScreenshot' @{ format = 'png'; fromSurface = $true } $deadline.Token
    $imageBytes = [Convert]::FromBase64String($image.data)
    if ($imageBytes.Length -lt 100) { throw 'WebView returned an empty screenshot.' }
    [IO.File]::WriteAllBytes((Join-Path $evidence 'windows-launch.png'), $imageBytes)
    $id += 2
    $settings = Invoke-Cdp $socket $id 'Runtime.evaluate' @{
        expression = "[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Settings').click()"
        returnByValue = $true
    } $deadline.Token
    if ($settings.exceptionDetails) { throw 'The Settings control did not open.' }
    do {
        $id += 1
        $settings = Invoke-Cdp $socket $id 'Runtime.evaluate' @{
            expression = "document.querySelector('dialog[open]')?.textContent.includes('Choose receive folder')"
            returnByValue = $true
        } $deadline.Token
        if (-not $settings.result.value) { Start-Sleep -Milliseconds 250 }
    } until ($settings.result.value -or $deadline.IsCancellationRequested)
    if (-not $settings.result.value) { throw 'The Settings sheet did not render.' }

    $settingsImage = Invoke-Cdp $socket ($id + 1) 'Page.captureScreenshot' @{ format = 'png'; fromSurface = $true } $deadline.Token
    [IO.File]::WriteAllBytes((Join-Path $evidence 'windows-settings.png'), [Convert]::FromBase64String($settingsImage.data))
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 5
    $receipt = [ordered]@{
        commit = (git rev-parse HEAD)
        windowsVersion = [Environment]::OSVersion.VersionString
        webView = $version.Browser
        installer = $installer.Name
        sha256 = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash
        installed = $true
        nativePickerEnabled = $true
        settingsRendered = $true
    }
    $receipt | ConvertTo-Json | Tee-Object -FilePath (Join-Path $evidence 'windows-launch.json')
} finally {
    $socket.Dispose()
    $deadline.Dispose()
    if (-not $process.HasExited) { Stop-Process -Id $process.Id }
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
}
