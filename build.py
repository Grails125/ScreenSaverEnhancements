import os
import shutil
import json
import subprocess

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
    subprocess.run(["npm", "run", "build"], shell=True, check=True)
    
    # 3. Create output directory
    os.makedirs(os.path.join(out_dir, "dist"), exist_ok=True)
    
    # 4. Copy files
    files_to_copy = [
        "main.py",
        "plugin.json",
        "decky_plugin.pyi",
        "README_ZH.md",
        "README.md",
        "LICENSE",
        "settings.py"
    ]
    
    for f in files_to_copy:
        if os.path.exists(f):
            shutil.copy(f, out_dir)
            
    # 5. Extract contents from 'defaults' to the root of the output directory
    defaults_dir = "defaults"
    if os.path.exists(defaults_dir):
        print(f"Extracting contents from {defaults_dir} to root...")
        for item in os.listdir(defaults_dir):
            s = os.path.join(defaults_dir, item)
            d = os.path.join(out_dir, item)
            if os.path.isdir(s):
                if os.path.exists(d): shutil.rmtree(d)
                shutil.copytree(s, d)
            else:
                shutil.copy2(s, d)

    # 6. Copy directories
    dirs_to_copy = [
        "py_modules",
        "dist"
    ]
    
    for d in dirs_to_copy:
        if os.path.exists(d) and d != "defaults":
            dest = os.path.join(out_dir, d)
            if d == "dist":
                # Only copy index.js
                os.makedirs(dest, exist_ok=True)
                shutil.copy(os.path.join(d, "index.js"), dest)
            else:
                if os.path.exists(dest): shutil.rmtree(dest)
                shutil.copytree(d, dest)

    # 7. Zip the result
    print(f"Creating zip...")
    # Ensure the first-level folder in zip is ScreenSaverEnhancements
    shutil.make_archive(os.path.join(build_dir, plugin_name), 'zip', root_dir=build_dir, base_dir=plugin_name)
    
    print(f"Build complete! Output in {out_dir}")
    print(f"Zip created at {os.path.join(build_dir, plugin_name)}.zip")

if __name__ == "__main__":
    build()
