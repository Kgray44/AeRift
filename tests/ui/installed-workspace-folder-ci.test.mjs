import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const read = name => readFileSync(new URL("../../" + name, import.meta.url), "utf8");
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
  assert.match(fixture, /ProcessIdProperty, \[int\]\$OwnedProcess.Id/);
  assert.match(fixture, /GetForegroundWindow\(\) -eq \$hwnd/);
  assert.match(fixture, /AutomationIdProperty, '1152'/);
  assert.match(fixture, /Select-Chooser \$true ''/);
  assert.match(fixture, /Select-Chooser \$false \$chosen/);
  assert.match(fixture, /\$env:RUNNER_TEMP[\s\S]*Get-Volume -FilePath \$item/);
  assert.match(fixture, /-ItemType Junction -Target \$outside/);
  assert.match(fixture, /CloseMainWindow\(\)/);
  assert.doesNotMatch(fixture, /SendKeys|__TAURI_INTERNALS__|window\.invoke|Start-Process/);
});
