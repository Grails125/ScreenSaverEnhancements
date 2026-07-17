import json
import os
import re
import shutil
import subprocess
import zipfile


REQUIRED_PACKAGE_ENTRIES = (
    "main.py",
    "plugin.json",
    "package.json",
    "dist/index.js",
    "dbus_next/__init__.py",
    "lib/x/__init__.py",
)
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")

def ignore_build_artifacts(_dir, names):
    ignored = []
    for name in names:
        if name == "__pycache__" or name.endswith((".pyc", ".pyo")):
            ignored.append(name)
    return ignored


def verify_package(archive_path, plugin_name):
    package_prefix = f"{plugin_name}/"
    with zipfile.ZipFile(archive_path) as archive:
        entries = set(archive.namelist())

    missing = [
        entry for entry in REQUIRED_PACKAGE_ENTRIES
        if f"{package_prefix}{entry}" not in entries
    ]
    if missing:
        raise ValueError(f"package is missing required entries: {', '.join(missing)}")

    cache_entries = [
        entry for entry in entries
        if "__pycache__/" in entry or entry.endswith((".pyc", ".pyo"))
    ]
    if cache_entries:
        raise ValueError("package contains Python cache files")

    with zipfile.ZipFile(archive_path) as archive:
        try:
            plugin_metadata = json.loads(
                archive.read(f"{package_prefix}plugin.json").decode("utf-8")
            )
            package_metadata = json.loads(
                archive.read(f"{package_prefix}package.json").decode("utf-8")
            )
        except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("package contains invalid JSON metadata") from error

    if not isinstance(plugin_metadata, dict) or plugin_metadata.get("api_version") != 1:
        raise ValueError("package has an invalid Decky API version")
    version = package_metadata.get("version") if isinstance(package_metadata, dict) else None
    if not isinstance(version, str) or VERSION_PATTERN.fullmatch(version) is None:
        raise ValueError("package has an invalid semantic version")

def build():
    plugin_name = "ScreenSaverEnhancements"
    build_dir = "build"
    out_dir = os.path.join(build_dir, plugin_name)
    
    print(f"Starting build for {plugin_name}...")
    
    # 1. Clean up
    if os.path.exists(build_dir):
        shutil.rmtree(build_dir)
    if os.path.exists("dist"):
        shutil.rmtree("dist")
        
    # 2. Build frontend
    print("Building frontend...")
    if os.name == "nt":
        subprocess.run(["cmd.exe", "/c", "npm.cmd", "run", "build"], check=True)
    else:
        subprocess.run(["npm", "run", "build"], check=True)
    
    # 3. Create output directory
    os.makedirs(os.path.join(out_dir, "dist"), exist_ok=True)
    
    # 4. Copy files
    files_to_copy = [
        "main.py",
        "plugin.json",
        "package.json",
        "README_ZH.md",
        "README.md",
        "LICENSE",
        "settings.py",
        "plugin_contract.py",
        "process_events.py",
        "task_lifecycle.py",
        "update_checker.py",
    ]
    
    for f in files_to_copy:
        if os.path.exists(f):
            shutil.copy(f, out_dir)
            
    # 5. Bundle the Python dependencies required by Decky's restricted runtime.
    bundled_directories = (
        (
            os.path.join("defaults", "dbus_next"),
            os.path.join(out_dir, "dbus_next"),
        ),
        (
            os.path.join("defaults", "lib", "x"),
            os.path.join(out_dir, "lib", "x"),
        ),
    )
    for source, destination in bundled_directories:
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        shutil.copytree(source, destination, ignore=ignore_build_artifacts)

    # 6. Copy only the production frontend entry point.
    shutil.copy(os.path.join("dist", "index.js"), os.path.join(out_dir, "dist"))

    # 7. Zip the result
    print(f"Creating zip...")
    # Ensure the first-level folder in zip is ScreenSaverEnhancements
    archive_path = shutil.make_archive(
        os.path.join(build_dir, plugin_name),
        'zip',
        root_dir=build_dir,
        base_dir=plugin_name,
    )
    verify_package(archive_path, plugin_name)
    
    print(f"Build complete! Output in {out_dir}")
    print(f"Zip created and verified at {archive_path}")

if __name__ == "__main__":
    build()
