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
        self.assertIn('"task_lifecycle.py"', build_source)

    def test_manual_app_settings_use_a_noncritical_decky_push_event(self):
        self.assertIn('await decky.emit("settings_changed", "manual_apps")', self.main_source)
        self.assertNotIn('queue_event({"type": "SettingsChanged"', self.main_source)

    def test_critical_events_are_payload_free_state_change_signals(self):
        self.assertIn('await decky.emit("inhibit_state_changed")', self.main_source)
        self.assertNotIn('event = {"type": "Inhibit" if active else "UnInhibit"}', self.main_source)
        self.assertNotIn('queue_event({"type": "UnInhibit", "reason": "monitor_stopped"})', self.main_source)

    def test_manual_application_state_changes_include_action_and_application_details(self):
        self.assertIn('f"manual_app_inhibiting:{running_app}"', self.main_source)
        self.assertIn('f"manual_app_released:{previous_running_app}"', self.main_source)
        self.assertIn('sync_inhibit_state(inhibit_detail)', self.main_source)

    def test_stage_4_4_removes_long_polling_but_keeps_connection_reconciliation(self):
        self.assertNotIn("event_queue", self.main_source)
        self.assertNotIn("event_signal", self.main_source)
        self.assertNotIn("def queue_event", self.main_source)
        self.assertNotIn("async def wait_for_events", self.main_source)
        self.assertIn("async def _dbus_connection_watch_loop", self.main_source)

    def test_diagnostics_include_the_preserved_power_profile_during_an_override(self):
        self.assertIn('"powerOverrideSnapshot": override_state["snapshot"]', self.main_source)

    def test_obsolete_process_and_frontend_decky_music_rpc_are_removed(self):
        self.assertNotIn("async def _is_process_running", self.main_source)
        self.assertNotIn("record_decky_music_playback_state", self.main_source)

    def test_decky_music_background_detection_is_rule_gated_and_prefers_mpris(self):
        self.assertIn('DECKY_CDP_TARGET_TITLE = "SharedJSContext"', self.main_source)
        self.assertIn('async def is_decky_music_playing_mpris():', self.main_source)
        self.assertIn('async def is_decky_music_playing_legacy():', self.main_source)
        self.assertIn('DECKY_MUSIC_MPRIS_PREFIX = "org.mpris.MediaPlayer2.decky_music."', self.main_source)
        self.assertIn('async def _is_decky_music_playing_mpris():', self.main_source)
        self.assertIn('def _is_decky_music_playing_cdp():', self.main_source)
        self.assertIn('"Runtime.queryObjects"', self.main_source)
        self.assertIn('if has_decky_music_rule:', self.main_source)
        self.assertIn('await is_decky_music_playing_mpris()', self.main_source)
        self.assertIn('await is_decky_music_playing_legacy()', self.main_source)
        self.assertIn('fallback_interval = 5 if has_decky_music_rule', self.main_source)

    def test_decky_music_uses_a_persistent_tracker_after_one_bootstrap_heap_scan(self):
        self.assertIn('DECKY_MUSIC_TRACKER_KEY = "__screenSaverEnhancementsDeckyMusicTrackerV1"', self.main_source)
        self.assertIn('def _install_decky_music_tracker(sock):', self.main_source)
        self.assertIn('def _read_decky_music_tracker(sock):', self.main_source)
        self.assertIn('playback_state = _read_decky_music_tracker(sock)', self.main_source)
        self.assertIn(
            'return _install_decky_music_tracker(sock) if playback_state is None else playback_state',
            self.main_source,
        )
        self.assertEqual(self.main_source.count('"Runtime.queryObjects"'), 1)

    def test_decky_music_polling_does_not_force_normal_process_scans(self):
        function_node = next(
            node
            for node in self.main_tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name == "should_scan_manual_processes"
        )
        namespace = {}
        exec(compile(ast.Module(body=[function_node], type_ignores=[]), "main.py", "exec"), namespace)
        should_scan = namespace["should_scan_manual_processes"]

        self.assertFalse(should_scan(True, True, "DeckyMusic", False, 0, 120))
        self.assertFalse(should_scan(True, False, "mpv", False, 100, 104))
        self.assertTrue(should_scan(True, False, "mpv", True, 100, 104))
        self.assertTrue(should_scan(True, False, "mpv", False, 100, 220))
        self.assertTrue(should_scan(True, False, "DeckyMusic", False, 100, 104))
        self.assertFalse(should_scan(False, False, None, True, None, 0))

    def test_decky_music_requires_two_consecutive_missing_audio_checks_before_release(self):
        function_node = next(
            node
            for node in self.main_tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name == "update_decky_music_detection_state"
        )
        namespace = {}
        exec(compile(ast.Module(body=[function_node], type_ignores=[]), "main.py", "exec"), namespace)
        update_state = namespace["update_decky_music_detection_state"]

        self.assertEqual(update_state(True, False, 0), (1, True))
        self.assertEqual(update_state(True, False, 1), (2, False))
        self.assertEqual(update_state(True, True, 1), (0, True))
        self.assertEqual(update_state(False, False, 0), (1, False))

    def test_first_missing_decky_music_audio_check_records_a_diagnostic_event(self):
        self.assertIn('"decky_music_audio_temporarily_missing"', self.main_source)


if __name__ == "__main__":
    unittest.main()
