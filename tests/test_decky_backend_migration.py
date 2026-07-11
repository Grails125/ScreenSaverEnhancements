import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class DeckyBackendMigrationTests(unittest.TestCase):
    def setUp(self):
        self.main_source = (ROOT / "main.py").read_text(encoding="utf-8")
        self.main_tree = ast.parse(self.main_source)

    def test_backend_uses_the_modern_decky_module_exclusively(self):
        imported_modules = {
            alias.name
            for node in ast.walk(self.main_tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        }

        self.assertIn("decky", imported_modules)
        self.assertNotIn("decky_plugin", imported_modules)
        self.assertNotIn("decky_plugin", self.main_source)

    def test_backend_uses_target_loader_logging_and_settings_contract(self):
        decky_attributes = {
            node.attr
            for node in ast.walk(self.main_tree)
            if isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "decky"
        }

        self.assertIn("logger", decky_attributes)
        self.assertIn("DECKY_PLUGIN_SETTINGS_DIR", decky_attributes)

    def test_type_stub_is_kept_for_development_but_excluded_from_release(self):
        build_source = (ROOT / "build.py").read_text(encoding="utf-8")

        self.assertTrue((ROOT / "decky.pyi").is_file())
        self.assertFalse((ROOT / "decky_plugin.pyi").exists())
        self.assertNotIn('"decky.pyi"', build_source)
        self.assertNotIn("decky_plugin.pyi", build_source)

    def test_build_bundles_the_python_dependencies_required_by_decky_sandbox(self):
        build_source = (ROOT / "build.py").read_text(encoding="utf-8")

        self.assertIn('os.path.join("defaults", "dbus_next")', build_source)
        self.assertIn('os.path.join("defaults", "lib", "x")', build_source)
        self.assertNotIn('"py_modules"', build_source)
        self.assertNotIn('defaults_dir = "defaults"', build_source)

    def test_build_packages_every_local_backend_module(self):
        build_source = (ROOT / "build.py").read_text(encoding="utf-8")

        self.assertIn('"settings.py"', build_source)
        self.assertIn('"plugin_contract.py"', build_source)
        self.assertIn('"process_events.py"', build_source)
        self.assertIn('"update_checker.py"', build_source)

    def test_manual_app_settings_use_a_noncritical_decky_push_event(self):
        self.assertIn('await decky.emit("settings_changed", "manual_apps")', self.main_source)
        self.assertNotIn('queue_event({"type": "SettingsChanged"', self.main_source)

    def test_critical_events_are_payload_free_state_change_signals(self):
        self.assertIn('await decky.emit("inhibit_state_changed")', self.main_source)
        self.assertNotIn('event = {"type": "Inhibit" if active else "UnInhibit"}', self.main_source)
        self.assertNotIn('queue_event({"type": "UnInhibit", "reason": "monitor_stopped"})', self.main_source)

    def test_stage_4_4_removes_long_polling_but_keeps_connection_reconciliation(self):
        self.assertNotIn("event_queue", self.main_source)
        self.assertNotIn("event_signal", self.main_source)
        self.assertNotIn("def queue_event", self.main_source)
        self.assertNotIn("async def wait_for_events", self.main_source)
        self.assertIn("async def _dbus_connection_watch_loop", self.main_source)


if __name__ == "__main__":
    unittest.main()
