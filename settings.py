import os
import json

class SettingsManager:
    def __init__(self, name, settings_directory):
        self.settings_file = os.path.join(settings_directory, f"{name}.json")
        self.settings = {}
        self.read_settings()

    def read_settings(self):
        if os.path.exists(self.settings_file):
            try:
                with open(self.settings_file, "r") as f:
                    self.settings = json.load(f)
            except Exception:
                self.settings = {}

    def getSetting(self, key, default):
        return self.settings.get(key, default)

    def setSetting(self, key, value):
        return self.setSettings({key: value})

    def setSettings(self, values):
        previous = dict(self.settings)
        self.settings.update(values)
        if self.save_settings():
            return True
        self.settings = previous
        return False

    def unsetSettings(self, keys):
        previous = dict(self.settings)
        changed = False
        for key in keys:
            if key in self.settings:
                del self.settings[key]
                changed = True
        if not changed:
            return True
        if self.save_settings():
            return True
        self.settings = previous
        return False

    def save_settings(self):
        temp_file = f"{self.settings_file}.tmp"
        try:
            os.makedirs(os.path.dirname(self.settings_file), exist_ok=True)
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(self.settings, f, indent=4)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp_file, self.settings_file)
            return True
        except Exception:
            try:
                if os.path.exists(temp_file):
                    os.remove(temp_file)
            except OSError:
                pass
            return False
