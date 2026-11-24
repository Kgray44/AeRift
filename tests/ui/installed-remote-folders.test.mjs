import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const read = path => readFileSync(new URL("../../" + path, import.meta.url), "utf8");

test("installed Windows Remote folder fixture does not expose an ordinary app testing bypass", () => {
  const harness = read("apps/windows/Test-InstalledRemoteFolders.ps1");
  const companion = read("apps/aerift/src-tauri/examples/installed_remote_folder_peer.rs");
  const installed = read("apps/aerift/src-tauri/src/private_remote_app.rs");
  assert.match(harness, /RUNNER_ENVIRONMENT -ne 'github-hosted'/);
  assert.match(harness, /SYNTHETIC PRIVATE FOLDERS ONLY/);
  assert.match(harness, /Get-NetIPAddress -IPAddress '127\.0\.0\.1'/);
  assert.match(harness, /-PolicyStore ActiveStore -SkipAsSource/);
  assert.doesNotMatch(harness, /__TAURI_INTERNALS__|tauri.*\.invoke\(/);
  assert.match(companion, /TcpListener::bind\(\(endpoint\.ip\(\), 0\)\)/);
  assert.match(companion, /PrivateRemoteProfile::open/);
  assert.match(companion, /node\.redeem/);
  assert.match(companion, /send_folder/);
  assert.doesNotMatch(installed, /SYNTHETIC PRIVATE FOLDERS ONLY|100\.127\.255\.250/);
  assert.match(installed, /!cfg!\(feature = "private-remote-folder-qualification"\)/);
});

test("installed fixture actions match the visible, consent-preserving Windows flow", () => {
  const harness = read("apps/windows/Test-InstalledRemoteFolders.ps1");
  const remote = read("apps/aerift/src/windows/PrivateRemoteDev.tsx");
  const folders = read("apps/aerift/src/windows/PrivateRemoteFolders.tsx");
  for (const label of ["Start Remote", "Create five-minute invitation", "Approve Remote pairing",
    "Accept file", "Revoke Remote access", "Confirm Remote revoke", "Stop Remote"]) {
    assert.ok(harness.includes(`Button '${label}'`) && remote.includes(label), label);
  }
  for (const label of ["Accept folder and choose destination", "Save verified folder without replacing files",
    "Dismiss receipt"]) {
    assert.ok(harness.includes(`Button '${label}'`) && folders.includes(label), label);
  }
  assert.match(harness, /Choose-NativeDestination \$true[\s\S]*?Destination changed before consent/);
  assert.match(harness, /Verified receipt wrote before separate Save[\s\S]*?Held native destination lease allowed substitution/);
  assert.match(harness, /A spent receipt offered a second Save[\s\S]*?Existing destination bytes were replaced/);
  assert.match(harness, /CHECK REVOKED FIXTURE[\s\S]*?not_admitted/);
});

test("the installed fixture starts only from the exact owned draft, with no release authority", () => {
  const job = read(".github/workflows/installed-remote-folders-qualification.yml");
  assert.match(job, /pull_request:\s+branches: \[main\]\s+paths:/);
  assert.match(job, /permissions:\s+contents: read/);
  assert.match(job, /github\.event\.pull_request\.head\.repo\.full_name == 'Kgray44\/AeRift'/);
  assert.match(job, /github\.event\.pull_request\.draft/);
  assert.match(job, /github\.head_ref == 'qual\/windows-installed-private-folders'/);
  assert.match(job, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(job, /persist-credentials: false/);
  assert.doesNotMatch(job, /pull_request_target|secrets\.|upload-artifact|contents:\s*write/);
  assert.equal((job.match(/^\s+- uses: .*@[a-f0-9]{40}$/gm) ?? []).length, 2);
});
