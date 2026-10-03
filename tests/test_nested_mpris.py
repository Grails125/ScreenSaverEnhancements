import asyncio
import types
import ast
from unittest.mock import patch
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

    def test_configured_manual_rules_are_never_automatically_removed(self):
        class Settings:
            settings = {"manual_apps": ["chrome", "mpv", "wiliwili"]}
            def getSetting(self, key, default=None):
                return self.settings.get(key, default)
            def setSetting(self, key, value):
                self.settings[key] = value
            def setSettings(self, values):
                self.settings.update(values)
        settings = Settings()
        nodes = [node for node in self.tree.body if isinstance(node, ast.If)
                 and "settings.getSetting" in ast.unparse(node)
                 and ("manual_apps" in ast.unparse(node) or "NESTED_MPRIS_MIGRATION_KEY" in ast.unparse(node))]
        ns = dict(settings=settings, DEFAULT_MANUAL_APPS=("mpv", "wiliwili"),
                  LEGACY_DEFAULT_MANUAL_APPS=frozenset({"chrome", "mpv", "wiliwili"}),
                  NESTED_MPRIS_MIGRATION_KEY="nested_mpris_auto_v1_migrated")
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "main.py", "exec"), ns)
        self.assertEqual(settings.settings["manual_apps"], ["chrome", "mpv", "wiliwili"])


class NestedQueryTests(unittest.IsolatedAsyncioTestCase):
    def load(self):
        tree = ast.parse((ROOT / "main.py").read_text(encoding="utf8"))
        nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and (n.name.startswith("_nested_") or n.name in ("is_nested_mpris_service", "_dbus_get_property", "query_nested_mpris_sources"))]
        ns = dict(asyncio=asyncio, time=__import__("time"), Message=lambda **kw: types.SimpleNamespace(**kw), MessageType=types.SimpleNamespace(ERROR="error"), NESTED_MPRIS_PREFIX="org.mpris.MediaPlayer2.", NESTED_MPRIS_EXCLUDED_MARKERS=("playerctld", "kdeconnect"), NESTED_MPRIS_REQUEST_TIMEOUT=.02, decky=types.SimpleNamespace(logger=types.SimpleNamespace(debug=lambda *a: None)))
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "main.py", "exec"), ns)
        return ns

    async def query(self, statuses, identities=None):
        ns = self.load()
        class Bus:
            disconnected = False
            def __init__(self, **kw): pass
            async def connect(self): return self
            def disconnect(self): self.disconnected = True
            async def call(self, msg):
                if msg.member == "ListNames": return types.SimpleNamespace(message_type="return", body=[list(statuses)])
                value = statuses[msg.destination] if msg.body[1] == "PlaybackStatus" else (identities or {}).get(msg.destination, "Chrome")
                if value == "hang": await asyncio.Event().wait()
                if isinstance(value, Exception): raise value
                return types.SimpleNamespace(message_type="return", body=[types.SimpleNamespace(value=value)])
        async def async_noop(): pass
        instance = Bus()
        instance.wait_for_disconnect = async_noop
        instance._stream = types.SimpleNamespace(close=lambda: None)
        instance._sock = types.SimpleNamespace(close=lambda: None)
        instance._finalize = lambda err: None
        ns["_nested_bus"] = lambda address: instance
        result = await asyncio.wait_for(ns["query_nested_mpris_sources"]("unix:path=/tmp/test"), .2)
        self.assertTrue(instance.disconnected)
        return result

    async def test_hung_second_player_does_not_discard_playing_first(self):
        first = "org.mpris.MediaPlayer2.chrome"
        second = "org.mpris.MediaPlayer2.hung"
        result = await self.query({first: "Playing", second: "hang"})
        self.assertEqual([s["service"] for s in result["sources"]], [first])
        self.assertEqual(result["unknown"], {second})

    async def test_identity_timeout_keeps_confirmed_playing(self):
        service = "org.mpris.MediaPlayer2.chrome"
        result = await self.query({service: "Playing"}, {service: "hang"})
        self.assertEqual(result["sources"][0]["application"], "chrome")

    async def test_paused_is_explicitly_stopped_and_error_is_unknown(self):
        paused = "org.mpris.MediaPlayer2.paused"
        broken = "org.mpris.MediaPlayer2.broken"
        result = await self.query({paused: "Paused", broken: RuntimeError("unavailable")})
        self.assertEqual(result["sources"], [])
        self.assertEqual(result["unknown"], {broken})
        self.assertEqual(result["services"], {paused, broken})

    async def test_identity_error_keeps_confirmed_playing(self):
        service = "org.mpris.MediaPlayer2.chrome"
        result = await self.query({service: "Playing"}, {service: RuntimeError("metadata unavailable")})
        self.assertEqual(result["sources"][0]["service"], service)

    async def test_cancel_during_authentication_closes_socket_and_disconnect_future(self):
        ns = self.load()
        ready = asyncio.Event()
        disconnected = asyncio.Event()
        closed = []
        async def connect():
            ready.set()
            await asyncio.Event().wait()
        async def wait_for_disconnect():
            await disconnected.wait()
        bus = types.SimpleNamespace(
            connect=connect, disconnect=lambda: None,
            wait_for_disconnect=wait_for_disconnect,
            _finalize=lambda error: disconnected.set(),
            _stream=types.SimpleNamespace(close=lambda: closed.append("stream")),
            _sock=types.SimpleNamespace(close=lambda: closed.append("socket")),
        )
        ns["_nested_bus"] = lambda address: bus
        task = asyncio.create_task(ns["query_nested_mpris_sources"]("unix:path=/tmp/test"))
        await ready.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)
        self.assertTrue(disconnected.is_set())
        self.assertEqual(closed, ["stream", "socket"])

    async def test_local_bus_constructor_never_performs_synchronous_connect(self):
        import sys
        sys.path.insert(0, str(ROOT / "defaults"))
        try:
            from dbus_next.aio import MessageBus
        finally:
            sys.path.pop(0)
        ns = self.load()
        ns["MessageBus"] = MessageBus
        with patch("socket.AF_UNIX", 1, create=True), patch("socket.socket") as socket_factory:
            sock = socket_factory.return_value
            sock.fileno.return_value = 123
            bus = ns["_nested_bus"]("unix:path=/tmp/nested-test")
            sock.connect.assert_not_called()
            sock.setblocking.assert_called_once_with(False)
            bus._disconnect_future.cancel()
            bus._stream.close()
            bus._sock.close()
            with self.assertRaises(ValueError):
                ns["_nested_bus"]("tcp:host=127.0.0.1,port=5555")


