import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const read = name => readFileSync(new URL("../../" + name, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const fixture = read("apps/windows/Test-InstalledWorkspaceFolder.ps1");
const shell = read("apps/windows/Test-InstalledShell.ps1");
const workflow = read(".github/workflows/windows-app.yml");

test("the existing ordinary installer lane requires the disposable native folder fixture", () => {
  assert.match(workflow, /AERIFT_WORKSPACE_FOLDER_FIXTURE: synthetic-fixed-ntfs-only\s+run: \.\/apps\/windows\/Test-InstalledShell\.ps1/);
  assert.match(shell, /RUNNER_ENVIRONMENT -cne 'github-hosted'/);
  assert.match(shell, /Test-InstalledWorkspaceFolder \$socket \(\[ref\]\$id\) \$deadline.Token \$process/);
  assert.match(shell, /workspaceSyntheticNativeFolder = \$workspaceFolderFixture/);
  assert.match(fixture, /RUNNER_ENVIRONMENT -cne 'github-hosted'/);
});

test("fixture drives only its foreground app's actual chooser and synthetic fixed NTFS scope", () => {
  assert.match(fixture, /GetWindowThreadProcessId\(\$candidate, \[ref\]\$processId\)[\s\S]*\$processId -ne \$OwnedProcess.Id/);
  assert.match(fixture, /GetAncestor\(\$candidate, 3\) -ne \$hwnd/);
  assert.match(fixture, /AutomationElement\]::FromHandle\(\$candidate\)/);
  assert.match(fixture, /Input\.dispatchMouseEvent/);
  assert.match(fixture, /button\.contains\(document\.elementFromPoint/);
  assert.match(fixture, /GetForegroundWindow\(\) -eq \$hwnd/);
  assert.match(fixture, /GetDlgItem\(\$Dialog, 1152\)/);
  assert.match(fixture, /Select-Chooser \$true ''/);
  assert.match(fixture, /Select-Chooser \$false \$chosen/);
  assert.match(fixture, /\$env:RUNNER_TEMP[\s\S]*Get-Volume -FilePath \$item/);
  assert.match(fixture, /-ItemType Junction -Target \$outside/);
  assert.match(fixture, /CloseMainWindow\(\)/);
  assert.doesNotMatch(fixture, /SendKeys|__TAURI_INTERNALS__|window\.invoke|Start-Process/);
});

test("diagnostics expose booleans rather than app data, and both WebView expressions parse", () => {
  assert.match(fixture, /probeAvailable=/);
  assert.match(fixture, /ownerForeground=\$ownedForeground ownedPopupForeground=\$popupOwned/);
  const scripts = [...fixture.matchAll(/\$(?:probe|point) = @'\n([\s\S]*?)\n'@/g)];
  assert.equal(scripts.length, 2);
  for (const [, source] of scripts) assert.doesNotThrow(() => new Function(`return (${source});`));
});

test("native dialog actions target only the unique verified standard direct child", () => {
  assert.match(fixture, /GetDlgItem\(\$Dialog, \$id\)/);
  assert.match(fixture, /if \(\$Cancel\) \{ 2 \} else \{ 1 \}/);
  assert.match(fixture, /\$matches -ne 1[\s\S]*GetAncestor\(\$button, 1\) -ne \$Dialog[\s\S]*\$buttonPid -ne \$OwnedProcess.Id/);
  assert.match(fixture, /SendMessageTimeout\(\s*\$button, 0x00f5, \[UIntPtr\]::Zero, \[IntPtr\]::Zero, 3, 2000, \[ref\]\$reply\)/);
  assert.match(fixture, /Invoke-ExactDialogAction \$dialogHandle \$Cancel[\s\S]*!?\(Find-Chooser\)/);
});

test("writes only the unique verified native filename slot with the synthetic path", () => {
  assert.match(fixture, /GetDlgItem\(\$Dialog, 1148\)/);
  assert.match(fixture, /IsChild\(\$Dialog, \$candidate\)[\s\S]*\$editPid -eq \$OwnedProcess.Id/);
  assert.match(fixture, /\$verified.Count -ne 1/);
  assert.match(fixture, /\$SyntheticPath -cne \$chosen[\s\S]*\(Find-OwnedFileNameEdit \$Dialog\) -ne \$editHandle/);
  assert.match(fixture, /SendTextTimeout\(\s*\$editHandle, 0x000c, \[UIntPtr\]::Zero, \$SyntheticPath, 3, 2000, \[ref\]\$reply\)/);
  assert.doesNotMatch(fixture, /\$shellid\b/i);
});
