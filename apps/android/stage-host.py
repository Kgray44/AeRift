"""Stage reviewed AeRift Android sources into the disposable Tauri Gradle host."""
import shutil
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

ANDROID = "http://schemas.android.com/apk/res/android"
TOOLS = "http://schemas.android.com/tools"
ET.register_namespace("android", ANDROID)
ET.register_namespace("tools", TOOLS)
NAME = f"{{{ANDROID}}}name"


def merge_manifest(destination, source):
    result = ET.parse(destination)
    patch = ET.parse(source).getroot()
    base = result.getroot()
    if patch.tag != "manifest" or patch.attrib or base.tag != "manifest":
        raise ValueError("Expected a manifest patch without root attributes")

    def reconcile(parent, child):
        if child.tag not in {"uses-permission", "uses-feature", "provider", "meta-data", "queries", "intent", "action"}:
            raise ValueError(f"Unsupported Android overlay element: {child.tag}")
        if child.tag == "queries":
            existing = parent.find("queries")
            if existing is None:
                parent.append(child)
            else:
                for item in child:
                    reconcile(existing, item)
        elif child.tag == "intent":
            # Queries intents are selected by their full filter, not by an
            # absent name. Structural equality makes re-staging idempotent.
            candidate = ET.tostring(child)
            if not any(ET.tostring(node) == candidate for node in parent.findall("intent")):
                parent.append(child)
        else:
            name = child.get(NAME)
            if not name:
                raise ValueError(f"Missing android:name for {child.tag}")
            existing = next((item for item in parent.findall(child.tag) if item.get(NAME) == name), None)
            if existing is not None:
                parent.remove(existing)
            parent.append(child)

    for child in patch:
        if child.tag == "application":
            app = base.find("application")
            if app is None:
                raise ValueError("Tauri generated manifest lacks an application")
            app.attrib.update(child.attrib)
            for item in child:
                reconcile(app, item)
        else:
            reconcile(base, child)
    ET.indent(result, space="    ")
    result.write(destination, encoding="utf-8", xml_declaration=True)


def stage(project, overlay):
    main = project / "app/src/main"
    patch = overlay / "AndroidManifest.xml"
    if patch.is_file():
        merge_manifest(main / "AndroidManifest.xml", patch)
    for name in ("java", "kotlin", "res"):
        source = overlay / name
        if source.is_dir():
            for file in sorted(source.rglob("*")):
                if file.is_symlink():
                    raise ValueError(f"Android source overlay cannot contain symlinks: {file}")
                if file.is_file():
                    relative = file.relative_to(source)
                    target = main / name / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(file, target)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: stage-host.py GENERATED_GRADLE_ROOT OVERLAY_DIR")
    stage(Path(sys.argv[1]), Path(sys.argv[2]))