class NestedGraceTests(unittest.TestCase):
    def setUp(self):
        tree = ast.parse((ROOT / "main.py").read_text(encoding="utf8"))
        plugin = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Plugin")
        method = next(n for n in plugin.body if getattr(n, "name", "") == "_merge_nested_media_results")
        ns = {"NESTED_MPRIS_UNKNOWN_GRACE_SECONDS": 10.0}
        exec(compile(ast.Module(body=[method], type_ignores=[]), "main.py", "exec"), ns)
        self.merge = ns["_merge_nested_media_results"]
        self.runtime = types.SimpleNamespace()
        self.source = {"service": "org.mpris.MediaPlayer2.chrome", "application": "Chrome", "reason": "MPRIS"}
        self.playing = {"sources": [self.source], "unknown": set(), "services": {self.source["service"]}}
        self.merge(self.runtime, ["bus"], [self.playing], 100.0)

    def test_repeated_unknown_does_not_extend_grace(self):
        unknown = {"sources": [], "unknown": {self.source["service"]}, "services": {self.source["service"]}}
        self.assertEqual(self.merge(self.runtime, ["bus"], [unknown], 109.0), [self.source])
        self.assertEqual(self.merge(self.runtime, ["bus"], [unknown], 110.0), [])

    def test_bus_error_retains_playback_only_for_bounded_grace(self):
        self.assertEqual(self.merge(self.runtime, ["bus"], [ConnectionError()], 109), [self.source])
        self.assertEqual(self.merge(self.runtime, ["bus"], [TimeoutError()], 110), [])

    def test_confirmed_stop_or_service_disappearance_releases_immediately(self):
        self.assertEqual(self.merge(self.runtime, ["bus"], [{"sources": [], "unknown": set(), "services": set()}], 101), [])

    def test_proc_confirmed_bus_disappearance_releases_immediately(self):
        self.assertEqual(self.merge(self.runtime, [], [], 101), [])

    def test_buses_with_same_service_do_not_share_ownership(self):
        other = dict(self.source, application="Other browser")
        playing = dict(self.playing, sources=[other])
        self.merge(self.runtime, ["bus", "other"], [self.playing, playing], 101)
        stopped = {"sources": [], "unknown": set(), "services": set()}
        self.assertEqual(self.merge(self.runtime, ["bus", "other"], [stopped, TimeoutError()], 102), [other])

    def test_fresh_playing_renews_grace(self):
        self.merge(self.runtime, ["bus"], [self.playing], 109)
        self.assertEqual(self.merge(self.runtime, ["bus"], [TimeoutError()], 115), [self.source])


if __name__ == "__main__":
    unittest.main()
