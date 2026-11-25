# Called by Test-InstalledShell.ps1 after its normal installed app has launched.
# No standalone run, hardware access, arbitrary folder parameter or remote UI.
function Test-InstalledWorkspaceFolder {
    param($Socket, [ref]$Id, $Timeout, [Diagnostics.Process]$OwnedProcess)

    if (!$IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or
        $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
        $env:AERIFT_WORKSPACE_FOLDER_FIXTURE -cne 'synthetic-fixed-ntfs-only' -or !$env:RUNNER_TEMP) {
        throw 'Workspace folder proof requires its disposable hosted synthetic runner.'
    }
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -Name OwnedWindow -Namespace AeRiftFixture -MemberDefinition @'
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern System.IntPtr GetForegroundWindow();
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        public static extern bool SetForegroundWindow(System.IntPtr window);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern System.IntPtr GetLastActivePopup(System.IntPtr window);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern System.IntPtr GetAncestor(System.IntPtr window, uint flag);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(System.IntPtr window, out uint processId);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        public static extern bool IsWindowVisible(System.IntPtr window);
        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
        public static extern int GetClassName(System.IntPtr window, System.Text.StringBuilder value, int capacity);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern System.IntPtr GetDlgItem(System.IntPtr dialog, int id);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern int GetDlgCtrlID(System.IntPtr control);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern System.IntPtr GetWindow(System.IntPtr window, uint command);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        public static extern bool IsWindowEnabled(System.IntPtr window);
        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint="SendMessageTimeoutW")]
        public static extern System.IntPtr SendMessageTimeout(
            System.IntPtr window, uint message, System.UIntPtr wparam, System.IntPtr lparam,
            uint flags, uint timeoutMs, out System.UIntPtr result);
        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
        public static extern System.IntPtr SendTextTimeout(
            System.IntPtr window, uint message, System.UIntPtr wparam, string text,
            uint flags, uint timeoutMs, out System.UIntPtr result);
        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint="GetWindowLongW")]
        public static extern int GetWindowLong(System.IntPtr window, int index);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        public static extern bool IsChild(System.IntPtr parent, System.IntPtr child);
