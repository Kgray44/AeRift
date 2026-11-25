param(
    [Parameter(Mandatory)] [string] $Installer,
    [Parameter(Mandatory)] [string] $FixturePeer,
    [Parameter(Mandatory)] [string] $Consent
)
$ErrorActionPreference = 'Stop'
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $Consent -cne 'SYNTHETIC PRIVATE FOLDERS ONLY' -or !$env:RUNNER_TEMP -or !$env:LOCALAPPDATA) {
    throw 'This fixture requires explicit synthetic consent and a disposable Windows CI runner.'
}
$runnerRoot = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).ProviderPath.TrimEnd('\')
function Owned-Binary([string]$Path) {
    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer -or $item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or
        !$item.FullName.StartsWith($runnerRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Fixture binary must be an owned runner-temp regular file.'
    }
    $item.FullName
}
$Installer = Owned-Binary $Installer
$FixturePeer = Owned-Binary $FixturePeer
$profile = Join-Path $env:LOCALAPPDATA 'com.kgamazing44.aerift'
if ((Test-Path -LiteralPath $profile) -or (Get-Process -Name 'aerift' -ErrorAction SilentlyContinue)) {
    throw 'Refusing to touch an existing AeRift profile or process.'
}
$ip = '100.127.255.250'
if (Get-NetIPAddress -IPAddress $ip -ErrorAction SilentlyContinue) { throw 'Fixture alias is already in use.' }
$loopback = @(Get-NetIPAddress -IPAddress '127.0.0.1' -AddressFamily IPv4)
if ($loopback.Count -ne 1) { throw 'Expected one independently identifiable loopback interface.' }
$interface = $loopback[0].InterfaceIndex
$root = Join-Path $runnerRoot ('aerift-private-folders-' + [Guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $root 'App'
# Atomic no-replace publication must stay on one NTFS volume. The runner
# installer scratch can be on another volume from the local app profile.
$destinationRoot = Join-Path $env:LOCALAPPDATA ('aerift-owned-folder-fixture-' + [Guid]::NewGuid().ToString('N'))
$destination = Join-Path $destinationRoot 'Destination'
New-Item -ItemType Directory -Path $root | Out-Null
$alias = $false; $app = $null; $peer = $null; $socket = $null; $profileOwned = $false
$destinationOwned = $false
$deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromMinutes(4))
$cdpId = 0
$previousCdp = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS

function Free-Port([string]$Address) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($Address), 0)
    try { $listener.Start(); return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}
function Wait-For([ScriptBlock]$Check, [string]$Failure) {
    $end = [DateTime]::UtcNow.AddSeconds(25)
    do {
        $value = & $Check
        if ($value) { return $value }
        Start-Sleep -Milliseconds 200
    } while (!$deadline.IsCancellationRequested -and [DateTime]::UtcNow -lt $end)
    throw $Failure
}
function Js([string]$Code) {
    $script:cdpId++
    $request = @{id=$script:cdpId;method='Runtime.evaluate';params=@{expression=$Code;returnByValue=$true}} |
        ConvertTo-Json -Depth 6 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($request)
    $socket.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text,
        $true, $deadline.Token).GetAwaiter().GetResult() | Out-Null
    $buffer = New-Object byte[] 65536
    do {
        $stream = [IO.MemoryStream]::new()
        try {
            do {
                $part = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $deadline.Token).GetAwaiter().GetResult()
                if ($part.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { throw 'Owned WebView closed.' }
                $stream.Write($buffer, 0, $part.Count)
                if ($stream.Length -gt 1048576) { throw 'Oversize fixture reply.' }
            } until ($part.EndOfMessage)
            $reply = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
        } finally { $stream.Dispose() }
    } until ($reply.id -eq $script:cdpId)
    if ($reply.error -or $reply.result.exceptionDetails) { throw 'Owned WebView expression failed.' }
    return $reply.result.result.value
}
function Button([string]$Text) {
    $label = ConvertTo-Json -InputObject $Text -Compress
    Wait-For { Js "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === $label && !x.disabled && x.getClientRects().length); if (!b) return false; b.click(); return true; })()" } "Missing enabled button: $Text" | Out-Null
}
function Check-Label([string]$Text) {
    $label = ConvertTo-Json -InputObject $Text -Compress
    if (!(Js "(() => { const i = [...document.querySelectorAll('label')].find(x => x.textContent.includes($label))?.querySelector('input[type=checkbox]'); if (!i) return false; if (!i.checked) i.click(); return i.checked; })()")) {
        throw "Missing consent checkbox: $Text"
    }
}
function Write-Peer([string]$Command) {
    $peer.StandardInput.WriteLine($Command)
    $peer.StandardInput.Flush()
}
function Read-Peer([string]$Event) {
    $line = $peer.StandardOutput.ReadLineAsync()
    if (!$line.Wait([TimeSpan]::FromSeconds(50)) -or !$line.Result) { throw "Fixture peer did not emit $Event." }
    $obj = $line.Result | ConvertFrom-Json
    if ($obj.event -cne $Event) { throw "Unexpected fixture peer event; expected $Event." }
    return $obj.value
}
function Owned-Dialog {
    $condition = [System.Windows.Automation.AndCondition]::new(
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$app.Id),
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770'))
    [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
}
function Dialog-Child($Dialog, [string]$Id) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Id)
    $Dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
