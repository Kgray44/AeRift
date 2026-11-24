#!/usr/bin/env bash
set -euo pipefail
bundle="${1:?Usage: verify-bundle.sh AAB EXPECTED_VERSION_CODE}"
version="${2:?Expected version code required}"
: "${AERIFT_BUNDLETOOL_JAR:?Path to pinned Google bundletool-all-1.18.3.jar required}"
digest='a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29'
[[ "$(sha256sum "$AERIFT_BUNDLETOOL_JAR" | cut -d' ' -f1)" == "$digest" ]] || {
  echo 'Unexpected bundletool SHA-256.' >&2; exit 1;
}
java -jar "$AERIFT_BUNDLETOOL_JAR" validate --bundle="$bundle"
java -jar "$AERIFT_BUNDLETOOL_JAR" dump manifest --bundle="$bundle" |
  python3 -c '
import sys
from xml.etree import ElementTree as ET
root = ET.parse(sys.stdin).getroot()
ns = "{http://schemas.android.com/apk/res/android}"
sdk = root.find("uses-sdk")
if root.get("package") != "com.kgamazing44.aerift" or root.get(ns + "versionCode") != sys.argv[1]:
    raise SystemExit("Bundle package or version code does not match")
if sdk is None or sdk.get(ns + "targetSdkVersion") != "36":
    raise SystemExit("Bundle must target Android API 36")
' "$version"
config="$(java -jar "$AERIFT_BUNDLETOOL_JAR" dump config --bundle="$bundle")"
grep -F 'PAGE_ALIGNMENT_16K' <<<"$config"