'@

    function Find-Chooser {
        # A parented shell dialog need not be a child of UIA's desktop root.
        # Find the actual foreground/popup HWND, then bind UIA to that exact
        # visible #32770 owned by the installed app's original main HWND.
        $foreground = [AeRiftFixture.OwnedWindow]::GetForegroundWindow()
        $popup = [AeRiftFixture.OwnedWindow]::GetLastActivePopup($hwnd)
        foreach ($candidate in @($foreground, $popup) | Select-Object -Unique) {
            if ($candidate -eq [IntPtr]::Zero -or $candidate -eq $hwnd -or
                ![AeRiftFixture.OwnedWindow]::IsWindowVisible($candidate) -or
                [AeRiftFixture.OwnedWindow]::GetAncestor($candidate, 3) -ne $hwnd) {
                continue
            }
            $processId = [uint32]0
            if (![AeRiftFixture.OwnedWindow]::GetWindowThreadProcessId($candidate, [ref]$processId) -or
                $processId -ne $OwnedProcess.Id) { continue }
            $class = [Text.StringBuilder]::new(32)
            if (![AeRiftFixture.OwnedWindow]::GetClassName($candidate, $class, $class.Capacity) -or
                $class.ToString() -cne '#32770') { continue }
            $element = [System.Windows.Automation.AutomationElement]::FromHandle($candidate)
            if ($element.Current.ProcessId -eq $OwnedProcess.Id) { return $candidate }
        }
    }

    function Wait-Fixture($Predicate, [string]$Message) {
        $end = [DateTime]::UtcNow.AddSeconds(13)
        do {
            $value = & $Predicate
            if ($value) { return $value }
            Start-Sleep -Milliseconds 150
        } until ($Timeout.IsCancellationRequested -or [DateTime]::UtcNow -ge $end)
        throw $Message
    }

    function Read-ChooserState {
        $probe = @'
(() => {
  const panel = document.querySelector('section[aria-label="Browse a local folder"]');
  const buttons = [...panel?.querySelectorAll('button') ?? []];
  const chooser = buttons.find(b => b.textContent.trim() === 'Choose folder');
  const error = panel?.querySelector('[role=alert]')?.dataset.folderError;
  return {
    panel: !!panel, busy: chooser?.disabled === true, alert: !!panel?.querySelector('[role=alert]'),
    embedded: location.hostname === 'tauri.localhost' && (location.pathname === '/' || location.pathname === '/index.html'),
    focused: document.hasFocus(), visible: document.visibilityState === 'visible',
    uuid: typeof globalThis.crypto?.randomUUID === 'function',
    failure: ['origin','owner','focus','request','revoked','folder','bridge'].includes(error) ? error : null
  };
})()
'@
        $budget = [Threading.CancellationTokenSource]::CreateLinkedTokenSource($Timeout, [Threading.CancellationToken]::None)
        try {
            $budget.CancelAfter(2000)
            Invoke-AppExpression $Socket $Id $probe $budget.Token
        } catch {
            $null
        } finally {
            $budget.Dispose()
        }
    }

    function Click-Chooser {
        # Produce the same pointer interaction as a visible user's click,
        # after verifying both the main native foreground and WebView hit.
        if ([AeRiftFixture.OwnedWindow]::GetForegroundWindow() -ne $hwnd) {
            throw 'Native owner lost foreground before the picker click.'
        }
        $point = @'
(() => {
  const panel = document.querySelector('section[aria-label="Browse a local folder"]');
  const button = [...panel?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === 'Choose folder');
  if (!button || button.disabled) return null;
  button.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
  const box = button.getBoundingClientRect();
  const x = box.x + box.width/2, y = box.y + box.height/2;
  return button.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
})()
'@
        $target = Invoke-AppExpression $Socket $Id $point $Timeout
        if ($null -eq $target) { throw 'Visible chooser control did not receive a WebView hit.' }
        $Id.Value += 1
        Invoke-Cdp $Socket $Id.Value 'Input.dispatchMouseEvent' @{
            type = 'mousePressed'; x = $target.x; y = $target.y; button = 'left'; buttons = 1; clickCount = 1
        } $Timeout | Out-Null
        $Id.Value += 1
        Invoke-Cdp $Socket $Id.Value 'Input.dispatchMouseEvent' @{
            type = 'mouseReleased'; x = $target.x; y = $target.y; button = 'left'; buttons = 0; clickCount = 1
        } $Timeout | Out-Null
    }

    function Invoke-ExactDialogAction([IntPtr]$Dialog, [bool]$Cancel) {
        # The shell UIA provider can omit the button or expose multiple proxy
        # elements. Only act on the unique real, standard direct HWND child.
        $id = if ($Cancel) { 2 } else { 1 } # IDCANCEL / IDOK
        if ((Find-Chooser) -ne $Dialog -or
            [AeRiftFixture.OwnedWindow]::GetForegroundWindow() -ne $Dialog) {
            throw 'Native dialog changed before its action; refusing input.'
        }
        $button = [AeRiftFixture.OwnedWindow]::GetDlgItem($Dialog, $id)
        $matches = 0
        $child = [AeRiftFixture.OwnedWindow]::GetWindow($Dialog, 5) # GW_CHILD
        for ($count = 0; $child -ne [IntPtr]::Zero -and $count -lt 256; $count++) {
            if ([AeRiftFixture.OwnedWindow]::GetDlgCtrlID($child) -eq $id) { $matches++ }
            $child = [AeRiftFixture.OwnedWindow]::GetWindow($child, 2) # GW_HWNDNEXT
        }
        $buttonPid = [uint32]0
        $class = [Text.StringBuilder]::new(32)
        if ($button -eq [IntPtr]::Zero -or $child -ne [IntPtr]::Zero -or $matches -ne 1 -or
            [AeRiftFixture.OwnedWindow]::GetDlgCtrlID($button) -ne $id -or
            [AeRiftFixture.OwnedWindow]::GetAncestor($button, 1) -ne $Dialog -or
            ![AeRiftFixture.OwnedWindow]::GetWindowThreadProcessId($button, [ref]$buttonPid) -or
            $buttonPid -ne $OwnedProcess.Id -or
            ![AeRiftFixture.OwnedWindow]::GetClassName($button, $class, $class.Capacity) -or
            $class.ToString() -ine 'Button' -or
            ![AeRiftFixture.OwnedWindow]::IsWindowVisible($button) -or
            ![AeRiftFixture.OwnedWindow]::IsWindowEnabled($button) -or
            (Find-Chooser) -ne $Dialog -or
            [AeRiftFixture.OwnedWindow]::GetForegroundWindow() -ne $Dialog) {
            Write-Host "Workspace picker owned action: id=$id directMatchCount=$matches nativeHandleFound=$($button -ne [IntPtr]::Zero)"
            throw 'Could not verify the exact standard native dialog action.'
        }
        $reply = [UIntPtr]::Zero
        # BM_CLICK, SMTO_BLOCK|SMTO_ABORTIFHUNG, at most two seconds, exact verified button HWND.
        $sent = [AeRiftFixture.OwnedWindow]::SendMessageTimeout(
            $button, 0x00f5, [UIntPtr]::Zero, [IntPtr]::Zero, 3, 2000, [ref]$reply)
        if ($sent -eq [IntPtr]::Zero) { throw 'Exact native dialog button did not respond.' }
    }

    function Get-NativeClass([IntPtr]$Control) {
        $name = [Text.StringBuilder]::new(40)
        if ($Control -ne [IntPtr]::Zero -and
            [AeRiftFixture.OwnedWindow]::GetClassName($Control, $name, $name.Capacity)) {
            $name.ToString()
        }
    }

    function Find-OwnedFileNameEdit([IntPtr]$Dialog) {
        # Native shell filename slots only: the direct Edit (1152) or the
        # classic FileName combobox (1148) with its embedded Edit child.
        $direct = [AeRiftFixture.OwnedWindow]::GetDlgItem($Dialog, 1152)
        $combo = [AeRiftFixture.OwnedWindow]::GetDlgItem($Dialog, 1148)
        $candidates = [Collections.Generic.HashSet[IntPtr]]::new()
        if ($direct -ne [IntPtr]::Zero -and
            [AeRiftFixture.OwnedWindow]::GetDlgCtrlID($direct) -eq 1152 -and
            [AeRiftFixture.OwnedWindow]::GetAncestor($direct, 1) -eq $Dialog -and
            (Get-NativeClass $direct) -ieq 'Edit') {
            $null = $candidates.Add($direct)
        }
        if ($combo -ne [IntPtr]::Zero -and
            [AeRiftFixture.OwnedWindow]::GetDlgCtrlID($combo) -eq 1148 -and
            [AeRiftFixture.OwnedWindow]::GetAncestor($combo, 1) -eq $Dialog -and
            (Get-NativeClass $combo) -in @('ComboBox', 'ComboBoxEx32')) {
            $queue = [Collections.Generic.Queue[IntPtr]]::new()
            $queue.Enqueue($combo)
            $examined = 0
            while ($queue.Count -gt 0 -and $examined -lt 64) {
                $child = [AeRiftFixture.OwnedWindow]::GetWindow($queue.Dequeue(), 5)
                while ($child -ne [IntPtr]::Zero -and $examined -lt 64) {
                    $examined++
                    $class = Get-NativeClass $child
                    if ($class -ieq 'Edit') { $null = $candidates.Add($child) }
                    if ($class -in @('ComboBox', 'ComboBoxEx32')) { $queue.Enqueue($child) }
                    $child = [AeRiftFixture.OwnedWindow]::GetWindow($child, 2)
                }
                if ($child -ne [IntPtr]::Zero) { throw 'Native filename controls exceeded the fixture limit.' }
            }
            if ($queue.Count -gt 0) { throw 'Native filename controls exceeded the fixture limit.' }
        }
        $verified = @()
        foreach ($candidate in $candidates) {
            $editPid = [uint32]0
            if ([AeRiftFixture.OwnedWindow]::IsChild($Dialog, $candidate) -and
                [AeRiftFixture.OwnedWindow]::GetWindowThreadProcessId($candidate, [ref]$editPid) -and
                $editPid -eq $OwnedProcess.Id -and
                [AeRiftFixture.OwnedWindow]::IsWindowVisible($candidate) -and
                [AeRiftFixture.OwnedWindow]::IsWindowEnabled($candidate) -and
                ([AeRiftFixture.OwnedWindow]::GetWindowLong($candidate, -16) -band 0x0800) -eq 0) {
                $verified += $candidate
            }
        }
        if ($verified.Count -ne 1) {
            Write-Host "Owned native filename slot: direct=$($direct -ne [IntPtr]::Zero) combo=$($combo -ne [IntPtr]::Zero) discovered=$($candidates.Count) verified=$($verified.Count)"
            throw 'Could not verify exactly one writable native filename control.'
        }
        return $verified[0]
    }

    function Set-SyntheticFolderName([IntPtr]$Dialog, [string]$SyntheticPath) {
        if ($SyntheticPath -cne $chosen -or (Find-Chooser) -ne $Dialog -or
            [AeRiftFixture.OwnedWindow]::GetForegroundWindow() -ne $Dialog) {
            throw 'Refusing a folder field outside the exact owned fixture.'
        }
        $editHandle = Find-OwnedFileNameEdit $Dialog
        if ((Find-Chooser) -ne $Dialog -or [AeRiftFixture.OwnedWindow]::GetForegroundWindow() -ne $Dialog -or
            (Find-OwnedFileNameEdit $Dialog) -ne $editHandle) {
            throw 'Native folder field changed before its action.'
        }
        # WM_SETTEXT for this exact writable native Edit, not keyboard input.
        # Only the path created in the isolated fixture is passed here.
        $reply = [UIntPtr]::Zero
        $sent = [AeRiftFixture.OwnedWindow]::SendTextTimeout(
            $editHandle, 0x000c, [UIntPtr]::Zero, $SyntheticPath, 3, 2000, [ref]$reply)
        if ($sent -eq [IntPtr]::Zero -or $reply -eq [UIntPtr]::Zero) {
            throw 'Verified native filename control rejected the synthetic path.'
        }
    }

    function Select-Chooser([bool]$Cancel, [string]$SyntheticPath, [string]$Stage) {
        try {
            $dialogHandle = Wait-Fixture { Find-Chooser } 'No visible native picker matched the exact process and root owner.'
        } catch {
            $state = Read-ChooserState
            $foreground = [AeRiftFixture.OwnedWindow]::GetForegroundWindow()
            $ownedForeground = $foreground -eq $hwnd
            $popupOwned = $foreground -ne [IntPtr]::Zero -and $foreground -ne $hwnd -and
                [AeRiftFixture.OwnedWindow]::GetAncestor($foreground, 3) -eq $hwnd
            Write-Host "Workspace picker stage=${Stage}: probeAvailable=$($null -ne $state) panel=$($state.panel) busy=$($state.busy) alert=$($state.alert) failure=$($state.failure) embedded=$($state.embedded) webFocused=$($state.focused) visible=$($state.visible) uuid=$($state.uuid) ownerForeground=$ownedForeground ownedPopupForeground=$popupOwned"
            if ($state.alert) { throw 'Installed app reported folder access unavailable before any matching native dialog was observed.' }
            throw
        }
        Write-Host "Workspace picker stage=${Stage}: exact owned native dialog found."
        if (!$Cancel) { Set-SyntheticFolderName $dialogHandle $SyntheticPath }
        Invoke-ExactDialogAction $dialogHandle $Cancel
        Wait-Fixture { !(Find-Chooser) } 'Native folder dialog did not close.' | Out-Null
    }

    function Go-WorkspaceRoute([string]$Name) {
        Invoke-AppExpression $Socket $Id "document.querySelector('.ae-orbit-trigger').click()" $Timeout | Out-Null
        $choice = ".ae-orbit-choice[aria-label='$Name']"
        Wait-AppCondition $Socket $Id "!!document.querySelector(`"$choice`")" $Timeout 'Requested Orbit route did not appear.'
        Invoke-AppExpression $Socket $Id "document.querySelector(`"$choice`").click()" $Timeout | Out-Null
        Wait-AppCondition $Socket $Id "document.querySelector('#aerift-desktop-destination')?.textContent === '$Name'" $Timeout 'Requested Orbit route did not open.'
    }

    $root = Join-Path ((Resolve-Path -LiteralPath $env:RUNNER_TEMP).ProviderPath) ('aerift-owned-picker-' + [Guid]::NewGuid().ToString('N'))
    New-Item -Path $root -ItemType Directory -ErrorAction Stop | Out-Null
    $chosen = Join-Path $root 'Selected'
    $moved = Join-Path $root 'Renamed'
    $outside = Join-Path $root 'Unselected'
    $link = Join-Path $chosen 'excluded-junction'
    try {
        foreach ($directory in @($chosen, $outside, (Join-Path $chosen 'fixture-visible-child'))) {
            New-Item -Path $directory -ItemType Directory -ErrorAction Stop | Out-Null
        }
        $item = Join-Path $chosen 'fixture-visible.txt'
        [IO.File]::WriteAllBytes($item, [byte[]]@(1,2,3))
        [IO.File]::WriteAllBytes((Join-Path $outside 'excluded-link-target.txt'), [byte[]]@(4))
        $volume = @(Get-Volume -FilePath $item -ErrorAction Stop)
        if ($volume.Count -ne 1 -or $volume[0].FileSystem -cne 'NTFS' -or $volume[0].DriveType -ne 'Fixed') {
            throw 'Owned picker fixture requires one fixed NTFS volume.'
        }
        New-Item -Path $link -ItemType Junction -Target $outside -ErrorAction Stop | Out-Null

        Go-WorkspaceRoute 'Workspace'
        $fileCard = '.aw-card-button[aria-label="File Browser"]'
        Wait-AppCondition $Socket $Id "!!document.querySelector('$fileCard')" $Timeout 'Files card was not rendered in the real Workspace.'
        Invoke-AppExpression $Socket $Id "document.querySelector('$fileCard').click()" $Timeout | Out-Null
        $panel = "document.querySelector('section[aria-label=`"Browse a local folder`"]')"
        Wait-AppCondition $Socket $Id "!!($panel)" $Timeout 'Real Windows Files panel did not render.'
        $OwnedProcess.Refresh()
        $hwnd = $OwnedProcess.MainWindowHandle
        if ($hwnd -eq [IntPtr]::Zero) { throw 'Installed app has no native owner window.' }
        if ((Find-Chooser) -or (Invoke-AppExpression $Socket $Id "!!($panel)?.querySelector('bdi')" $Timeout)) {
            throw 'Folder information or prompt was visible without a choice.'
        }
        [AeRiftFixture.OwnedWindow]::SetForegroundWindow($hwnd) | Out-Null
        Wait-Fixture { [AeRiftFixture.OwnedWindow]::GetForegroundWindow() -eq $hwnd } 'Owned app was not actually foreground.' | Out-Null

        $choose = "[...($panel).querySelectorAll('button')].find(b => b.textContent.trim() === 'Choose folder')"
        Click-Chooser
        Select-Chooser $true '' 'cancel'
        Wait-AppCondition $Socket $Id "!!($choose) && !($choose).disabled && !($panel).querySelector('bdi,[role=alert]')" $Timeout 'Cancel did not leave a clean chooser state.'

        $expected = "JSON.stringify([...($panel).querySelectorAll('bdi')].map(n=>n.textContent).sort()) === '[`"fixture-visible-child`",`"fixture-visible.txt`"]'"
        Click-Chooser
        Select-Chooser $false $chosen 'choose'
        Wait-AppCondition $Socket $Id $expected $Timeout 'Folder list differs from the bounded synthetic metadata.'
        $absolute = ConvertTo-Json -InputObject $chosen -Compress
        if (Invoke-AppExpression $Socket $Id "($panel).textContent.includes($absolute)" $Timeout) {
            throw 'Native absolute path appeared in the rendered panel.'
        }

        # The handle denies rename while current. After real route exit,
        # moving the owned synthetic root witnesses actual handle release.
        try {
            [IO.Directory]::Move($chosen, $moved)
            [IO.Directory]::Move($moved, $chosen)
            throw 'The selected directory was not pinned while the page was open.'
        } catch {
            $cause = $_.Exception.GetBaseException()
            if ((Test-Path -LiteralPath $moved) -or ($cause.HResult -band 0xffff) -notin @(5, 32)) { throw }
        }
        Go-WorkspaceRoute 'Rift'
        Wait-AppCondition $Socket $Id "!($panel)" $Timeout 'Leaving Workspace did not unmount folder metadata.'
        Wait-Fixture {
            try { [IO.Directory]::Move($chosen, $moved); $true }
            catch {
                if (($_.Exception.GetBaseException().HResult -band 0xffff) -notin @(5, 32)) { throw }
                $false
            }
        } 'Leaving Workspace did not release the native held directory.' | Out-Null
        [IO.Directory]::Move($moved, $chosen)

        Go-WorkspaceRoute 'Workspace'
        Wait-AppCondition $Socket $Id "!!($choose) && !($choose).disabled && !($panel).querySelector('bdi')" $Timeout 'Returning to Files unexpectedly restored a grant.'
        Click-Chooser
        Select-Chooser $false $chosen 'reopen'
        Wait-AppCondition $Socket $Id $expected $Timeout 'A new explicit choice did not obtain metadata.'
        if (!$OwnedProcess.CloseMainWindow()) { throw 'Native close did not reach the owned app window.' }
        Wait-Fixture { $OwnedProcess.HasExited } 'Ordinary owned app did not close.' | Out-Null
        [IO.Directory]::Move($chosen, $moved)
        [IO.Directory]::Move($moved, $chosen)
        return [ordered]@{
            usedForegroundOwner = $true
            noPromptBeforeAction = $true
            cancelledNatively = $true
            listedExactSyntheticMetadata = $true
            noJunctionOrAbsolutePath = $true
            heldWhilePaneOpen = $true
            releasedOnRouteChange = $true
            releasedOnNativeClose = $true
        }
    } finally {
        # This is the last operation on this owned install. On a failed
        # assertion, release any pinned fixture directory before removal.
        if (!$OwnedProcess.HasExited) {
            Stop-Process -InputObject $OwnedProcess -ErrorAction SilentlyContinue
            $null = $OwnedProcess.WaitForExit(5000)
        }
        try {
            if (Test-Path -LiteralPath $link) { [IO.Directory]::Delete($link) }
            if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
        } catch {
            Write-Warning 'Could not clean the owned synthetic picker folder; disposable runner teardown will remove it.'
        }
    }
}
