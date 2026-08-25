import ast
import os
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class NestedMprisTests(unittest.TestCase):
    def setUp(self):
        self.source = (ROOT / "main.py").read_text(
            encoding="utf-8"
        )
        self.tree = ast.parse(self.source)

    def _load_functions(self, *names):
        nodes = [
            node
            for node in self.tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name in names
        ]

        namespace = {
            "os": os,
            "NESTED_DESKTOP_RUNTIME_MARKER": "/nested-desktop.",
            "NESTED_MPRIS_PREFIX": "org.mpris.MediaPlayer2.",
            "NESTED_MPRIS_EXCLUDED_MARKERS": (
                "kdeconnect",
                "playerctld",
            ),
        }

        exec(
            compile(
                ast.Module(
                    body=nodes,
                    type_ignores=[],
                ),
                "main.py",
                "exec",
            ),
            namespace,
        )

        return namespace

    def test_discovers_only_nested_desktop_plasma_bus(self):
        ns = self._load_functions(
            "_read_process_environment",
            "discover_nested_desktop_bus_addresses",
        )

        with tempfile.TemporaryDirectory() as proc_root:
            nested = Path(proc_root) / "100"
            nested.mkdir()
            (nested / "comm").write_text(
                "plasmashell\n",
                encoding="utf-8",
            )
            (nested / "environ").write_bytes(
                b"XDG_RUNTIME_DIR=/run/user/1000/nested-desktop.TEST\0"
                b"DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-nested\0"
            )

            normal = Path(proc_root) / "200"
            normal.mkdir()
            (normal / "comm").write_text(
                "plasmashell\n",
                encoding="utf-8",
            )
            (normal / "environ").write_bytes(
                b"XDG_RUNTIME_DIR=/run/user/1000\0"
                b"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus\0"
            )

            result = ns[
                "discover_nested_desktop_bus_addresses"
            ](proc_root)

        self.assertEqual(
            result,
            ["unix:path=/tmp/dbus-nested"],
        )

    def test_filters_proxy_mpris_services(self):
        ns = self._load_functions(
            "is_nested_mpris_service"
        )
        check = ns["is_nested_mpris_service"]

        self.assertTrue(
            check(
                "org.mpris.MediaPlayer2.chromium.instance2"
            )
        )
        self.assertFalse(
            check(
                "org.mpris.MediaPlayer2.kdeconnect.phone"
            )
        )
        self.assertFalse(
            check(
                "org.mpris.MediaPlayer2.playerctld"
            )
        )
        self.assertFalse(
            check("org.example.NotMpris")
        )

    def test_nested_media_participates_in_inhibit_state(self):
        self.assertIn(
            "or nested_media_inhibiting",
            self.source,
        )
        self.assertIn(
            "self.nested_media_active",
            self.source,
        )

    def test_legacy_default_migration_preserves_custom_lists(self):
        self.assertIn(
            "normalized_manual_apps == LEGACY_DEFAULT_MANUAL_APPS",
            self.source,
        )
        self.assertNotIn(
            "normalized_manual_apps.issubset(LEGACY_DEFAULT_MANUAL_APPS)",
            self.source,
        )


if __name__ == "__main__":
    unittest.main()
