import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace as NS
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'defaults'))
from dbus_next.constants import NameFlag, RequestNameReply

from manual_watch_utils import update_decky_music_detection_state

ROOT = Path(__file__).resolve().parents[1]
SERVICE = 'org.mpris.MediaPlayer2.decky_music.test'


def load_mpris_logic():
    tree = ast.parse((ROOT / 'main.py').read_text(encoding='utf-8'))
    names = {'refresh_decky_music_mpris_state', '_refresh_decky_music_mpris_state', 'handle_decky_music_mpris_message'}
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    namespace = {
        'asyncio': asyncio, 'Message': lambda **kwargs: NS(**kwargs),
        'MessageType': NS(ERROR='error', SIGNAL='signal'),
        'DECKY_MUSIC_MPRIS_PREFIX': 'org.mpris.MediaPlayer2.decky_music.',
        'decky_music_mpris_owners': {}, 'decky_music_mpris_states': {},
        'decky_music_mpris_revisions': {}, 'decky_music_mpris_refresh_generation': 0,
        'decky_music_mpris_change_callback': None,
        'MPRIS_REFRESH_TIMEOUT': 0.025,
        'decky': NS(logger=NS(debug=lambda *args: None)),
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'main-mpris', 'exec'), namespace)
    return namespace


def playback(namespace, value, sender=':1.200'):
    namespace['handle_decky_music_mpris_message'](NS(
        message_type='signal', interface='org.freedesktop.DBus.Properties',
        member='PropertiesChanged', path='/org/mpris/MediaPlayer2', sender=sender,
        body=['org.mpris.MediaPlayer2.Player', {'PlaybackStatus': NS(value=value)}, []]))


