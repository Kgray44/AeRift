#!/usr/bin/env python3
"""Isolated device archive / TestFlight transport. Credentials never enter artifacts."""

import argparse
import base64
from contextlib import contextmanager
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

TEAM = "X2JZ9N65V2"
BUNDLE = "com.kgamazing44.aerift"
SECRET_NAMES = (
    "AERIFT_DISTRIBUTION_P12_BASE64", "AERIFT_DISTRIBUTION_P12_PASSWORD",
    "AERIFT_APPSTORE_PROFILE_BASE64", "AERIFT_ASC_PRIVATE_KEY_P8",
)


class Failure(Exception):
    pass


def require(condition, label):
    if not condition:
        raise Failure(label)


def signature_raw(der):
    """OpenSSL ECDSA ASN.1 integers -> JWT's fixed-width ES256 R || S."""
    def item(position, tag):
        require(der[position] == tag, "JWT_SIGNATURE_INVALID")
        length, position = der[position + 1], position + 2
        if length & 128:
            count = length & 127
            length = int.from_bytes(der[position:position + count], "big")
            position += count
        return der[position:position + length], position + length
    sequence, end = item(0, 0x30)
    require(end == len(der), "JWT_SIGNATURE_INVALID")
    original = der
    der = sequence
    left, position = item(0, 0x02)
    right, end = item(position, 0x02)
    require(end == len(sequence), "JWT_SIGNATURE_INVALID")
    der = original
    return int.from_bytes(left, "big").to_bytes(32, "big") + int.from_bytes(right, "big").to_bytes(32, "big")