function Write-OwnedDialogShape($Dialog) {
    # Never dump names/values, paths, or screenshots. Report only bounded
    # provider structure and recognizable static labels as booleans.
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $queue = [Collections.Generic.Queue[object]]::new()
    $queue.Enqueue(@{ element = $Dialog; parent = -1; depth = 0 })
    $index = 0
    while ($queue.Count -gt 0 -and $index -lt 90) {
        $row = $queue.Dequeue()
        $element = $row.element
        try {
            $properties = $element.Current
            if ($properties.ProcessId -ne $app.Id) { continue }
            $id = $properties.AutomationId
            if ($id -cnotmatch '^(?:[0-9]{1,6}|[A-Za-z][A-Za-z0-9_-]{0,47})$') { $id = '[other]' }
            $kind = $properties.ControlType.ProgrammaticName
            $class = $properties.ClassName
            if ($class -cnotmatch '^[#A-Za-z0-9_-]{1,48}$') { $class = '[other]' }
            $label = $properties.Name -cin @('Folder:', 'Folder name:', 'File name:', 'Select Folder', 'Cancel')
            $value = $null
            $hasValue = $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)
            $invoke = $null
            $hasInvoke = $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)
            Write-Host ("fixture UIA #{0} parent={1} depth={2} kind={3} id={4} class={5} staticLabel={6} enabled={7} valuePattern={8} invokePattern={9}" -f
                $index, $row.parent, $row.depth, $kind, $id, $class, $label, $properties.IsEnabled, $hasValue, $hasInvoke)
            if ($row.depth -lt 8) {
                $child = $walker.GetFirstChild($element)
                $siblings = 0
                while ($child -and $siblings -lt 14 -and $queue.Count -lt 90) {
                    $queue.Enqueue(@{ element = $child; parent = $index; depth = ($row.depth + 1) })
                    $child = $walker.GetNextSibling($child)
                    $siblings++
                }
            }
        } catch { Write-Host 'Fixture UIA returned a stale or inaccessible owned element.' }
        $index++
    }
}
function Owned-FolderNameField($Dialog) {
    # The observed Windows folder dialog exposes a direct Edit child with
    # shell ID 1152, not the classic file-name ComboBox ID 1148.
    $id = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1152')
    $edit = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    $matches = $Dialog.FindAll([System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.AndCondition]::new($id, $edit))
    if ($matches.Count -ne 1) { return }
    $candidate = $matches[0]
    $p = $candidate.Current
    if ($p.ProcessId -ne $app.Id -or $p.ClassName -cne 'Edit' -or !$p.IsEnabled -or
        $p.Name -cnotin @('Folder:', 'Folder name:', 'File name:')) { return }
    $value = $null
    if (!$candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value) -or
        $value.Current.IsReadOnly) { return }
    return $value
}
function Choose-NativeDestination([bool]$Cancel) {
    $dialog = Wait-For { Owned-Dialog } 'Native folder picker not found in owned AeRift process.'
    if (!$Cancel) {
        try {
            $field = Wait-For { Owned-FolderNameField $dialog } 'Owned native folder input unavailable; no simulated keys or path injection.'
            $field.SetValue($destination)
        } catch {
            Write-OwnedDialogShape $dialog
            throw
        }
    }
    $button = Dialog-Child $dialog $(if ($Cancel) { '2' } else { '1' })
    if (!$button) { Write-OwnedDialogShape $dialog; throw 'Owned native picker confirmation unavailable.' }
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Wait-For { !(Owned-Dialog) } 'Owned native picker did not close.' | Out-Null
}
function Folder-Text([string]$Text) {
    $label = ConvertTo-Json -InputObject $Text -Compress
    Wait-For { Js "document.querySelector('#remote-folder-heading').parentElement.textContent.includes($label)" } "Missing folder state: $Text" | Out-Null
}

