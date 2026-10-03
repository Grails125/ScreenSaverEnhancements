import ast
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'defaults'))
from dbus_next.constants import RequestNameReply, NameFlag

ROOT = Path(__file__).resolve().parents[1]

class Bus:
    def __init__(self, connected=True, reply=RequestNameReply.PRIMARY_OWNER):
        self.connected = connected
        self.reply = reply
        self.names = []
    async def connect(self): self.connected = True; return self
    def disconnect(self): self.connected = False
    def add_message_handler(self, handler): pass
    def export(self, *args): pass
    async def request_name(self, name, flags=NameFlag.NONE):
        self.names.append((name, flags)); return self.reply
    async def call(self, message): return NS()

async def noop(*args, **kwargs): pass

def load_logic(current_bus=None, next_bus=None):
    source = ast.parse((ROOT/'main.py').read_text(encoding='utf-8'))
    names = {'stop_dbus', 'start_dbus', 'clear_dbus_requests'}
    nodes = [n for n in source.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    plugin = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'Plugin')
    wanted = {'_init_runtime_state', '_backend_operation_lock', '_start_backend_locked', 'start_backend',
              '_dbus_connection_watch_loop', 'is_running'}
    methods = [n for n in plugin.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in wanted]
    cls = ast.ClassDef(name='Plugin', bases=[], keywords=[], decorator_list=[], body=methods)
    ns = {'asyncio': asyncio, 'asynccontextmanager': asynccontextmanager, 'bus': current_bus,
          'unloading': False, 'NameFlag': NameFlag, 'RequestNameReply': RequestNameReply,
          'Message': lambda **kw: NS(**kw), 'MessageBus': lambda: next_bus or Bus(),
          'BaseInterface': NS(request_map={}, cookie=0),
          'decky_music_mpris_owners': {':1.2': 'player'}, 'decky_music_mpris_states': {'player': True},
          'decky_music_mpris_revisions': {'player': 1}, 'decky_music_mpris_refresh_generation': 0,
          'decky_music_mpris_change_callback': Mock(), 'sync_inhibit_state': Mock(),
          'DisplayWakeGuard': lambda: NS(close=noop), 'record_diagnostic_event': Mock(),
          'decky': NS(logger=NS(info=Mock(), error=Mock(), warning=Mock())),
          'handle_decky_music_mpris_message': Mock(), 'InhibitInterface': lambda: None,
          'PMInhibitInterface': lambda: None, 'GnomeInterface': lambda: None,
          'refresh_decky_music_mpris_state': noop, 'is_dbus_request_connected': noop}
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes+[cls], type_ignores=[])), 'main-reconnection', 'exec'), ns)
    ns['Plugin']._start_manual_watch = Mock()
    ns['Plugin']._start_dbus_connection_watch = Mock()
    return ns, ns['Plugin']()

class DbusServiceRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_disconnected_bus_reports_stopped(self):
        _, plugin = load_logic(Bus(connected=False))
        self.assertFalse(await plugin.is_running())

    async def test_explicit_start_replaces_disconnected_bus_and_clears_stale_inhibition(self):
        replacement = Bus()
        ns, plugin = load_logic(Bus(connected=False), replacement)
        ns['BaseInterface'].request_map[1] = object()
        self.assertTrue(await plugin.start_backend())
        self.assertIs(ns['bus'], replacement)
        self.assertEqual(ns['BaseInterface'].request_map, {})
        self.assertEqual(ns['decky_music_mpris_states'], {})
        ns['decky_music_mpris_change_callback'].assert_called()

    async def test_connection_watcher_reconnects_without_duplicate_manual_watch(self):
        ns, plugin = load_logic(Bus(connected=False), Bus())
        ns['BaseInterface'].request_map[1] = object()
        sleeps = 0
        async def one_tick(seconds):
            nonlocal sleeps
            sleeps += 1
            if sleeps > 1: raise asyncio.CancelledError()
        ns['asyncio'] = NS(sleep=one_tick, CancelledError=asyncio.CancelledError,
                           current_task=asyncio.current_task, Lock=asyncio.Lock, Event=asyncio.Event)
        with self.assertRaises(asyncio.CancelledError):
            await plugin._dbus_connection_watch_loop()
        self.assertTrue(ns['bus'].connected)
        self.assertEqual(ns['BaseInterface'].request_map, {})
        self.assertEqual(ns['decky_music_mpris_states'], {})
        self.assertLessEqual(type(plugin)._start_manual_watch.call_count, 1)

    async def test_queued_name_is_rejected_and_bus_cleared(self):
        candidate = Bus(reply=RequestNameReply.IN_QUEUE)
        ns, _ = load_logic(next_bus=candidate)
        self.assertFalse(await ns['start_dbus']())
        self.assertIsNone(ns['bus'])
        self.assertFalse(candidate.connected)
        self.assertEqual(candidate.names[0][1], NameFlag.DO_NOT_QUEUE)

    async def test_existing_name_is_rejected(self):
        ns, _ = load_logic(next_bus=Bus(reply=RequestNameReply.EXISTS))
        self.assertFalse(await ns['start_dbus']())
        self.assertIsNone(ns['bus'])

    async def test_owned_names_are_accepted(self):
        for reply in (RequestNameReply.PRIMARY_OWNER, RequestNameReply.ALREADY_OWNER):
            with self.subTest(reply=reply):
                candidate = Bus(reply=reply)
                ns, _ = load_logic(next_bus=candidate)
                self.assertTrue(await ns['start_dbus']())
                self.assertEqual(len(candidate.names), 4)
                self.assertTrue(all(flags == NameFlag.DO_NOT_QUEUE for _, flags in candidate.names))

    async def test_disconnect_failure_still_clears_cached_state(self):
        broken = Bus()
        broken.disconnect = Mock(side_effect=OSError('closed socket'))
        ns, _ = load_logic(broken)
        await ns['stop_dbus']()
        self.assertIsNone(ns['bus'])
        self.assertEqual(ns['decky_music_mpris_states'], {})
        self.assertEqual(ns['decky_music_mpris_revisions'], {})

    async def test_failed_recovery_clears_old_state_and_retries_on_next_watch_tick(self):
        replacement = Bus()
        ns, plugin = load_logic(Bus(connected=False))
        ns['BaseInterface'].request_map[1] = object()
        attempts = []
        def next_connection():
            candidate = Bus(reply=RequestNameReply.EXISTS) if len(attempts) < 3 else replacement
            attempts.append(candidate)
            return candidate
        ns['MessageBus'] = next_connection
        ticks = 0
        async def next_tick(seconds):
            nonlocal ticks
            if seconds != 25:
                return
            ticks += 1
            if ticks == 2:
                self.assertIsNone(ns['bus'])
                self.assertEqual(ns['BaseInterface'].request_map, {})
                self.assertEqual(ns['decky_music_mpris_states'], {})
                ns['sync_inhibit_state'].assert_called()
            if ticks > 2:
                raise asyncio.CancelledError()
        ns['asyncio'] = NS(sleep=next_tick, CancelledError=asyncio.CancelledError,
                           current_task=asyncio.current_task, Lock=asyncio.Lock, Event=asyncio.Event)
        with self.assertRaises(asyncio.CancelledError):
            await plugin._dbus_connection_watch_loop()
        self.assertIs(ns['bus'], replacement)
        self.assertEqual(len(attempts), 4)
        self.assertTrue(all(not candidate.connected for candidate in attempts[:3]))

    async def test_watcher_does_not_reconnect_after_unloading(self):
        ns, plugin = load_logic(Bus(connected=False))
        ns['unloading'] = True
        ns['asyncio'] = NS(sleep=noop, CancelledError=asyncio.CancelledError,
                           current_task=asyncio.current_task, Lock=asyncio.Lock)
        ns['MessageBus'] = Mock(side_effect=AssertionError('reconnected during unload'))
        await plugin._dbus_connection_watch_loop()
        ns['MessageBus'].assert_not_called()
        self.assertIsNone(plugin.backend_lifecycle_operation)

    async def test_watcher_rechecks_connection_after_waiting_for_lifecycle_lock(self):
        ns, plugin = load_logic(Bus(connected=False))
        plugin.backend_lifecycle_lock = asyncio.Lock()
        await plugin.backend_lifecycle_lock.acquire()
        entered = asyncio.Event()
        ticks = 0
        async def next_tick(seconds):
            nonlocal ticks
            ticks += 1
            if ticks > 1: raise asyncio.CancelledError()
            entered.set()
        ns['asyncio'] = NS(sleep=next_tick, CancelledError=asyncio.CancelledError,
                           current_task=asyncio.current_task, Lock=asyncio.Lock)
        ns['MessageBus'] = Mock(side_effect=AssertionError('duplicate connection'))
        watcher = asyncio.create_task(plugin._dbus_connection_watch_loop())
        await entered.wait()
        replacement = Bus()
        ns['bus'] = replacement
        plugin.backend_lifecycle_lock.release()
        with self.assertRaises(asyncio.CancelledError): await watcher
        ns['MessageBus'].assert_not_called()
        self.assertIs(ns['bus'], replacement)

    async def test_conflict_after_partial_registration_releases_prior_names(self):
        candidate = Bus()
        async def partial_registration(name, flags):
            candidate.names.append((name, flags))
            return RequestNameReply.PRIMARY_OWNER if len(candidate.names) < 3 else RequestNameReply.EXISTS
        candidate.request_name = partial_registration
        ns, _ = load_logic(next_bus=candidate)
        self.assertFalse(await ns['start_dbus']())
        self.assertEqual(len(candidate.names), 3)
        self.assertFalse(candidate.connected)
        self.assertIsNone(ns['bus'])

if __name__ == '__main__': unittest.main()