def validate_profile(profile, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    expiry = profile["ExpirationDate"].replace(tzinfo=dt.timezone.utc)
    entitlements = profile.get("Entitlements", {})
    require(profile.get("TeamIdentifier") == [TEAM], "PROFILE_TEAM_MISMATCH")
    require(entitlements.get("application-identifier") == f"{TEAM}.{BUNDLE}", "PROFILE_APP_MISMATCH")
    require(entitlements.get("com.apple.developer.team-identifier") == TEAM, "PROFILE_ENTITLEMENT_TEAM_MISMATCH")
    require(entitlements.get("get-task-allow") is False, "DISTRIBUTION_PROFILE_REQUIRED")
    require(not profile.get("ProvisionedDevices") and not profile.get("ProvisionsAllDevices"), "APPSTORE_PROFILE_REQUIRED")
    require(entitlements.get("beta-reports-active") is True, "TESTFLIGHT_PROFILE_REQUIRED")
    require(expiry > now + dt.timedelta(hours=1), "PROFILE_EXPIRED_OR_EXPIRING")
    require(re.fullmatch(r"[A-Fa-f0-9-]{36}", profile.get("UUID", "")), "PROFILE_UUID_INVALID")
    certificates = profile.get("DeveloperCertificates", [])
    require(len(certificates) == 1, "PROFILE_SINGLE_CERTIFICATE_REQUIRED")
    return hashlib.sha1(certificates[0]).hexdigest().upper()


def altool_command(action, ipa, key_id, issuer, api_key=None):
    """Xcode 26 altool takes the archive as the action's positional value."""
    require(action in ("validate", "upload"), "ALTOOL_ACTION_INVALID")
    flag = "--validate-app" if action == "validate" else "--upload-package"
    command = ["xcrun", "altool", flag, str(ipa), "--api-key", key_id,
               "--api-issuer", issuer, "--output-format", "json"]
    if api_key:
        command.extend(["--p8-file-path", str(api_key)])
    return command


def altool_diagnostics(output, secret_values=()):
    """Keep bounded error fields, never altool's raw response or authentication."""
    def scrub(value):
        for secret in secret_values:
            if secret:
                value = value.replace(secret, "[REDACTED]")
                for line in secret.splitlines():
                    if line.strip():
                        value = value.replace(line.strip(), "[REDACTED]")
        value = re.sub(r"-----BEGIN [^-]+-----.*?-----END [^-]+-----", "[REDACTED_KEY]", value, flags=re.S)
        value = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[REDACTED_TOKEN]", value)
        value = re.sub(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+", "[REDACTED_EMAIL]", value)
        return value[:800]

    # xcrun may prefix the JSON with its tool-path banner. Parse JSON only;
    # unstructured output is deliberately not copied into public artifacts.
    decoder = json.JSONDecoder()
    parsed = None
    for match in re.finditer(r"\{", output[:2_000_000]):
        try:
            value, _ = decoder.raw_decode(output, match.start())
            if isinstance(value, dict):
                parsed = value
                break
        except ValueError:
            continue
    messages = []
    if parsed is not None:
        for key in ("product-errors", "errors", "messages"):
            entries = parsed.get(key, [])
            if not isinstance(entries, list):
                continue
            for entry in entries[:8]:
                if not isinstance(entry, dict):
                    continue
                safe = {name: scrub(str(entry[name])) for name in ("code", "title", "message", "detail", "description")
                        if isinstance(entry.get(name), (str, int, float))}
                if safe:
                    messages.append(safe)
    return {"jsonResponseParsed": parsed is not None, "messages": messages[:8]}


class Runner:
    def __init__(self, args):
        self.args = args
        self.root = Path.cwd()
        self.public = self.root / "artifacts/aerift-testflight/public"
        self.public.mkdir(parents=True, exist_ok=True)
        self.ownership = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / "aerift-testflight-ownership.json"
        require(not self.ownership.exists(), "PREVIOUS_OWNERSHIP_REQUIRES_CLEANUP")
        self.temp = Path(tempfile.mkdtemp(prefix="aerift-testflight-", dir=os.environ.get("RUNNER_TEMP")))
        self.temp.chmod(0o700)
        self.keychain = None
        self.installed_profiles = []
        self.previous_keychains = []
        self.stage = "PREFLIGHT"
        self.receipt = {
            "schemaVersion": 1, "candidateSha": args.candidate, "mode": args.mode,
            "teamId": TEAM, "bundleId": BUNDLE,
            "version": args.version, "build": args.build,
            "uploadAccepted": False, "appleProcessing": "NOT_STARTED",
            "physicalInstallationProven": False,
        }
        self.save_ownership()

    def save_ownership(self):
        self.ownership.write_text(json.dumps({"temp": str(self.temp), "keychain": str(self.keychain) if self.keychain else None,
                                             "profiles": [str(value) for value in self.installed_profiles],
                                             "previousKeychains": self.previous_keychains}), encoding="utf-8")
        self.ownership.chmod(0o600)

    def run(self, command, *, data=None, public_log=False, env=None, altool_result=False, cwd=None):
        result = subprocess.run(command, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={k: v for k, v in (env if env is not None else os.environ).items() if k not in SECRET_NAMES},
                                cwd=cwd)
        if altool_result:
            diagnostic = altool_diagnostics((result.stdout + result.stderr).decode("utf-8", errors="replace"),
                                           [os.environ.get(name, "") for name in SECRET_NAMES])
            diagnostic["exitCode"] = result.returncode
            (self.public / f"{self.stage.lower()}.json").write_text(json.dumps(diagnostic, indent=2) + "\n", encoding="utf-8")
        if public_log:
            output = (result.stdout + result.stderr).decode("utf-8", errors="replace")
            for name in SECRET_NAMES:
                value = os.environ.get(name, "")
                if value:
                    output = output.replace(value, "[REDACTED]")
            output = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[REDACTED_TOKEN]", output)
            (self.public / f"{self.stage.lower()}.log").write_text(output, encoding="utf-8")
        if result.returncode:
            # Record only the executable and exit status, never command arguments
            # (security import arguments contain the PKCS#12 password).
            self.receipt["failedTool"] = Path(command[0]).name
            self.receipt["failedExitCode"] = result.returncode
        require(result.returncode == 0, f"COMMAND_FAILED_{self.stage}")
        return result.stdout

    def private_file(self, name, data):
        destination = self.temp / name
        destination.write_bytes(data)
        destination.chmod(0o600)
        return destination

    def configure_signing(self):
        self.stage = "SIGNING_PREFLIGHT"
        for name in SECRET_NAMES:
            require(bool(os.environ.get(name)), f"SECRET_MISSING_{name}")
        self.key_id = os.environ.get("AERIFT_ASC_KEY_ID", "")
        self.issuer = os.environ.get("AERIFT_ASC_ISSUER_ID", "")
        require(re.fullmatch(r"[A-Za-z0-9]{10}", self.key_id), "ASC_KEY_ID_REQUIRED")
        require(re.fullmatch(r"[a-fA-F0-9-]{36}", self.issuer), "ASC_TEAM_KEY_ISSUER_REQUIRED")
        profile_path = self.private_file("app.mobileprovision", base64.b64decode(
            "".join(os.environ["AERIFT_APPSTORE_PROFILE_BASE64"].split()), validate=True))
        profile = plistlib.loads(self.run(["security", "cms", "-D", "-i", str(profile_path)]))
        self.identity = validate_profile(profile)
        self.profile_uuid = profile["UUID"]
        p12 = self.private_file("distribution.p12", base64.b64decode(
            "".join(os.environ["AERIFT_DISTRIBUTION_P12_BASE64"].split()), validate=True))
        self.keychain = self.temp / "signing.keychain-db"
        keychain_password = secrets.token_urlsafe(32)
        self.previous_keychains = shlex.split(self.run(["security", "list-keychains", "-d", "user"]).decode())
        self.save_ownership()
        self.run(["security", "create-keychain", "-p", keychain_password, str(self.keychain)])
        self.run(["security", "set-keychain-settings", "-lut", "21600", str(self.keychain)])
        self.run(["security", "unlock-keychain", "-p", keychain_password, str(self.keychain)])
        self.run(["security", "import", str(p12), "-P", os.environ["AERIFT_DISTRIBUTION_P12_PASSWORD"],
                  "-A", "-t", "cert", "-f", "pkcs12", "-k", str(self.keychain)])
        self.run(["security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-k", keychain_password, str(self.keychain)])
        self.run(["security", "list-keychains", "-d", "user", "-s", str(self.keychain), *self.previous_keychains])
        identities = self.run(["security", "find-identity", "-v", "-p", "codesigning", str(self.keychain)]).decode()
        require(self.identity in identities and "Apple Distribution:" in identities, "PROFILE_CERTIFICATE_PRIVATE_KEY_UNAVAILABLE")
        # Xcode 16+ location plus legacy lookup; install only owned UUID files.
        for relative in ("Library/Developer/Xcode/UserData/Provisioning Profiles", "Library/MobileDevice/Provisioning Profiles"):
            directory = Path.home() / relative
            directory.mkdir(parents=True, exist_ok=True)
            installed = directory / f"{self.profile_uuid}.mobileprovision"
            require(not installed.exists(), "PROFILE_DESTINATION_ALREADY_EXISTS")
            self.installed_profiles.append(installed)
            self.save_ownership()
            shutil.copyfile(profile_path, installed)
            installed.chmod(0o600)
        self.configure_api()
        self.receipt["profileValidated"] = True
        self.receipt["certificateSha1"] = self.identity

    def configure_api(self):
        self.key_id = os.environ.get("AERIFT_ASC_KEY_ID", "")
        self.issuer = os.environ.get("AERIFT_ASC_ISSUER_ID", "")
        require(re.fullmatch(r"[A-Za-z0-9]{10}", self.key_id), "ASC_KEY_ID_REQUIRED")
        require(re.fullmatch(r"[a-fA-F0-9-]{36}", self.issuer), "ASC_TEAM_KEY_ISSUER_REQUIRED")
        require(bool(os.environ.get("AERIFT_ASC_PRIVATE_KEY_P8")), "ASC_PRIVATE_KEY_REQUIRED")
        keys = self.temp / "asc"
        keys.mkdir(mode=0o700)
        self.api_key = keys / f"AuthKey_{self.key_id}.p8"
        self.api_key.write_text(os.environ["AERIFT_ASC_PRIVATE_KEY_P8"], encoding="utf-8")
        self.api_key.chmod(0o600)
        self.run(["openssl", "pkey", "-in", str(self.api_key), "-noout", "-check"])

    def xcode_settings(self, project, scheme, configuration):
        output = self.run([
            "xcodebuild", "-quiet", "-showBuildSettings", "-json", "-project", str(project),
            "-scheme", scheme, "-configuration", configuration, "-destination", "generic/platform=iOS",
        ])
        apps = [row for row in json.loads(output)
                if row["buildSettings"].get("PRODUCT_BUNDLE_IDENTIFIER") == BUNDLE
                and row["buildSettings"].get("WRAPPER_EXTENSION") == "app"]
        require(len(apps) == 1, "EXACT_IOS_TARGET_REQUIRED")
        return apps[0]

    @contextmanager
    def tauri_options(self, host, env):
        """Keep the mobile CLI's Xcode options server alive for the archive."""
        self.stage = "TAURI_XCODE_OPTIONS"
        temporary = self.temp / "tauri-options"
        temporary.mkdir(mode=0o700)
        environment = {**env, "TMPDIR": str(temporary) + "/"}
        address = temporary / f"{BUNDLE}-server-addr"
        log_path = ((self.public if self.args.mode == "unsigned" else self.temp)
                    / "tauri-xcode-options.log")
        with log_path.open("wb") as log:
            process = subprocess.Popen(
                ["npm", "run", "tauri", "--", "ios", "build", "--ci", "--open",
                 "--target", "aarch64", "--", "--locked"],
                cwd=host, env=environment, stdout=log, stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            try:
                deadline = time.monotonic() + 180
                while not address.is_file() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.25)
                require(address.is_file() and process.poll() is None, "TAURI_XCODE_OPTIONS_UNAVAILABLE")
                require(re.fullmatch(r"127\.0\.0\.1:[0-9]+", address.read_text()), "TAURI_OPTIONS_ADDRESS_INVALID")
                yield environment
            finally:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()

    def archive(self):
        self.stage = "TOOLCHAIN"
        require(sys.platform == "darwin", "MACOS_REQUIRED")
        require(self.run(["git", "rev-parse", "HEAD"]).decode().strip() == self.args.candidate, "CANDIDATE_CHECKOUT_MISMATCH")
        xcode = self.run(["xcodebuild", "-version"]).decode().strip()
        match = re.search(r"Xcode (\d+)\.", xcode)
        require(match and int(match[1]) >= 26 and "beta" not in xcode.lower(), "XCODE_26_RELEASE_REQUIRED")
        self.receipt["xcode"] = xcode
        self.receipt["iphoneosSdk"] = self.run(["xcrun", "--sdk", "iphoneos", "--show-sdk-version"]).decode().strip()
        require(int(self.receipt["iphoneosSdk"].split(".")[0]) >= 26, "IOS_26_SDK_REQUIRED")
        signed = self.args.mode in ("signed", "upload")

        # Build the checked-in frontend and generate the same Tauri target used by native CI.
        # Remove signing inputs from package and project-generator subprocesses.
        self.stage = "TAURI_PROJECT_GENERATION"
        public_env = {key: value for key, value in os.environ.items() if key not in SECRET_NAMES}
        host = self.root / "apps/aerift"
        self.run(["npm", "ci"], cwd=self.root, env=public_env, public_log=not signed)
        self.run(["bash", str(self.root / "apps/ios/prepare-apple.sh"), str(host)], env=public_env, public_log=not signed)
        project_root = host / "src-tauri/gen/apple"
        projects = sorted(project_root.glob("*.xcodeproj"))
        require(len(projects) == 1, "ONE_TAURI_XCODE_PROJECT_REQUIRED")
        project = projects[0]
        listed = json.loads(self.run(["xcodebuild", "-list", "-json", "-project", str(project)], env=public_env))
        schemes = listed["project"].get("schemes", [])
        require(len(schemes) == 1, "ONE_TAURI_APP_SCHEME_REQUIRED")
        scheme = schemes[0]
        releases = [name for name in listed["project"].get("configurations", [])
                    if name.casefold() == "release"]
        require(len(releases) == 1, "ONE_TAURI_RELEASE_CONFIGURATION_REQUIRED")
        configuration = releases[0]

        self.archive_path = self.temp / "AeRift.xcarchive"
        with self.tauri_options(host, public_env) as xcode_env:
            if signed:
                self.configure_signing()
                self.app_record()
                self.stage = "SIGNING_SETTINGS_VALIDATION"
                target = self.xcode_settings(project, scheme, configuration)["target"]
                overrides = {
                    "CODE_SIGNING_ALLOWED": "YES", "CODE_SIGN_STYLE": "Manual", "DEVELOPMENT_TEAM": TEAM,
                    "CODE_SIGN_IDENTITY": self.identity, "PROVISIONING_PROFILE_SPECIFIER": self.profile_uuid,
                }
                overlay = {
                    "include": [{"path": str(project_root / "project.yml"), "relativePaths": True}],
                    "targets": {target: {"settings": {"configs": {configuration: overrides}}}},
                }
                spec = self.private_file("signed-project.json", json.dumps(overlay).encode())
                self.run(["xcodegen", "generate", "--spec", str(spec), "--project-root", str(project_root),
                          "--project", str(project_root)], env=xcode_env)
                settings = self.xcode_settings(project, scheme, configuration)["buildSettings"]
                for key, value in overrides.items():
                    require(settings.get(key) == value, f"APP_SIGNING_SETTING_INVALID_{key}")
                self.receipt["appTargetSigningSettingsValidated"] = True
                helper = subprocess.run(["xcrun", "altool", "--help"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                help_text = (helper.stdout + helper.stderr).decode("utf-8", errors="replace")
                self.explicit_p8 = "--p8-file-path" in help_text
                require(self.explicit_p8 or "API_PRIVATE_KEYS_DIR" in help_text, "ALTOOL_KEY_LOOKUP_UNVERIFIED")

            self.stage = "DEVICE_ARCHIVE"
            # Tauri's generated Info.plist uses literal version strings. Xcode
            # build settings alone cannot override them when archiving directly.
            bundle_plists = list(project_root.glob("*_iOS/Info.plist"))
            require(len(bundle_plists) == 1, "ONE_GENERATED_APP_PLIST_REQUIRED")
            bundle_plist = bundle_plists[0]
            metadata = plistlib.loads(bundle_plist.read_bytes())
            metadata["CFBundleShortVersionString"] = self.args.version
            metadata["CFBundleVersion"] = self.args.build
            bundle_plist.write_bytes(plistlib.dumps(metadata, sort_keys=False))
            command = [
                "xcodebuild", "-quiet", "-project", str(project), "-scheme", scheme, "-configuration", configuration,
                "-destination", "generic/platform=iOS", "-archivePath", str(self.archive_path),
                "-derivedDataPath", str(self.temp / "DerivedData"), "archive",
                f"MARKETING_VERSION={self.args.version}", f"CURRENT_PROJECT_VERSION={self.args.build}",
            ]
            # Metal can be the active Xcode toolchain, while embedded Rust/Swift objects
            # resolve their compatibility libraries from Xcode's default Swift toolchain.
            swiftc = Path(self.run(["xcrun", "--toolchain", "XcodeDefault", "--find", "swiftc"],
                                   env=xcode_env).decode().strip())
            library_root = swiftc.parent.parent / "lib"
            swift_libraries = [library_root / relative for relative in ("swift/iphoneos", "swift-5.0/iphoneos")]
            library_paths = " ".join(f'"{path}"' for path in swift_libraries if path.is_dir())
            if library_paths:
                command.append(f"LIBRARY_SEARCH_PATHS=$(inherited) {library_paths}")
            if not signed:
                command.extend(["CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO"])
            self.run(command, env=xcode_env, public_log=not signed)
        self.stage = "ARCHIVE_VALIDATION"
        apps = list((self.archive_path / "Products/Applications").glob("*.app"))
        require(len(apps) == 1, "ONE_ARCHIVED_APP_REQUIRED")
        app = apps[0]
        info = plistlib.loads((app / "Info.plist").read_bytes())
        self.receipt["archivedVersion"] = info.get("CFBundleShortVersionString")
        self.receipt["archivedBuild"] = info.get("CFBundleVersion")
        require(info.get("CFBundleIdentifier") == BUNDLE, "ARCHIVE_BUNDLE_MISMATCH")
        require(info.get("CFBundleShortVersionString") == self.args.version and info.get("CFBundleVersion") == self.args.build, "ARCHIVE_VERSION_MISMATCH")
        require(info.get("NSCameraUsageDescription") and info.get("NSLocalNetworkUsageDescription"), "ARCHIVE_PRIVACY_STRINGS_REQUIRED")
        require("_aerift._tcp" in info.get("NSBonjourServices", []), "ARCHIVE_BONJOUR_SERVICE_REQUIRED")
        require((app / "PrivacyInfo.xcprivacy").is_file(), "ARCHIVE_PRIVACY_MANIFEST_REQUIRED")
        plistlib.loads((app / "PrivacyInfo.xcprivacy").read_bytes())
        self.receipt["deviceArchiveValidated"] = True
        self.receipt["appExecutableSha256"] = hashlib.sha256((app / info["CFBundleExecutable"]).read_bytes()).hexdigest()
        if signed:
            self.run(["codesign", "--verify", "--deep", "--strict", str(app)])
            entitlements = plistlib.loads(self.run(["codesign", "-d", "--entitlements", ":-", str(app)]))
            require(entitlements.get("application-identifier") == f"{TEAM}.{BUNDLE}"
                    and entitlements.get("get-task-allow") is False, "SIGNED_APP_ENTITLEMENTS_INVALID")

    def token(self):
        encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b"=")
        issued = int(time.time())
        header = encode(json.dumps({"alg": "ES256", "kid": self.key_id, "typ": "JWT"}, separators=(",", ":")).encode())
        payload = encode(json.dumps({"iss": self.issuer, "iat": issued, "exp": issued + 600, "aud": "appstoreconnect-v1"}, separators=(",", ":")).encode())
        signing = header + b"." + payload
        signature = self.run(["openssl", "dgst", "-sha256", "-sign", str(self.api_key)], data=signing)
        return (signing + b"." + encode(signature_raw(signature))).decode()

    def api(self, route, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request("https://api.appstoreconnect.apple.com/v1/" + route, data=data,
                                        headers={"Authorization": "Bearer " + self.token(), "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                contents = response.read()
            return json.loads(contents) if contents else {}
        except urllib.error.HTTPError as error:
            raise Failure(f"ASC_HTTP_{error.code}_{self.stage}") from None

    def app_record(self):
        self.stage = "APP_RECORD_VALIDATION"
        apps = self.api("apps?" + urllib.parse.urlencode({"filter[bundleId]": BUNDLE}))["data"]
        require(len(apps) == 1, "EXACT_APPSTORE_CONNECT_RECORD_REQUIRED")
        self.app_id = apps[0]["id"]
        configured = os.environ.get("AERIFT_ASC_APP_ID")
        require(configured and configured == self.app_id, "ASC_APP_ID_MISMATCH")
        self.receipt["appStoreConnectAppId"] = self.app_id

    def export_upload(self):
        self.stage = "APPSTORE_EXPORT"
        options = {"method": "app-store-connect", "destination": "export", "teamID": TEAM, "signingStyle": "manual",
                   "signingCertificate": self.identity, "provisioningProfiles": {BUNDLE: self.profile_uuid},
                   "manageAppVersionAndBuildNumber": False, "stripSwiftSymbols": True, "uploadSymbols": True}
        options_path = self.private_file("ExportOptions.plist", plistlib.dumps(options))
        export = self.temp / "export"
        self.run(["xcodebuild", "-exportArchive", "-archivePath", str(self.archive_path), "-exportPath", str(export),
                  "-exportOptionsPlist", str(options_path)])
        ipas = list(export.glob("*.ipa"))
        require(len(ipas) == 1, "ONE_EXPORTED_IPA_REQUIRED")
        ipa = ipas[0]
        with zipfile.ZipFile(ipa) as bundle:
            matches = [name for name in bundle.namelist() if re.fullmatch(r"Payload/[^/]+\.app/Info.plist", name)]
            require(len(matches) == 1, "EXPORTED_APP_REQUIRED")
            info = plistlib.loads(bundle.read(matches[0]))
            require(info.get("CFBundleIdentifier") == BUNDLE and info.get("CFBundleShortVersionString") == self.args.version
                    and info.get("CFBundleVersion") == self.args.build, "IPA_IDENTITY_MISMATCH")
        self.receipt["ipaSha256"] = hashlib.sha256(ipa.read_bytes()).hexdigest()
        self.receipt["ipaBytes"] = ipa.stat().st_size
        upload_env = {**os.environ, "API_PRIVATE_KEYS_DIR": str(self.api_key.parent)}
        for action in (("validate", "upload") if self.args.mode == "upload" else ("validate",)):
            self.stage = f"ASC_{action.upper()}"
            command = altool_command(action, ipa, self.key_id, self.issuer,
                                     self.api_key if self.explicit_p8 else None)
            self.run(command, env=upload_env, altool_result=True)
            self.receipt[f"apple{action.title()}Passed"] = True
        if self.args.mode != "upload":
            return
        self.receipt["uploadAccepted"] = True
        self.receipt["appleProcessing"] = "WAITING"
        self.save()
        self.observe_processing()

    def observe_processing(self):
        self.stage = "APPLE_PROCESSING"
        deadline = time.monotonic() + 1500
        while time.monotonic() < deadline:
            result = self.api("builds?" + urllib.parse.urlencode({"filter[app]": self.app_id,
                              "filter[version]": self.args.build, "include": "preReleaseVersion", "limit": "100"}))
            versions = {item["id"]: item["attributes"]["version"] for item in result.get("included", []) if item["type"] == "preReleaseVersions"}
            builds = [item for item in result["data"] if versions.get(item["relationships"]["preReleaseVersion"]["data"]["id"]) == self.args.version]
            require(len(builds) <= 1, "ASC_BUILD_AMBIGUOUS")
            if builds:
                build = builds[0]
                state = build["attributes"]["processingState"]
                self.receipt.update({"appleProcessing": state, "appleBuildId": build["id"]})
                self.save()
                if state in ("FAILED", "INVALID"):
                    raise Failure("APPLE_PROCESSING_REJECTED")
                if state == "VALID":
                    self.attach_internal_group(build["id"])
                    return
            time.sleep(30)
        raise Failure("APPLE_PROCESSING_PENDING_RESUME_OBSERVATION")

    def attach_internal_group(self, build_id):
        group_id = os.environ.get("AERIFT_INTERNAL_GROUP_ID", "")
        if not group_id:
            self.receipt["internalTesting"] = "OWNER_SELECT_INTERNAL_GROUP_AND_TESTER"
            return
        self.stage = "INTERNAL_GROUP"
        require(re.fullmatch(r"[A-Za-z0-9-]+", group_id), "INTERNAL_GROUP_ID_INVALID")
        group = self.api(f"betaGroups/{group_id}?include=app")["data"]
        require(group["attributes"]["isInternalGroup"] is True and
                group["relationships"]["app"]["data"]["id"] == self.app_id, "INTERNAL_GROUP_APP_MISMATCH")
        route = f"betaGroups/{group_id}/relationships/builds"
        existing = self.api(route)["data"]
        if not any(item["id"] == build_id for item in existing):
            self.api(route, {"data": [{"type": "builds", "id": build_id}]})
        self.receipt["internalTesting"] = "BUILD_ATTACHED_TO_EXISTING_INTERNAL_GROUP"
        self.receipt["internalGroupId"] = group_id

    def save(self):
        (self.public / "receipt.json").write_text(json.dumps(self.receipt, indent=2) + "\n", encoding="utf-8")

    def cleanup(self):
        errors = []
        for profile in self.installed_profiles:
            try:
                profile.unlink(missing_ok=True)
            except OSError:
                errors.append("PROFILE_CLEANUP_FAILED")
        if self.keychain:
            for args in (["security", "list-keychains", "-d", "user", "-s", *self.previous_keychains],
                         ["security", "delete-keychain", str(self.keychain)]):
                if subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
                    errors.append("KEYCHAIN_CLEANUP_FAILED")
        try:
            shutil.rmtree(self.temp)
        except OSError:
            errors.append("TEMP_CLEANUP_FAILED")
        self.receipt["credentialCleanup"] = "PASS" if not errors else "FAIL"
        if errors:
            self.receipt["cleanupErrors"] = errors
        self.save()
        if not errors:
            self.ownership.unlink(missing_ok=True)
        return not errors


def cleanup_owned():
    """Always-step recovery for an interrupted runner, bounded to this job's files."""
    root = Path(os.environ["RUNNER_TEMP"]).resolve()
    record = root / "aerift-testflight-ownership.json"
    if not record.exists():
        print("AERIFT_CREDENTIAL_CLEANUP_ALREADY_COMPLETE")
        return 0
    owner = json.loads(record.read_text(encoding="utf-8"))
    temp = Path(owner["temp"]).resolve()
    require(temp.parent == root and temp.name.startswith("aerift-testflight-"), "CLEANUP_TEMP_SCOPE_INVALID")
    errors = []
    if owner["keychain"]:
        keychain = Path(owner["keychain"]).resolve()
        require(keychain == temp / "signing.keychain-db", "CLEANUP_KEYCHAIN_SCOPE_INVALID")
        for command in (["security", "list-keychains", "-d", "user", "-s", *owner["previousKeychains"]],
                        ["security", "delete-keychain", str(keychain)]):
            result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if result.returncode:
                errors.append("KEYCHAIN")
    allowed = [(Path.home() / relative).resolve() for relative in (
        "Library/Developer/Xcode/UserData/Provisioning Profiles", "Library/MobileDevice/Provisioning Profiles")]
    for value in owner["profiles"]:
        profile = Path(value).resolve()
        require(profile.parent in allowed and re.fullmatch(r"[A-Fa-f0-9-]{36}\.mobileprovision", profile.name), "CLEANUP_PROFILE_SCOPE_INVALID")
        try:
            profile.unlink(missing_ok=True)
        except OSError:
            errors.append("PROFILE")
    try:
        shutil.rmtree(temp)
    except OSError:
        errors.append("TEMP")
    require(not errors, "CREDENTIAL_CLEANUP_FAILED")
    record.unlink()
    print("AERIFT_CREDENTIAL_CLEANUP_PASS")
    return 0


def main():
    if sys.argv[1:] == ["--cleanup-owned"]:
        return cleanup_owned()
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("unsigned", "signed", "upload", "observe"), required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--build", required=True)
    args = parser.parse_args()
    require(re.fullmatch(r"[a-f0-9]{40}", args.candidate), "CANDIDATE_INVALID")
    require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version), "VERSION_INVALID")
    require(re.fullmatch(r"[1-9][0-9]{0,3}(\.[0-9]{1,2}){0,2}", args.build), "BUILD_INVALID")
    runner = Runner(args)
    success = False
    try:
        if args.mode == "observe":
            require(sys.platform == "darwin", "MACOS_REQUIRED")
            require(runner.run(["git", "rev-parse", "HEAD"]).decode().strip() == args.candidate, "CANDIDATE_CHECKOUT_MISMATCH")
            runner.configure_api()
            runner.app_record()
            runner.observe_processing()
        else:
            runner.archive()
            if args.mode in ("signed", "upload"):
                runner.export_upload()
        runner.receipt["result"] = "PASS"
        success = True
    except Exception as error:
        label = str(error) if isinstance(error, Failure) else "UNEXPECTED_RUNNER_FAILURE"
        runner.receipt.update({"result": "FAIL", "failureStage": runner.stage, "error": label})
        print(f"AERIFT_{label}", file=sys.stderr)
    finally:
        success = runner.cleanup() and success
    print(json.dumps(runner.receipt, indent=2))
    return 0 if success else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Failure as error:
        print(f"AERIFT_{error}", file=sys.stderr)
        sys.exit(1)