try {
    New-NetIPAddress -InterfaceIndex $interface -IPAddress $ip -PrefixLength 32 -AddressFamily IPv4 -PolicyStore ActiveStore -SkipAsSource $true | Out-Null
    $alias = $true
    Wait-For { Get-NetIPAddress -IPAddress $ip -InterfaceIndex $interface -AddressState Preferred -ErrorAction SilentlyContinue } 'Exact loopback alias not usable; refusing fallback.' | Out-Null
    $privatePort = Free-Port $ip
    $endpoint = $ip + ':' + $privatePort
    $start = [Diagnostics.ProcessStartInfo]::new($FixturePeer, $endpoint)
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true
    $peer = [Diagnostics.Process]::Start($start)
    Write-Peer $Consent
    $fingerprint = Read-Peer 'fingerprint'
    $profileOwned = $true
    # Only newly-created runner-owned siblings are touched; no test touches
    # user files or changes the native no-cross-volume publication rule.
    New-Item -ItemType Directory -Path $destinationRoot -ErrorAction Stop | Out-Null
    $destinationOwned = $true
    New-Item -ItemType Directory -Path $destination | Out-Null
    if ($fingerprint -notmatch '^[0-9a-f]{64}$') { throw 'Missing exact fixture fingerprint.' }
    $setup = Start-Process $Installer -ArgumentList "/S /D=$installRoot" -Wait -PassThru
    if ($setup.ExitCode -ne 0) { throw 'Qualification installer failed.' }
    $port = Free-Port '127.0.0.1'
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
    $app = Start-Process (Join-Path $installRoot 'aerift.exe') -PassThru
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $target = Wait-For {
        try {
            Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2 |
                Where-Object { $_.type -eq 'page' -and $_.url -match '^https?://tauri\.localhost(?:/|$)' } |
                Select-Object -First 1
        } catch { $null }
    } 'Owned installed WebView unavailable.'
    $debugEndpoint = [uri]$target.webSocketDebuggerUrl
    if ($debugEndpoint.Host -ne '127.0.0.1' -or $debugEndpoint.Port -ne $port) { throw 'Debug endpoint not owned loopback.' }
    $socket = [Net.WebSockets.ClientWebSocket]::new()
    $socket.ConnectAsync($debugEndpoint, $deadline.Token).GetAwaiter().GetResult() | Out-Null
    Wait-For { Js "document.body.textContent.includes('Private receiver is off')" } 'Protected private mode did not start off.' | Out-Null
    if (Js "!!document.querySelector('#remote-folder-heading')") { throw 'Folder UI appeared without consent.' }
    Check-Label 'Start listening at this exact address on my private VPN.'
    Button 'Start Remote'
    Wait-For { Js "document.body.textContent.includes('Device fingerprint:')" } 'Ordinary Remote session did not start.' | Out-Null
    if (Js "!!document.querySelector('#remote-folder-heading')") { throw 'Live Remote session activated folders without opt-in.' }
    Button 'Stop Remote'
    Wait-For { Js "document.body.textContent.includes('Private receiver is off')" } 'Ordinary Remote session did not stop.' | Out-Null
    Check-Label 'Start listening at this exact address on my private VPN.'
    Check-Label 'Enable private folder transfers'
    Button 'Start Remote'
    Wait-For { Js "!!document.querySelector('#remote-folder-heading')" } 'Authorized folder lane did not activate.' | Out-Null
    # Use disposable files inside the actual stage and destination, not
    # the seeded profile preference or the installer volume as proxies.
    $stage = Join-Path $profile 'PrivateRemoteFolderQualification\Stage'
    if (!(Test-Path -LiteralPath $stage -PathType Container)) { throw 'Owned app did not create its folder stage.' }
    $marker = 'volume-fixture-' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $stageFixture = Join-Path $stage $marker
    $volumeFixture = Join-Path $destination $marker
    New-Item -ItemType File -Path $stageFixture | Out-Null
    try {
        New-Item -ItemType File -Path $volumeFixture | Out-Null
        $stageVolume = @(Get-Volume -FilePath $stageFixture -ErrorAction Stop)
        $targetVolume = @(Get-Volume -FilePath $volumeFixture -ErrorAction Stop)
    } finally {
        Remove-Item -LiteralPath $stageFixture
        if (Test-Path -LiteralPath $volumeFixture) { Remove-Item -LiteralPath $volumeFixture }
    }
    if ($stageVolume.Count -ne 1 -or $targetVolume.Count -ne 1 -or
        !$stageVolume[0].UniqueId -or $stageVolume[0].UniqueId -cne $targetVolume[0].UniqueId -or
        $stageVolume[0].FileSystem -ne 'NTFS' -or $targetVolume[0].FileSystem -ne 'NTFS') {
        throw 'Fixture target must be on the same owned NTFS volume as protected staging.'
    }
    Write-Host 'Synthetic destination and protected stage share one owned NTFS volume.'
    $issuer = Wait-For {
        Js "(() => { const p = document.querySelector('section[aria-labelledby=remote-pair-heading]')?.previousElementSibling; const id = p?.querySelector('code')?.textContent?.trim(); return p?.tagName === 'P' && p.textContent.trim().startsWith('Device fingerprint:') && /^[0-9a-f]{64}$/.test(id ?? '') ? id : null; })()"
    } 'Missing installed identity before the pairing section.'
    $peerJson = ConvertTo-Json -InputObject $fingerprint -Compress
    Js "(() => { const i = document.querySelector('#remote-pair-heading').parentElement.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,$peerJson); i.dispatchEvent(new Event('input',{bubbles:true})); })()" | Out-Null
    Button 'Create five-minute invitation'
    $invite = Wait-For { Js "document.querySelector('#remote-pair-heading').parentElement.querySelector('textarea')?.value" } 'Installed app did not issue an invitation.'
    Write-Peer $issuer; Write-Peer $invite; Write-Peer 'PAIR PRIVATE FIXTURE'
    Button 'Approve Remote pairing'
    Read-Peer 'paired' | Out-Null
    Wait-For { Js "document.querySelector('#remote-peers-heading').parentElement.textContent.includes($peerJson)" } 'Authorized peer unavailable.' | Out-Null

    Write-Peer 'OFFER LEGACY FIXTURE'
    Button 'Accept file'
    Read-Peer 'legacy_verified' | Out-Null
    $legacy = @(Get-ChildItem -LiteralPath (Join-Path $profile 'RemoteReceived') -File -Filter '*legacy-fixture*')
    if ($legacy.Count -ne 1 -or [IO.File]::ReadAllText($legacy[0].FullName) -cne ('AeRift installed Windows legacy file.' + [char]10)) { throw 'Legacy bytes not verified.' }

    $published = Join-Path $destination 'Synthetic Folder'
    Write-Peer 'OFFER FOLDER FIXTURE'
    Button 'Accept folder and choose destination'
    Choose-NativeDestination $true
    Folder-Text 'Cancelled.'
    if (Test-Path -LiteralPath $published) { throw 'Destination changed before consent.' }
    Button 'Accept folder and choose destination'
    Choose-NativeDestination $false
    Read-Peer 'folder_verified' | Out-Null
    Folder-Text 'Folder data verified. Not exported yet.'
    if (Test-Path -LiteralPath $published) { throw 'Verified receipt wrote before separate Save.' }
    $renamed = $false
    try { Rename-Item $destination -NewName 'Wrong Location' -ErrorAction Stop; $renamed = $true } catch {}
    if ($renamed -or !(Test-Path -LiteralPath $destination)) { throw 'Held native destination lease allowed substitution.' }
    Button 'Save verified folder without replacing files'
    Folder-Text 'Saved to the destination you chose.'
    $textFile = Join-Path $published 'fixture.txt'
    if (!(Test-Path -LiteralPath (Join-Path $published 'empty') -PathType Container) -or
        [IO.File]::ReadAllText($textFile) -cne ('AeRift installed Windows folder fixture.' + [char]10)) { throw 'Exported fixture mismatch.' }
    $hash = (Get-FileHash -LiteralPath $textFile).Hash
    if (Js "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Save verified folder without replacing files' && !b.disabled)") {
        throw 'A spent receipt offered a second Save.'
    }
    # A successful Save consumed the lease, so the owned directory is
    # renameable again. Restore our fixture path before collision testing.
    Rename-Item -LiteralPath $destination -NewName 'Released Destination'
    Rename-Item -LiteralPath (Join-Path $destinationRoot 'Released Destination') -NewName 'Destination'
    Button 'Dismiss receipt'

    Write-Peer 'OFFER FOLDER FIXTURE'
    Button 'Accept folder and choose destination'
    Choose-NativeDestination $false
    Read-Peer 'folder_verified' | Out-Null
    Button 'Save verified folder without replacing files'
    Folder-Text 'No successful export was reported.'
    if ((Get-FileHash -LiteralPath $textFile).Hash -ne $hash) { throw 'Existing destination bytes were replaced.' }
    Button 'Revoke Remote access'
    Button 'Confirm Remote revoke'
    Wait-For { Js "document.querySelector('#remote-peers-heading').parentElement.textContent.includes('No Remote devices authorized.')" } 'Protected peer was not revoked.' | Out-Null
    Write-Peer 'CHECK REVOKED FIXTURE'
    Read-Peer 'not_admitted' | Out-Null
    Button 'Stop Remote'
    Wait-For { Js "document.body.textContent.includes('Private receiver is off')" } 'Private listener did not stop.' | Out-Null
    # SEC Stop must finish the native listener barrier before the UI reports
    # off. An exact loopback reconnect may neither connect nor publish.
    $probe = [Net.Sockets.TcpClient]::new()
    try {
        $reconnect = $probe.ConnectAsync($ip, $privatePort)
        $end = [DateTime]::UtcNow.AddSeconds(4)
        while (!$reconnect.IsCompleted -and [DateTime]::UtcNow -lt $end) { Start-Sleep -Milliseconds 50 }
        if ($probe.Connected -or !$reconnect.IsFaulted) { throw 'Stopped private listener did not refuse the exact connection.' }
        $faults = @($reconnect.Exception.Flatten().InnerExceptions)
        if ($faults.Count -ne 1 -or $faults[0] -isnot [Net.Sockets.SocketException] -or
            $faults[0].SocketErrorCode -ne [Net.Sockets.SocketError]::ConnectionRefused) {
            throw 'Stopped exact endpoint reported something other than connection refusal.'
        }
    } finally { $probe.Dispose() }
    Write-Peer 'STOP FIXTURE'
    if (!$peer.WaitForExit(5000) -or $peer.ExitCode -ne 0) { throw 'Fixture peer did not cleanly exit.' }
    Write-Host 'Verified synthetic installed folder consent, native picker lease, no-replace export, revocation and legacy bytes. Not WAN or physical proof.'
} finally {
    try {
        if ($socket) { $socket.Dispose() }
        if ($app -and !$app.HasExited) { $app.Kill($true); $app.WaitForExit() }
        if ($peer -and !$peer.HasExited) { $peer.Kill($true); $peer.WaitForExit() }
        $uninstaller = Join-Path $installRoot 'uninstall.exe'
        if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
            $uninstall = Start-Process $uninstaller -ArgumentList '/S' -Wait -PassThru
            if ($uninstall.ExitCode -ne 0) { throw 'Owned fixture uninstaller failed.' }
        }
    } finally {
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousCdp
        if ($alias) { Remove-NetIPAddress -InterfaceIndex $interface -IPAddress $ip -PolicyStore ActiveStore -Confirm:$false }
        if ($profileOwned -and (Test-Path -LiteralPath $profile)) { Remove-Item -LiteralPath $profile -Recurse -Force }
        if ($destinationOwned -and (Test-Path -LiteralPath $destinationRoot)) { Remove-Item -LiteralPath $destinationRoot -Recurse -Force }
        if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
        $deadline.Dispose()
    }
}
