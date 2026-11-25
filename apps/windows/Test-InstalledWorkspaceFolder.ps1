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
'@

    function Find-Chooser {
        $owned = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$OwnedProcess.Id)
        $native = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
        $dialogs = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.AndCondition]::new($owned, $native))
        if ($dialogs.Count -gt 1) { throw 'Multiple owned dialog candidates.' }
        if ($dialogs.Count -eq 1) { return $dialogs[0] }
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

    function Select-Chooser([bool]$Cancel, [string]$SyntheticPath) {
        $dialog = Wait-Fixture { Find-Chooser } 'Native folder dialog did not open in the owned process.'
        if (!$Cancel) {
            $shellId = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1152')
            $edit = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
            $fields = $dialog.FindAll([System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.AndCondition]::new($shellId, $edit))
            if ($fields.Count -ne 1 -or $fields[0].Current.ProcessId -ne $OwnedProcess.Id -or
                $fields[0].Current.ClassName -cne 'Edit' -or !$fields[0].Current.IsEnabled -or
                $fields[0].Current.Name -cnotin @('Folder:', 'Folder name:', 'File name:')) {
                throw 'Could not identify the exact native folder name field.'
            }
            $field = $fields[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($field.Current.IsReadOnly) { throw 'Native name field unexpectedly read-only.' }
            $field.SetValue($SyntheticPath)
        }
        $buttonId = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $(if ($Cancel) { '2' } else { '1' }))
        $type = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
        $buttons = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.AndCondition]::new($buttonId, $type))
        if ($buttons.Count -ne 1 -or $buttons[0].Current.ProcessId -ne $OwnedProcess.Id -or !$buttons[0].Current.IsEnabled) {
            throw 'Could not identify the exact native dialog action.'
        }
        $buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
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
        if ((Find-Chooser) -or (Invoke-AppExpression $Socket $Id "!!($panel)?.querySelector('bdi')" $Timeout)) {
            throw 'Folder information or prompt was visible without a choice.'
        }
        $OwnedProcess.Refresh()
        $hwnd = $OwnedProcess.MainWindowHandle
        if ($hwnd -eq [IntPtr]::Zero) { throw 'Installed app has no native owner window.' }
        [AeRiftFixture.OwnedWindow]::SetForegroundWindow($hwnd) | Out-Null
        Wait-Fixture { [AeRiftFixture.OwnedWindow]::GetForegroundWindow() -eq $hwnd } 'Owned app was not actually foreground.' | Out-Null

        $choose = "[...($panel).querySelectorAll('button')].find(b => b.textContent.trim() === 'Choose folder')"
        Invoke-AppExpression $Socket $Id "($choose).click()" $Timeout | Out-Null
        Select-Chooser $true ''
        Wait-AppCondition $Socket $Id "!!($choose) && !($choose).disabled && !($panel).querySelector('bdi,[role=alert]')" $Timeout 'Cancel did not leave a clean chooser state.'

        $expected = "JSON.stringify([...($panel).querySelectorAll('bdi')].map(n=>n.textContent).sort()) === '[`"fixture-visible-child`",`"fixture-visible.txt`"]'"
        Invoke-AppExpression $Socket $Id "($choose).click()" $Timeout | Out-Null
        Select-Chooser $false $chosen
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
        Invoke-AppExpression $Socket $Id "($choose).click()" $Timeout | Out-Null
        Select-Chooser $false $chosen
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
