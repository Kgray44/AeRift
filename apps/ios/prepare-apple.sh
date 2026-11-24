#!/usr/bin/env bash
set -euo pipefail

ios_dir="$(cd "$(dirname "$0")" && pwd)"
host_dir="$(cd "${1:-"$ios_dir/../aerift"}" && pwd)"
cd "$host_dir"

project=src-tauri/gen/apple
if [[ ! -f "$project/project.yml" ]]; then
  npm run tauri -- ios init --skip-targets-install
fi

targets=("$project"/*_iOS)
if [[ "${#targets[@]}" != 1 || ! -f "${targets[0]}/Info.plist" ]]; then
  echo 'Expected a single generated AeRift iOS target.' >&2
  exit 1
fi
catalog="$(find "$project" -name build -prune -o -type d -name AppIcon.appiconset -print)"
if [[ -z "$catalog" || "$catalog" == *$'\n'* || ! -d "$catalog" ]]; then
  echo 'Expected one generated iOS AppIcon asset catalog.' >&2
  exit 1
fi
python3 "$ios_dir/../../scripts/branding/app-icons.py" ios "$catalog"

manifest="${targets[0]}/PrivacyInfo.xcprivacy"
if ! cmp -s "$ios_dir/PrivacyInfo.xcprivacy" "$manifest"; then
  cp "$ios_dir/PrivacyInfo.xcprivacy" "$manifest"
  xcodegen generate --spec "$project/project.yml" --project "$project"
fi
