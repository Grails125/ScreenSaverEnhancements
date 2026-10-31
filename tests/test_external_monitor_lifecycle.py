import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'defaults'))
sys.path.insert(0, str(ROOT))
from dbus_next import Message, MessageType
from external_inhibit_monitor import ExternalInhibitMonitor


class ExternalMonitorLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_owner_change_during_later_query_cannot_roll_back_earlier_result(self):
        screen, gnome = 'org.freedesktop.ScreenSaver', 'org.gnome.SessionManager'
        control = NS(connected=True, unique_name=':1.50',
                     sse_service_states={screen: {'status': 'external'}, gnome: {'status': 'external'}})
        monitor = ExternalInhibitMonitor(lambda *a, **kw: None, lambda: None)
        monitor.tracker.set_owners({screen: ':1.32', gnome: ':1.33'})
        monitor.connection = NS(connected=True, disconnect=lambda: None)
        async def query(message):
            if message.body[0] == screen:
                return NS(message_type=MessageType.METHOD_RETURN, body=[':1.32'])
            monitor._handle_message(Message(message_type=MessageType.SIGNAL, sender='org.freedesktop.DBus',
                path='/org/freedesktop/DBus', interface='org.freedesktop.DBus', member='NameOwnerChanged',
                signature='sss', body=[screen, ':1.32', ':1.34']), control)
            monitor._handle_message(Message(destination=screen, path='/ScreenSaver', interface=screen,
                member='Inhibit', signature='ss', body=['replacement', 'video'], sender=':1.100', serial=1), control)
            monitor._handle_message(Message(message_type=MessageType.METHOD_RETURN, sender=':1.34',
                destination=':1.100', reply_serial=1, signature='u', body=[7]), control)
            return NS(message_type=MessageType.METHOD_RETURN, body=[':1.33'])
        control.call = query
        snapshots = []
        async def tick(_seconds):
            snapshots.append((dict(monitor.tracker.owners), monitor.tracker.requests()))
            control.connected = False
        with patch('external_inhibit_monitor.asyncio.sleep', tick):
            await monitor._run(control)
        self.assertEqual(snapshots[0][0][screen], ':1.34')
        self.assertEqual(snapshots[0][1][0]['application'], 'replacement')

    def test_owner_change_preserves_other_services_and_immediately_tracks_new_owner(self):
        monitor = ExternalInhibitMonitor(lambda *a, **kw: None, lambda: None)
        screen, gnome = 'org.freedesktop.ScreenSaver', 'org.gnome.SessionManager'
        control = NS(unique_name=':1.50', sse_service_states={screen: {'status': 'external'}, gnome: {'status': 'external'}})
        monitor.tracker.set_owners({screen: ':1.32', gnome: ':1.33'})
        call = Message(destination=gnome, path='/org/gnome/SessionManager', interface=gnome,
                       member='Inhibit', signature='susu', body=['player', 0, 'video', 8], sender=':1.100', serial=1)
        monitor._handle_message(call, control)
        monitor._handle_message(Message(message_type=MessageType.METHOD_RETURN, sender=':1.33',
                                        destination=':1.100', reply_serial=1, signature='u', body=[7]), control)
        monitor._handle_message(Message(message_type=MessageType.SIGNAL, sender='org.freedesktop.DBus',
            path='/org/freedesktop/DBus', interface='org.freedesktop.DBus', member='NameOwnerChanged',
            signature='sss', body=[screen, ':1.32', ':1.34']), control)
        self.assertEqual(len(monitor.tracker.requests()), 1)
        self.assertEqual(monitor.tracker.owners[screen], ':1.34')
        self.assertEqual(monitor.tracker.requests()[0]['service'], gnome)

    async def test_stop_disconnects_a_connection_still_waiting_for_hello(self):
        connecting = asyncio.Event()
        candidate = NS(connected=True)
        async def connect():
            connecting.set()
            await asyncio.Event().wait()
        candidate.connect = connect
        candidate.disconnect = lambda: setattr(candidate, 'connected', False)
        control = NS(connected=True, sse_service_states={'org.freedesktop.ScreenSaver': {'status': 'external'}})
        async def query(message):
            return NS(message_type=MessageType.METHOD_RETURN, body=[':1.32'])
        control.call = query
        monitor = ExternalInhibitMonitor(lambda *a, **kw: None, lambda: None)
        with patch('external_inhibit_monitor.MessageBus', lambda: candidate):
            monitor.start(control)
            await asyncio.wait_for(connecting.wait(), 1)
            await monitor.stop()
        self.assertFalse(candidate.connected)

    async def test_owner_query_racing_with_own_registration_is_not_observed(self):
        ready = asyncio.Event()
        control = NS(connected=True, unique_name=':1.50', sse_service_states={'org.freedesktop.ScreenSaver': {'status': 'external'}})
        async def query(message):
            control.sse_service_states['org.freedesktop.ScreenSaver']['status'] = 'owned'
            return NS(message_type=MessageType.METHOD_RETURN, body=[':1.50'])
        control.call = query
        monitor = ExternalInhibitMonitor(lambda kind, detail: ready.set() if detail == 'not_needed' else None, lambda: None)
        with patch('external_inhibit_monitor.MessageBus') as factory:
            monitor.start(control)
            await asyncio.wait_for(ready.wait(), 1)
            await monitor.stop()
            factory.assert_not_called()

    async def test_independent_monitor_starts_once_and_stop_releases_all_resources(self):
        ready = asyncio.Event()
        connections = []

        class Connection:
            connected = True
            def __init__(self):
                connections.append(self)
                self.messages = []
            async def connect(self):
                return self
            def add_message_handler(self, handler):
                self.handler = handler
            async def call(self, message):
                self.messages.append(message)
                return NS(message_type=MessageType.METHOD_RETURN, body=[])
            def disconnect(self):
                self.connected = False

        class Control:
            connected = True
            sse_service_states = {'org.freedesktop.ScreenSaver': {'status': 'external'}}
            async def call(self, message):
                self.last_member = message.member
                return NS(message_type=MessageType.METHOD_RETURN, body=[':1.32'])

        def event(kind, detail, **fields):
            if detail == 'partial':
                ready.set()

        monitor = ExternalInhibitMonitor(event, lambda: None)
        control = Control()
        with patch('external_inhibit_monitor.MessageBus', Connection):
            monitor.start(control)
            monitor.start(control)
            await asyncio.wait_for(ready.wait(), 1)
            self.assertEqual(len(connections), 1)
            self.assertEqual(connections[0].messages[0].member, 'BecomeMonitor')
            # Successful BecomeMonitor replies must reach dbus_next's call
            # future. Only incoming method calls are consumed by our handler.
            self.assertFalse(connections[0].handler(NS(message_type=MessageType.METHOD_RETURN, body=[], destination=None, reply_serial=99)))
            await monitor.stop()
            self.assertFalse(connections[0].connected)
            self.assertTrue(control.connected)
            self.assertIsNone(monitor.task)
            self.assertEqual(monitor.status, 'stopped')

    async def test_permission_failure_is_degraded_and_never_disconnects_control(self):
        ready = asyncio.Event()
        control = NS(connected=True, sse_service_states={'org.freedesktop.ScreenSaver': {'status': 'external'}})
        async def query(message):
            return NS(message_type=MessageType.METHOD_RETURN, body=[':1.32'])
        control.call = query
        def failed_connection():
            raise PermissionError('monitoring denied')
        monitor = ExternalInhibitMonitor(lambda kind, detail: ready.set() if detail == 'unavailable' else None, lambda: None)
        with patch('external_inhibit_monitor.MessageBus', failed_connection):
            monitor.start(control)
            await asyncio.wait_for(ready.wait(), 1)
            self.assertTrue(control.connected)
            await monitor.stop()


class OwnerQueryRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.screen = 'org.freedesktop.ScreenSaver'
        self.gnome = 'org.gnome.SessionManager'
        self.events, self.changes = [], []
        self.monitor = ExternalInhibitMonitor(
            lambda *args, **fields: self.events.append((args, fields)),
            lambda: self.changes.append(len(self.monitor.tracker.requests())),
        )
        self.control = NS(connected=True, unique_name=':1.50', sse_service_states={
            self.screen: {'status': 'external'}, self.gnome: {'status': 'external'},
        })
        self.connection = NS(connected=True)
        self.connection.disconnect = lambda: setattr(self.connection, 'connected', False)
        self.monitor.connection = self.connection
        self.monitor.tracker.set_owners({self.screen: ':1.32', self.gnome: ':1.33'})
        self.confirm(self.screen, ':1.32', 1)
        self.confirm(self.gnome, ':1.33', 2)
        self.changes.clear()

    def confirm(self, service, owner, serial):
        gnome = service == self.gnome
        self.monitor._handle_message(Message(destination=service,
            path='/org/gnome/SessionManager' if gnome else '/ScreenSaver', interface=service,
            member='Inhibit', signature='susu' if gnome else 'ss',
            body=['player', 0, 'video', 8] if gnome else ['Edge', 'video'],
            sender=':1.100', serial=serial), self.control)
        self.monitor._handle_message(Message(message_type=MessageType.METHOD_RETURN,
            sender=owner, destination=':1.100', reply_serial=serial, signature='u', body=[serial]), self.control)

    async def run_cycles(self, query, cycles=1, after_tick=None):
        self.control.call = query
        snapshots = []
        async def tick(_seconds):
            snapshots.append({
                'requests': self.monitor.tracker.requests(),
                'connected': self.connection.connected,
                'owners': dict(self.monitor.tracker.owners),
                'status': self.monitor.status,
                'changes': list(self.changes),
            })
            if after_tick:
                after_tick(len(snapshots))
            if len(snapshots) >= cycles:
                self.control.connected = False
        with patch('external_inhibit_monitor.asyncio.sleep', tick):
            await self.monitor._run(self.control)
        return snapshots

    async def test_timeout_preserves_live_requests_and_retries_each_service(self):
        queries = []
        async def query(message):
            name = message.body[0]
            queries.append(name)
            if name == self.screen and queries.count(name) == 1:
                raise TimeoutError('temporary metadata failure')
            return NS(message_type=MessageType.METHOD_RETURN,
                      body=[':1.32' if name == self.screen else ':1.33'])
        snapshots = await self.run_cycles(query, cycles=2)
        for snapshot in snapshots:
            self.assertTrue(snapshot['connected'])
            self.assertEqual(len(snapshot['requests']), 2)
            self.assertEqual(snapshot['changes'], [])
            self.assertEqual(snapshot['status'], 'partial')
        self.assertEqual(queries.count(self.screen), 2)
        self.assertEqual(queries.count(self.gnome), 2)

    async def test_unknown_dbus_error_does_not_mean_owner_disappeared(self):
        async def query(message):
            return NS(message_type=MessageType.ERROR, body=[],
                      error_name='org.freedesktop.DBus.Error.AccessDenied')
        snapshot, = await self.run_cycles(query)
        self.assertTrue(snapshot['connected'])
        self.assertEqual(len(snapshot['requests']), 2)
        self.assertEqual(snapshot['changes'], [])

    async def test_confirmed_missing_owner_still_clears_only_its_requests(self):
        async def query(message):
            if message.body[0] == self.screen:
                return NS(message_type=MessageType.ERROR, body=[],
                          error_name='org.freedesktop.DBus.Error.NameHasNoOwner')
            return NS(message_type=MessageType.METHOD_RETURN, body=[':1.33'])
        snapshot, = await self.run_cycles(query)
        self.assertTrue(snapshot['connected'])
        self.assertEqual([r['service'] for r in snapshot['requests']], [self.gnome])

    async def test_owner_change_signal_wins_even_when_overlapping_query_times_out(self):
        async def query(message):
            if message.body[0] == self.screen:
                self.monitor._handle_message(Message(message_type=MessageType.SIGNAL,
                    sender='org.freedesktop.DBus', path='/org/freedesktop/DBus',
                    interface='org.freedesktop.DBus', member='NameOwnerChanged', signature='sss',
                    body=[self.screen, ':1.32', ':1.34']), self.control)
                self.confirm(self.screen, ':1.34', 3)
                raise TimeoutError('late failure of old owner query')
            return NS(message_type=MessageType.METHOD_RETURN, body=[':1.33'])
        snapshot, = await self.run_cycles(query)
        self.assertTrue(snapshot['connected'])
        self.assertEqual(snapshot['owners'][self.screen], ':1.34')
        self.assertEqual({r['cookie'] for r in snapshot['requests']}, {2, 3})

    async def test_valid_release_is_still_observed_during_query_failures(self):
        async def query(message):
            raise TimeoutError('metadata unavailable')
        def release_after_first_tick(number):
            if number != 1:
                return
            self.monitor._handle_message(Message(destination=self.screen, path='/ScreenSaver',
                interface=self.screen, member='UnInhibit', signature='u', body=[1],
                sender=':1.100', serial=10), self.control)
            self.monitor._handle_message(Message(message_type=MessageType.METHOD_RETURN,
                sender=':1.32', destination=':1.100', reply_serial=10), self.control)
        first, second = await self.run_cycles(query, cycles=2, after_tick=release_after_first_tick)
        self.assertEqual(len(first['requests']), 2)
        self.assertEqual([r['service'] for r in second['requests']], [self.gnome])
        self.assertTrue(second['connected'])

    async def test_real_observer_disconnect_still_clears_observations(self):
        self.connection.connected = False
        async def query(message):
            raise TimeoutError('metadata unavailable')
        with patch('external_inhibit_monitor.MessageBus', side_effect=PermissionError('denied')):
            snapshot, = await self.run_cycles(query)
        self.assertEqual(snapshot['requests'], [])
        self.assertEqual(snapshot['status'], 'unavailable')

    async def test_initial_lookup_failure_is_unavailable_not_not_needed(self):
        self.monitor.connection = None
        self.monitor.tracker.clear()
        async def query(message):
            return NS(message_type=MessageType.ERROR, body=[],
                      error_name='org.freedesktop.DBus.Error.NoReply')
        snapshot, = await self.run_cycles(query)
        self.assertEqual(snapshot['status'], 'unavailable')

    async def test_unknown_owner_does_not_disconnect_a_healthy_empty_monitor(self):
        self.monitor.tracker.clear()
        async def query(message):
            raise TimeoutError('metadata unavailable')
        snapshot, = await self.run_cycles(query)
        self.assertTrue(snapshot['connected'])
        self.assertEqual(snapshot['requests'], [])
        self.assertEqual(snapshot['status'], 'partial')

    async def test_stop_cancels_an_owner_query_and_clears_requests_immediately(self):
        querying = asyncio.Event()
        async def query(message):
            querying.set()
            await asyncio.Event().wait()
        self.control.call = query
        self.monitor.start(self.control)
        await querying.wait()
        await self.monitor.stop()
        self.assertFalse(self.connection.connected)
        self.assertEqual(self.monitor.tracker.requests(), [])
        self.assertIsNone(self.monitor.task)
        self.assertTrue(self.control.connected)