class MprisRefreshTests(unittest.IsolatedAsyncioTestCase):
    async def test_partial_refresh_publishes_valid_reply_before_another_player_times_out(self):
        namespace = load_mpris_logic()
        changes = []
        namespace['decky_music_mpris_change_callback'] = lambda: changes.append(dict(namespace['decky_music_mpris_states']))
        class Bus:
            async def call(self, message):
                if message.member == 'ListNames':
                    return NS(message_type='reply', body=[[SERVICE, SERVICE + '.hung']])
                if message.member == 'GetNameOwner':
                    return NS(message_type='reply', body=[':1.200' if message.body[0] == SERVICE else ':1.201'])
                if message.destination == SERVICE:
                    return NS(message_type='reply', body=[NS(value='Playing')])
                await asyncio.Event().wait()
        namespace['bus'] = Bus()
        await namespace['refresh_decky_music_mpris_state']()
        self.assertEqual(changes, [{SERVICE: True}])

    async def test_refresh_after_timeout_keeps_new_playing_signal_over_old_paused_reply(self):
        namespace = load_mpris_logic()
        class Bus:
            status_reads = 0
            async def call(self, message):
                if message.member == 'ListNames':
                    return NS(message_type='reply', body=[[SERVICE]])
                if message.member == 'GetNameOwner':
                    return NS(message_type='reply', body=[':1.200'])
                self.status_reads += 1
                if self.status_reads == 1:
                    await asyncio.Event().wait()
                playback(namespace, 'Playing')
                return NS(message_type='reply', body=[NS(value='Paused')])
        namespace['bus'] = Bus()
        await namespace['refresh_decky_music_mpris_state']()
        await namespace['refresh_decky_music_mpris_state']()
        self.assertTrue(namespace['decky_music_mpris_states'][SERVICE])

    async def test_initial_discovery_of_unresponsive_player_has_total_deadline(self):
        namespace = load_mpris_logic()
        class Bus:
            async def call(self, message):
                if message.member == 'ListNames':
                    return NS(message_type='reply', body=[[SERVICE]])
                if message.member == 'GetNameOwner':
                    return NS(message_type='reply', body=[':1.200'])
                await asyncio.Event().wait()
        namespace['bus'] = Bus()
        await asyncio.wait_for(namespace['refresh_decky_music_mpris_state'](), 0.15)
        self.assertEqual(namespace['decky_music_mpris_states'], {})

    async def test_unresponsive_discovery_is_optional_to_backend_startup(self):
        namespace = load_mpris_logic()
        tree = ast.parse((ROOT / 'main.py').read_text(encoding='utf-8'))
        start = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == 'start_dbus')
        bus_instance = None
        class Bus:
            async def connect(self): return self
            def disconnect(self): pass
            def add_message_handler(self, _handler): pass
            def export(self, *_args): pass
            async def request_name(self, _name, _flags): return RequestNameReply.PRIMARY_OWNER
            async def call(self, message):
                if message.member == 'ListNames': return NS(message_type='reply', body=[[SERVICE]])
                if message.member == 'GetNameOwner': return NS(message_type='reply', body=[':1.200'])
                if message.member == 'Get': await asyncio.Event().wait()
                return NS(message_type='reply', body=[])
        bus_instance = Bus()
        async def stop_dbus(): namespace['bus'] = None
        namespace.update(bus=None, MessageBus=lambda: bus_instance, stop_dbus=stop_dbus,
                         NameFlag=NameFlag, RequestNameReply=RequestNameReply,
                         clear_dbus_requests=lambda: None,
                         InhibitInterface=lambda: None, PMInhibitInterface=lambda: None, GnomeInterface=lambda: None)
        exec(compile(ast.Module(body=[start], type_ignores=[]), 'actual-dbus-startup', 'exec'), namespace)
        self.assertTrue(await asyncio.wait_for(namespace['start_dbus'](), 0.15))
        self.assertIs(namespace['bus'], bus_instance)

    async def test_bootstrap_playing_signal_wins_over_old_paused_query(self):
        namespace = load_mpris_logic()
        class Bus:
            async def call(self, message):
                if message.member == 'ListNames':
                    return NS(message_type='reply', body=[[SERVICE]])
                if message.member == 'GetNameOwner':
                    return NS(message_type='reply', body=[':1.200'])
                playback(namespace, 'Playing')
                return NS(message_type='reply', body=[NS(value='Paused')])
        namespace['bus'] = Bus()
        await namespace['refresh_decky_music_mpris_state']()
        self.assertTrue(namespace['decky_music_mpris_states'][SERVICE])

    async def test_live_paused_signal_wins_over_old_playing_query(self):
        namespace = load_mpris_logic()
        namespace['decky_music_mpris_owners'] = {':1.200': SERVICE}
        namespace['decky_music_mpris_states'] = {SERVICE: True}
        class Bus:
            async def call(self, message):
                if message.member == 'ListNames':
                    return NS(message_type='reply', body=[[SERVICE]])
                if message.member == 'GetNameOwner':
                    return NS(message_type='reply', body=[':1.200'])
                playback(namespace, 'Paused')
                return NS(message_type='reply', body=[NS(value='Playing')])
        namespace['bus'] = Bus()
        await namespace['refresh_decky_music_mpris_state']()
        self.assertFalse(namespace['decky_music_mpris_states'][SERVICE])

    async def test_older_refresh_cannot_overwrite_newer_refresh(self):
        namespace = load_mpris_logic()
        first_waiting, release = asyncio.Event(), asyncio.Event()
        class Bus:
            reads = 0
            async def call(self, message):
                if message.member == 'ListNames':
                    return NS(message_type='reply', body=[[SERVICE]])
                if message.member == 'GetNameOwner':
                    return NS(message_type='reply', body=[':1.200'])
                self.reads += 1
                if self.reads == 1:
                    first_waiting.set()
                    await release.wait()
                    return NS(message_type='reply', body=[NS(value='Playing')])
                return NS(message_type='reply', body=[NS(value='Paused')])
        namespace['bus'] = Bus()
        first = asyncio.create_task(namespace['refresh_decky_music_mpris_state']())
        await first_waiting.wait()
        await namespace['refresh_decky_music_mpris_state']()
        release.set()
        await first
        self.assertFalse(namespace['decky_music_mpris_states'][SERVICE])

    async def test_disconnected_bus_does_not_publish_pending_reply(self):
        namespace = load_mpris_logic()
        class Bus:
            async def call(self, message):
                if message.member == 'ListNames':
                    return NS(message_type='reply', body=[[SERVICE]])
                if message.member == 'GetNameOwner':
                    return NS(message_type='reply', body=[':1.200'])
                namespace['bus'] = None
                namespace['decky_music_mpris_owners'] = {}
                namespace['decky_music_mpris_states'] = {}
                return NS(message_type='reply', body=[NS(value='Playing')])
        namespace['bus'] = Bus()
        await namespace['refresh_decky_music_mpris_state']()
        self.assertEqual(namespace['decky_music_mpris_states'], {})

    async def test_owner_disappearance_invalidates_pending_playing_reply(self):
        namespace = load_mpris_logic()
        started, release = asyncio.Event(), asyncio.Event()
        class Bus:
            present = True
            async def call(self, message):
                if message.member == 'ListNames':
                    return NS(message_type='reply', body=[[SERVICE] if self.present else []])
                if message.member == 'GetNameOwner':
                    return NS(message_type='reply', body=[':1.200'])
                started.set()
                await release.wait()
                return NS(message_type='reply', body=[NS(value='Playing')])
        namespace['bus'] = Bus()
        pending = asyncio.create_task(namespace['refresh_decky_music_mpris_state']())
        await started.wait()
        namespace['bus'].present = False
        namespace['handle_decky_music_mpris_message'](NS(
            message_type='signal', interface='org.freedesktop.DBus',
            member='NameOwnerChanged', body=[SERVICE, ':1.200', '']))
        release.set()
        await pending
        await asyncio.sleep(0)
        self.assertEqual(namespace['decky_music_mpris_states'], {})
        self.assertEqual(namespace['decky_music_mpris_owners'], {})

    async def test_mpris_pause_releases_the_actual_watcher_on_first_reconcile(self):
        tree = ast.parse((ROOT / 'main.py').read_text(encoding='utf-8'))
        watcher = next(node for node in ast.walk(tree)
                       if isinstance(node, ast.AsyncFunctionDef) and node.name == '_manual_watch_loop')
        state = NS(manual_watch_wakeup=asyncio.Event(), manual_running_app='DeckyMusic',
                   decky_music_detection_error_logged=False, decky_music_missing_checks=0,
                   last_manual_process_scan_monotonic=None)
        observed = []
        async def paused():
            return False
        async def finish_after_reconcile(awaitable, timeout):
            awaitable.close()
            raise asyncio.CancelledError()
        namespace = {
            'asyncio': NS(CancelledError=asyncio.CancelledError, TimeoutError=asyncio.TimeoutError,
                          wait_for=finish_after_reconcile),
            'decky': NS(logger=NS(info=lambda *args: None, error=lambda *args: None)),
            'settings': NS(getSetting=lambda *args: ['DeckyMusic']),
            'get_decky_music_rule_source': lambda app: 'mpris',
            'is_decky_music_name': lambda app: app == 'DeckyMusic',
            'is_decky_music_playing_mpris': paused,
            'update_decky_music_detection_state': update_decky_music_detection_state,
            'should_scan_manual_processes': lambda *args: False,
            'record_diagnostic_event': lambda *args: None,
            'time': NS(monotonic=lambda: 0),
            'Plugin': NS(_set_manual_active=lambda instance, app: observed.append(app)),
        }
        exec(compile(ast.Module(body=[watcher], type_ignores=[]), 'main-watcher', 'exec'), namespace)
        with self.assertRaises(asyncio.CancelledError):
            await namespace['_manual_watch_loop'](state)
        self.assertEqual(observed, [None])

    def test_authoritative_pause_releases_without_waiting_for_second_poll(self):
        self.assertEqual(update_decky_music_detection_state(True, False, 0, confirm_missing=False), (0, False))
        self.assertEqual(update_decky_music_detection_state(True, False, 0), (1, True))

if __name__ == '__main__':
    unittest.main()
