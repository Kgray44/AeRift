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

function Invoke-AppExpression {
    param($Socket, [ref]$Id, [string]$Expression, $Timeout, [switch]$AwaitPromise)

    $Id.Value += 1
    $result = Invoke-Cdp $Socket $Id.Value 'Runtime.evaluate' @{
        expression = $Expression
        returnByValue = $true
        awaitPromise = [bool]$AwaitPromise
    } $Timeout
    if ($result.exceptionDetails) {
        throw "AeRift WebView evaluation failed: $($result.exceptionDetails.text)"
    }
    return $result.result.value
}

function Wait-AppCondition {
    param($Socket, [ref]$Id, [string]$Expression, $Timeout, [string]$Failure)

    do {
        if (Invoke-AppExpression $Socket $Id $Expression $Timeout) { return }
        Start-Sleep -Milliseconds 250
    } until ($Timeout.IsCancellationRequested)
    throw $Failure
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
& (Join-Path $PSScriptRoot 'Verify-InstalledIcon.ps1') -Executable @($installer.FullName, (Join-Path $installDirectory 'aerift.exe')) `
    -SourceIco (Join-Path $PSScriptRoot '..\aerift\src-tauri\icons\icon.ico')


# Scope the local debugging endpoint to this disposable CI launch.
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
# Optional runner-owned observations; no app sampling outside this smoke.
$perf = $env:AERIFT_PERF_OBSERVE -eq '1'
$folderFixture = $env:AERIFT_WORKSPACE_FOLDER_FIXTURE -ceq 'synthetic-fixed-ntfs-only'
if ($folderFixture -and ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted')) {
    throw 'The foreground folder fixture may only launch on a disposable hosted runner.'
}
$windowStyle = if ($folderFixture) { 'Normal' } else { 'Hidden' }
$launchClock = if ($perf) { [Diagnostics.Stopwatch]::StartNew() } else { $null }
$process = Start-Process -FilePath (Join-Path $installDirectory 'aerift.exe') -PassThru -WindowStyle $windowStyle
$socket = [Net.WebSockets.ClientWebSocket]::new()
$deadlineSeconds = if ($folderFixture) { 220 } else { 110 }
$deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($deadlineSeconds))
$registryCleanup = [System.Collections.Generic.List[string]]::new()
$forwarded = $null
$id = 0

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

    $debugEndpoint = [uri]$target.webSocketDebuggerUrl
    if ($debugEndpoint.Scheme -cne 'ws' -or $debugEndpoint.Host -cne '127.0.0.1' -or $debugEndpoint.Port -ne $port) {
        throw 'Unexpected non-owned WebView debugger endpoint.'
    }
    $socket.ConnectAsync($debugEndpoint, $deadline.Token).GetAwaiter().GetResult() | Out-Null
    $homeCheck = @'
document.querySelector('h1')?.textContent === 'AeRift' &&
document.querySelector('#aerift-desktop-destination')?.textContent === 'Home' &&
!!document.querySelector('.ae-orbit-trigger')
'@
    Wait-AppCondition $socket ([ref]$id) $homeCheck $deadline.Token 'AeRift did not render Simplified Home with Orbit.'

    if ($perf) {
        Write-Host ('AERIFT_PERF startup.windows.home-observed=' + $launchClock.ElapsedMilliseconds)
        try {
            $fcp = Invoke-AppExpression $socket ([ref]$id) "performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null" $deadline.Token
            if ($null -ne $fcp -and [double]$fcp -ge 0 -and [double]::IsFinite([double]$fcp)) {
                $encodedFcp = ([double]$fcp).ToString('0.###', [Globalization.CultureInfo]::InvariantCulture)
                Write-Host ('AERIFT_PERF startup.windows.webview-fcp=' + $encodedFcp)
            }
        } catch {
            Write-Warning 'WebView first-contentful-paint unavailable in this smoke.'
        }
    }

    $id += 1
    $image = Invoke-Cdp $socket $id 'Page.captureScreenshot' @{ format = 'png'; fromSurface = $true } $deadline.Token
    $imageBytes = [Convert]::FromBase64String($image.data)
    if ($imageBytes.Length -lt 100) { throw 'WebView returned an empty screenshot.' }
    [IO.File]::WriteAllBytes((Join-Path $evidence 'windows-launch.png'), $imageBytes)

    $openRift = "[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Open the Rift').click()"
    Invoke-AppExpression $socket ([ref]$id) $openRift $deadline.Token | Out-Null
    $rift = @'
document.querySelector('#aerift-desktop-destination')?.textContent === 'Rift' &&
!!document.querySelector('[aria-label="Spatial workspace"]:not([hidden])') &&
[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Choose file' && !button.disabled)
'@
    Wait-AppCondition $socket ([ref]$id) $rift $deadline.Token 'The production Rift or native picker did not become available.'

    Invoke-AppExpression $socket ([ref]$id) "document.querySelector('.ae-control-gear').click()" $deadline.Token | Out-Null
    $settings = @'
document.querySelector('#aerift-desktop-destination')?.textContent === 'Settings' &&
!!document.querySelector('[aria-label="Settings categories"] button[aria-pressed="true"]') &&
!!document.querySelector('#experience-heading')?.closest('section:not([hidden])')?.querySelector('select option[value="full"]')
'@
    Wait-AppCondition $socket ([ref]$id) $settings $deadline.Token 'The Settings General destination did not render.'
    $settingsCategory = '[aria-label="Settings categories"]'
    $settingsTransfers = "[...document.querySelectorAll('$settingsCategory button')].find(button => button.getAttribute('title') === 'Transfers')"
    Invoke-AppExpression $socket ([ref]$id) "($settingsTransfers).click()" $deadline.Token | Out-Null
    $receiveFolder = @'
!!document.querySelector('#transfer-settings-heading')?.closest('section:not([hidden])')
  ?.querySelector('button[aria-label="Choose receive folder"]:not([disabled])')?.getClientRects().length
'@
    Wait-AppCondition $socket ([ref]$id) $receiveFolder $deadline.Token 'Settings Transfers did not expose the native receive folder picker.'
    $settingsGeneral = "[...document.querySelectorAll('$settingsCategory button')].find(button => button.getAttribute('title') === 'General')"
    Invoke-AppExpression $socket ([ref]$id) "($settingsGeneral).click()" $deadline.Token | Out-Null
    Wait-AppCondition $socket ([ref]$id) $settings $deadline.Token 'Settings did not return to General.'

    $id += 1
    $settingsImage = Invoke-Cdp $socket $id 'Page.captureScreenshot' @{ format = 'png'; fromSurface = $true } $deadline.Token
    [IO.File]::WriteAllBytes((Join-Path $evidence 'windows-settings.png'), [Convert]::FromBase64String($settingsImage.data))

    $setFull = @'
(() => {
    const mode = document.querySelector('select:has(option[value="full"])');
    mode.value = 'full';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
})()
'@
    Invoke-AppExpression $socket ([ref]$id) $setFull $deadline.Token | Out-Null
    $full = "JSON.parse(localStorage.getItem('aerift.settings.v1') || '{}').experience?.windowMode === 'full'"
    Wait-AppCondition $socket ([ref]$id) $full $deadline.Token 'Full Workspace mode did not persist.'
    Invoke-AppExpression $socket ([ref]$id) "document.querySelector('.ae-orbit-trigger').click()" $deadline.Token | Out-Null
    $workspaceChoice = "[...document.querySelectorAll('.ae-orbit-choice')].find(button => button.getAttribute('aria-label') === 'Workspace')"
    Wait-AppCondition $socket ([ref]$id) "!!($workspaceChoice)" $deadline.Token 'Full mode did not expose Workspace in Orbit.'
    Invoke-AppExpression $socket ([ref]$id) "($workspaceChoice).click()" $deadline.Token | Out-Null
    $workspace = "document.querySelector('#aerift-desktop-destination')?.textContent === 'Workspace'"
    Wait-AppCondition $socket ([ref]$id) $workspace $deadline.Token 'Full Workspace did not open.'

    Invoke-AppExpression $socket ([ref]$id) "window.__TAURI_INTERNALS__.invoke('set_desktop_ambient', {enabled: true})" $deadline.Token -AwaitPromise | Out-Null
    Invoke-AppExpression $socket ([ref]$id) "window.__TAURI_INTERNALS__.invoke('set_desktop_ambient', {enabled: false})" $deadline.Token -AwaitPromise | Out-Null

    # Change current-user registration only on the disposable installation runner.
    if ($env:GITHUB_ACTIONS -eq 'true') {
        foreach ($pair in @(
            @{ change = 'set_desktop_explorer'; read = 'desktop_explorer_enabled' }
            @{ change = 'set_desktop_startup'; read = 'desktop_startup_enabled' }
        )) {
            $readResult = Invoke-AppExpression $socket ([ref]$id) "window.__TAURI_INTERNALS__.invoke('$($pair.read)')" $deadline.Token -AwaitPromise
            if ($readResult -ne $false) { throw "The disposable runner was already registered for $($pair.read)." }
            $registryCleanup.Add($pair.change)
            $setResult = Invoke-AppExpression $socket ([ref]$id) "window.__TAURI_INTERNALS__.invoke('$($pair.change)', {enabled: true})" $deadline.Token -AwaitPromise
            if ($setResult -ne $true) { throw "Native registration failed for $($pair.change)." }
        }

        $stagedPath = Join-Path $env:RUNNER_TEMP 'AeRift Explorer test.txt'
        Set-Content -LiteralPath $stagedPath -Value 'Staged by the installed Windows smoke test.'
        $forwarded = Start-Process -FilePath (Join-Path $installDirectory 'aerift.exe') -ArgumentList @('--stage-file', ('"{0}"' -f $stagedPath)) -PassThru -WindowStyle Hidden
        $staged = @'
document.querySelector('#aerift-desktop-destination')?.textContent === 'Rift' &&
document.querySelector('.ae-dock-file')?.textContent.includes('AeRift Explorer test.txt') &&
![...document.querySelectorAll('.ae-transfer-dock button')].some(button => button.textContent.trim() === 'Send file')
'@
        Wait-AppCondition $socket ([ref]$id) $staged $deadline.Token 'The original installed instance did not stage the file from the second launch.'
        foreach ($command in $registryCleanup.ToArray()) {
            $removed = Invoke-AppExpression $socket ([ref]$id) "window.__TAURI_INTERNALS__.invoke('$command', {enabled: false})" $deadline.Token -AwaitPromise
            if ($removed -ne $false) { throw "Native registration cleanup failed for $command." }
            $null = $registryCleanup.Remove($command)
        }
    }

    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 5
    $workspaceFolderFixture = $null
    if ($folderFixture) {
        . (Join-Path $PSScriptRoot 'Test-InstalledWorkspaceFolder.ps1')
        $workspaceFolderFixture = Test-InstalledWorkspaceFolder $socket ([ref]$id) $deadline.Token $process
        if (!$workspaceFolderFixture.releasedOnNativeClose) { throw 'Installed workspace folder qualification did not complete.' }
    }
    $receipt = [ordered]@{
        commit = (git rev-parse HEAD)
        windowsVersion = [Environment]::OSVersion.VersionString
        webView = $version.Browser
        installer = $installer.Name
        sha256 = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash
        installed = $true
        nativePickerEnabled = $true
        settingsRendered = $true
        simplifiedHomeAndOrbit = $true
        fullWorkspace = $true
        workspaceSyntheticNativeFolder = $workspaceFolderFixture
        nativeTrayVisibilityCommands = $true
        explorerAndStartupRegistration = ($env:GITHUB_ACTIONS -eq 'true')
        secondInstanceStagesWithoutSending = ($env:GITHUB_ACTIONS -eq 'true')
    }
    $receipt | ConvertTo-Json -Depth 4 | Tee-Object -FilePath (Join-Path $evidence 'windows-launch.json')
} finally {
    if ($socket.State -eq [Net.WebSockets.WebSocketState]::Open -and $registryCleanup.Count) {
        $cleanupDeadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(10))
        try {
            foreach ($command in $registryCleanup.ToArray()) {
                try {
                    Invoke-AppExpression $socket ([ref]$id) "window.__TAURI_INTERNALS__.invoke('$command', {enabled: false})" $cleanupDeadline.Token -AwaitPromise | Out-Null
                } catch {
                    Write-Warning "Could not clear disposable Windows registration $command."
                }
            }
        } finally {
            $cleanupDeadline.Dispose()
        }
    }
    if ($forwarded -and -not $forwarded.HasExited) { Stop-Process -Id $forwarded.Id }
    $socket.Dispose()
    $deadline.Dispose()
    if (-not $process.HasExited) {
        $exitClock = if ($perf) { [Diagnostics.Stopwatch]::StartNew() } else { $null }
        Stop-Process -Id $process.Id
        if ($perf -and $process.WaitForExit(5000)) {
            Write-Host ('AERIFT_PERF teardown.windows.forced-app-exit-observed=' + $exitClock.ElapsedMilliseconds)
        }
    }
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
}
