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
        self.settings[key] = value
        self.save_settings()
        return True

    def save_settings(self):
        try:
            with open(self.settings_file, "w") as f:
                json.dump(self.settings, f, indent=4)
        except Exception:
            pass
