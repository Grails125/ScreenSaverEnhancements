"""Behavioral contract for passive observation of external D-Bus inhibitors.

Only public tracker methods are exercised. Replies use the *caller's* method
serial; service reply serials are unrelated. The 30-second lifetime applies to
pending calls, not confirmed inhibitors. Status/event application fields follow
the existing backend's ``application`` spelling. Capacity tests intentionally
do not prescribe eviction order or an optional per-sender quota.
"""

from contextlib import ExitStack
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'defaults'))
sys.path.insert(0, str(ROOT))

from dbus_next import Message, MessageType
from dbus_next.aio import MessageBus
from dbus_next.message_bus import BaseMessageBus
from external_inhibit_monitor import InhibitTracker


SCREENSAVER = (
    'org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver',
    'org.freedesktop.ScreenSaver',
)
LEGACY_SCREENSAVER = (SCREENSAVER[0], '/ScreenSaver', SCREENSAVER[2])
POWER = (
    'org.freedesktop.PowerManagement', '/org/freedesktop/PowerManagement/Inhibit',
    'org.freedesktop.PowerManagement.Inhibit',
)
POWER_INHIBIT = ('org.freedesktop.PowerManagement.Inhibit', POWER[1], POWER[2])
GNOME = (
    'org.gnome.SessionManager', '/org/gnome/SessionManager',
    'org.gnome.SessionManager',
)
ROUTES = (SCREENSAVER, LEGACY_SCREENSAVER, POWER, POWER_INHIBIT, GNOME)


class FakeClock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class ExternalInhibitMonitorTests(unittest.TestCase):
    def setUp(self):
        self.reset_tracker()

    def reset_tracker(self):
        """Give parameterized cases independent state, even when one case fails."""
        self.clock = FakeClock()
        self.events = []
        self.changed = Mock()
        self.owners = {
            SCREENSAVER[0]: ':1.201',
            POWER[0]: ':1.202',
            POWER_INHIBIT[0]: ':1.202',
            GNOME[0]: ':1.203',
        }
        self.tracker = InhibitTracker(self.record_event, self.changed, clock=self.clock)
        self.tracker.set_owners(dict(self.owners))
        self.changed.reset_mock()
        self.serial = 0

    def record_event(self, event_type, detail=None, **fields):
        self.events.append({'type': event_type, 'detail': detail, **fields})

    def inhibit_call(self, route=SCREENSAVER, application='mpv', reason='playing video',
                     caller=':1.101', **overrides):
        self.serial += 1
        service, path, interface = route
        gnome = interface == GNOME[2]
        fields = dict(
            destination=service, path=path, interface=interface, member='Inhibit',
            sender=caller, serial=self.serial, signature='susu' if gnome else 'ss',
            body=[application, 42, reason, 8] if gnome else [application, reason],
        )
        fields.update(overrides)
        return Message(**fields)

    def release_call(self, cookie, route=SCREENSAVER, caller=':1.101', **overrides):
        self.serial += 1
        service, path, interface = route
        fields = dict(
            destination=service, path=path, interface=interface,
            member='Uninhibit' if interface == GNOME[2] else 'UnInhibit',
            sender=caller, serial=self.serial, signature='u', body=[cookie],
        )
        fields.update(overrides)
        return Message(**fields)

    def success(self, call, cookie=17, **overrides):
        # Real service replies have no interface/path/member, only correlation headers.
        fields = dict(
            message_type=MessageType.METHOD_RETURN,
            sender=self.owners.get(call.destination, call.destination),
            destination=call.sender, reply_serial=call.serial,
            serial=10000 + call.serial,
            signature='u' if call.member == 'Inhibit' else '',
            body=[cookie] if call.member == 'Inhibit' else [],
        )
        fields.update(overrides)
        return Message(**fields)

    def error(self, call):
        return Message(
            message_type=MessageType.ERROR,
            sender=self.owners.get(call.destination, call.destination),
            destination=call.sender, reply_serial=call.serial, serial=20000 + call.serial,
            error_name='org.freedesktop.DBus.Error.Failed', signature='s', body=['denied'],
        )

    def confirm(self, cookie=17, **kwargs):
        call = self.inhibit_call(**kwargs)
        self.tracker.feed(call)
        self.tracker.feed(self.success(call, cookie))
        return call

    def disconnect(self, caller=':1.101', **overrides):
        fields = dict(
            message_type=MessageType.SIGNAL, sender='org.freedesktop.DBus',
            path='/org/freedesktop/DBus', interface='org.freedesktop.DBus',
            member='NameOwnerChanged', signature='sss', body=[caller, caller, ''],
        )
        fields.update(overrides)
        return Message(**fields)

    def assert_record(self, record, application='mpv', reason='playing video', cookie=17,
                      service=SCREENSAVER[0]):
        self.assertIsInstance(record, dict)
        for field, expected in dict(application=application, reason=reason, cookie=cookie,
                                    source='observed', service=service).items():
            self.assertEqual(record[field], expected, field)

    def assert_event(self, index, detail, application='mpv', reason='playing video', cookie=17):
        event = self.events[index]
        for field, expected in dict(type='dbus_observed_request', detail=detail,
                                    application=application, reason=reason, cookie=cookie).items():
            self.assertEqual(event[field], expected, field)

    def assert_no_effects(self):
        self.assertEqual(self.tracker.requests(), [])
        self.assertEqual(self.events, [])
        self.changed.assert_not_called()

    def test_new_tracker_has_no_requests_without_a_clock_argument(self):
        tracker = InhibitTracker(Mock(), Mock())
        self.assertEqual(tracker.requests(), [])

    def test_inhibit_is_not_active_or_announced_until_success_reply(self):
        call = self.inhibit_call()
        self.tracker.feed(call)
        self.assert_no_effects()

        self.tracker.feed(self.success(call))
        records = self.tracker.requests()
        self.assertIsInstance(records, list)
        self.assertEqual(len(records), 1)
        self.assert_record(records[0])
        self.changed.assert_called()
        self.assertEqual(len(self.events), 1)
        self.assert_event(0, 'inhibit')

    def test_all_known_services_paths_and_gnome_argument_layout(self):
        for index, route in enumerate(ROUTES):
            with self.subTest(service=route[0], path=route[1]):
                self.confirm(cookie=index + 1, route=route, application=f'player-{index}',
                             reason=f'reason-{index}')
                matching = [r for r in self.tracker.requests()
                            if r['application'] == f'player-{index}']
                self.assertEqual(len(matching), 1)
                self.assert_record(matching[0], application=f'player-{index}',
                                   reason=f'reason-{index}', cookie=index + 1, service=route[0])

    def test_calls_to_mapped_unique_owner_are_observed(self):
        call = self.inhibit_call(destination=self.owners[SCREENSAVER[0]])
        self.tracker.feed(call)
        self.tracker.feed(self.success(call))
        self.assertEqual(len(self.tracker.requests()), 1)
        self.assert_record(self.tracker.requests()[0])

    def test_error_reply_does_not_inhibit_or_leave_confirmable_pending_call(self):
        call = self.inhibit_call()
        self.tracker.feed(call)
        self.tracker.feed(self.error(call))
        self.assert_no_effects()
        self.tracker.feed(self.success(call))
        self.assert_no_effects()

    def test_foreign_or_mismatched_reply_cannot_confirm_or_consume_pending_call(self):
        for overrides in ({'sender': ':1.999'}, {'destination': ':1.999'},
                          {'reply_serial': 9999}):
            with self.subTest(overrides=overrides):
                self.reset_tracker()
                call = self.inhibit_call()
                self.tracker.feed(call)
                self.tracker.feed(self.success(call, **overrides))
                self.assert_no_effects()
                self.tracker.feed(self.success(call))
                self.assertEqual(len(self.tracker.requests()), 1)

    def test_unsolicited_success_reply_is_ignored(self):
        call = self.inhibit_call()
        self.tracker.feed(self.success(call))
        self.assert_no_effects()

    def test_replies_are_correlated_by_caller_and_method_serial_not_service_serial(self):
        first = self.inhibit_call(caller=':1.101', serial=77, application='first')
        second = self.inhibit_call(caller=':1.102', serial=77, application='second')
        self.tracker.feed(first)
        self.tracker.feed(second)
        self.tracker.feed(self.success(second, cookie=22, serial=801))
        self.tracker.feed(self.success(first, cookie=11, serial=802))
        self.assertCountEqual(
            [(r['application'], r['cookie']) for r in self.tracker.requests()],
            [('first', 11), ('second', 22)],
        )

    def test_successful_release_removes_record_and_emits_original_application_and_reason(self):
        self.confirm()
        self.changed.reset_mock()
        call = self.release_call(17)
        self.tracker.feed(call)
        self.assertEqual(len(self.tracker.requests()), 1)
        self.assertEqual(len(self.events), 1)
        self.changed.assert_not_called()

        self.tracker.feed(self.success(call))
        self.assertEqual(self.tracker.requests(), [])
        self.changed.assert_called()
        self.assertEqual(len(self.events), 2)
        self.assert_event(1, 'uninhibit')

    def test_delayed_release_reply_does_not_remove_reused_cookie(self):
        self.confirm(cookie=17, application='original', reason='original playback')
        delayed_release = self.release_call(17)
        self.tracker.feed(delayed_release)

        # The service releases the original inhibitor, reuses its cookie, and
        # confirms the replacement before sending the older release's reply.
        self.confirm(cookie=17, application='replacement', reason='new playback')
        replacement = self.tracker.requests()
        self.assertEqual(len(replacement), 1)
        self.assert_record(replacement[0], application='replacement', reason='new playback')
        self.events.clear()
        self.changed.reset_mock()

        self.tracker.feed(self.success(delayed_release))

        self.assertEqual(self.tracker.requests(), replacement)
        self.assertEqual(self.events, [])
        self.changed.assert_not_called()

    def test_release_supported_for_each_known_route_including_gnome_spelling(self):
        for route in ROUTES:
            with self.subTest(route=route):
                self.confirm(route=route)
                call = self.release_call(17, route=route)
                self.tracker.feed(call)
                self.tracker.feed(self.success(call))
                self.assertEqual(self.tracker.requests(), [])

    def test_error_release_keeps_record_without_notification(self):
        self.confirm()
        self.events.clear()
        self.changed.reset_mock()
        call = self.release_call(17)
        self.tracker.feed(call)
        self.tracker.feed(self.error(call))
        self.assertEqual(len(self.tracker.requests()), 1)
        self.assertEqual(self.events, [])
        self.changed.assert_not_called()

    def test_foreign_caller_and_unknown_cookie_cannot_release(self):
        self.confirm()
        self.events.clear()
        self.changed.reset_mock()
        for kwargs in ({'cookie': 17, 'caller': ':1.102'}, {'cookie': 18}):
            with self.subTest(kwargs=kwargs):
                call = self.release_call(**kwargs)
                self.tracker.feed(call)
                self.tracker.feed(self.success(call))
                self.assertEqual(len(self.tracker.requests()), 1)
                self.assertEqual(self.events, [])
                self.changed.assert_not_called()

    def test_foreign_or_mismatched_reply_cannot_release_or_consume_pending_release(self):
        for overrides in ({'sender': ':1.999'}, {'destination': ':1.999'},
                          {'reply_serial': 9999}):
            with self.subTest(overrides=overrides):
                self.reset_tracker()
                self.confirm()
                self.events.clear()
                self.changed.reset_mock()
                call = self.release_call(17)
                self.tracker.feed(call)
                self.tracker.feed(self.success(call, **overrides))
                self.assertEqual(len(self.tracker.requests()), 1)
                self.assertEqual(self.events, [])
                self.changed.assert_not_called()
                self.tracker.feed(self.success(call))
                self.assertEqual(self.tracker.requests(), [])

    def test_identical_cookies_from_different_callers_are_independent(self):
        self.confirm(application='first', caller=':1.101')
        self.confirm(application='second', caller=':1.102')
        self.assertEqual(len(self.tracker.requests()), 2)
        call = self.release_call(17, caller=':1.101')
        self.tracker.feed(call)
        self.tracker.feed(self.success(call))
        self.assertEqual([r['application'] for r in self.tracker.requests()], ['second'])

    def test_identical_cookies_at_different_owners_are_independent(self):
        self.owners[POWER_INHIBIT[0]] = ':1.204'
        self.tracker.set_owners(dict(self.owners))
        self.confirm(route=POWER, application='first-owner')
        self.confirm(route=POWER_INHIBIT, application='second-owner')
        self.assertEqual(len(self.tracker.requests()), 2)
        call = self.release_call(17, route=POWER)
        self.tracker.feed(call)
        self.tracker.feed(self.success(call))
        self.assertEqual([r['application'] for r in self.tracker.requests()], ['second-owner'])

    def test_identical_cookies_at_same_owner_on_different_interfaces_are_independent(self):
        self.owners[POWER[0]] = self.owners[SCREENSAVER[0]]
        self.tracker.set_owners(dict(self.owners))
        self.confirm(application='screen')
        self.confirm(route=POWER, application='power')
        self.assertEqual(len(self.tracker.requests()), 2)
        call = self.release_call(17)
        self.tracker.feed(call)
        self.tracker.feed(self.success(call))
        self.assertEqual([r['application'] for r in self.tracker.requests()], ['power'])

    def test_release_to_wrong_owner_or_interface_does_not_remove_request(self):
        self.confirm()
        self.events.clear()
        self.changed.reset_mock()
        for route in (POWER, GNOME):
            with self.subTest(route=route):
                call = self.release_call(17, route=route)
                self.tracker.feed(call)
                self.tracker.feed(self.success(call))
                self.assertEqual(len(self.tracker.requests()), 1)
                self.assertEqual(self.events, [])
                self.changed.assert_not_called()

    def test_invalid_inhibit_signature_body_path_interface_and_member_are_ignored(self):
        invalid = (
            {'signature': 's', 'body': ['mpv']},
            {'signature': 'su', 'body': ['mpv', 1]},
            {'body': []}, {'body': ['mpv']}, {'body': ['mpv', 'video', 'extra']},
            {'body': [123, 'video']}, {'body': ['mpv', 123]}, {'body': None},
            {'path': '/org/freedesktop/Other'},
            {'interface': 'org.example.Unrelated'}, {'interface': None},
            {'member': 'GetActive'}, {'sender': None},
            {'message_type': MessageType.SIGNAL},
        )
        for overrides in invalid:
            with self.subTest(overrides=overrides):
                self.reset_tracker()
                call = self.inhibit_call(**overrides)
                self.tracker.feed(call)
                self.tracker.feed(self.success(call))
                self.assert_no_effects()

    def test_gnome_invalid_signature_and_argument_types_are_ignored(self):
        invalid = (
            {'signature': 'ss', 'body': ['mpv', 'video']},
            {'body': ['mpv', 42, 'video']},
            {'body': [3, 42, 'video', 8]}, {'body': ['mpv', '42', 'video', 8]},
            {'body': ['mpv', 42, 99, 8]}, {'body': ['mpv', 42, 'video', '8']},
            {'body': ['mpv', -1, 'video', 8]},
            {'body': ['mpv', 42, 'video', 2 ** 32]},
            {'path': '/ScreenSaver'},
        )
        for overrides in invalid:
            with self.subTest(overrides=overrides):
                self.reset_tracker()
                call = self.inhibit_call(route=GNOME, **overrides)
                self.tracker.feed(call)
                self.tracker.feed(self.success(call))
                self.assert_no_effects()

    def test_invalid_release_signature_body_path_and_interface_cannot_release(self):
        invalid = (
            {'signature': 's', 'body': ['17']}, {'body': []}, {'body': [17, 18]},
            {'body': ['17']}, {'body': [-1]}, {'body': [2 ** 32]}, {'body': [True]},
            {'path': '/Other'}, {'interface': 'org.example.Unrelated'},
            {'member': 'Other'}, {'message_type': MessageType.SIGNAL},
        )
        for overrides in invalid:
            with self.subTest(overrides=overrides):
                self.reset_tracker()
                self.confirm()
                self.events.clear()
                self.changed.reset_mock()
                call = self.release_call(17, **overrides)
                self.tracker.feed(call)
                self.tracker.feed(self.success(call))
                self.assertEqual(len(self.tracker.requests()), 1)
                self.assertEqual(self.events, [])
                self.changed.assert_not_called()

    def test_invalid_inhibit_reply_signature_body_and_cookie_are_ignored(self):
        invalid = (
            {'signature': '', 'body': []}, {'signature': 's', 'body': ['17']},
            {'body': []}, {'body': [17, 18]}, {'body': ['17']},
            {'body': [-1]}, {'body': [2 ** 32]}, {'body': [True]},
        )
        for overrides in invalid:
            with self.subTest(overrides=overrides):
                self.reset_tracker()
                call = self.inhibit_call()
                self.tracker.feed(call)
                self.tracker.feed(self.success(call, **overrides))
                self.assert_no_effects()

    def test_release_reply_must_have_empty_signature_and_body(self):
        for overrides in ({'signature': 'u', 'body': [17]}, {'body': [17]}):
            with self.subTest(overrides=overrides):
                self.reset_tracker()
                self.confirm()
                self.events.clear()
                self.changed.reset_mock()
                call = self.release_call(17)
                self.tracker.feed(call)
                self.tracker.feed(self.success(call, **overrides))
                self.assertEqual(len(self.tracker.requests()), 1)
                self.assertEqual(self.events, [])
                self.changed.assert_not_called()

    def test_destinations_not_in_external_owner_map_are_ignored(self):
        for destination in ('org.example.ScreenSaver', ':1.999'):
            with self.subTest(destination=destination):
                call = self.inhibit_call(destination=destination)
                self.tracker.feed(call)
                self.tracker.feed(self.success(call, sender=':1.999'))
                self.assert_no_effects()
        self.tracker.set_owners({})
        self.changed.reset_mock()
        call = self.inhibit_call()
        self.tracker.feed(call)
        self.tracker.feed(self.success(call))
        self.assert_no_effects()

    def test_steam_and_steamwebhelper_are_ignored_for_every_known_service(self):
        for route in ROUTES:
            for application in ('Steam', './steamwebhelper'):
                with self.subTest(route=route, application=application):
                    call = self.inhibit_call(route=route, application=application)
                    self.tracker.feed(call)
                    self.tracker.feed(self.success(call))
                    self.assert_no_effects()

    def test_owner_replacement_drops_only_affected_records_and_pending_calls(self):
        self.confirm(application='old-screen')
        self.confirm(route=GNOME, application='kept-gnome')
        old_pending = self.inhibit_call(application='stale-screen')
        kept_pending = self.inhibit_call(route=GNOME, application='pending-gnome')
        self.tracker.feed(old_pending)
        self.tracker.feed(kept_pending)
        stale_reply = self.success(old_pending)
        self.changed.reset_mock()
        self.owners[SCREENSAVER[0]] = ':1.301'
        self.tracker.set_owners(dict(self.owners))
        self.assertEqual([r['application'] for r in self.tracker.requests()], ['kept-gnome'])
        self.changed.assert_called()
        self.tracker.feed(stale_reply)
        self.tracker.feed(self.success(old_pending))
        self.tracker.feed(self.success(kept_pending, cookie=18))
        self.confirm(application='new-screen')
        self.assertCountEqual([r['application'] for r in self.tracker.requests()],
                              ['kept-gnome', 'pending-gnome', 'new-screen'])

    def test_removing_service_owner_drops_only_its_records(self):
        self.confirm()
        self.confirm(route=GNOME, application='gnome')
        del self.owners[SCREENSAVER[0]]
        self.changed.reset_mock()
        self.tracker.set_owners(dict(self.owners))
        self.assertEqual([r['application'] for r in self.tracker.requests()], ['gnome'])
        self.changed.assert_called()

    def test_owner_replacement_discards_only_affected_pending_releases(self):
        self.confirm(application='old-screen')
        self.confirm(route=GNOME, application='kept-gnome')
        old_release = self.release_call(17)
        kept_release = self.release_call(17, route=GNOME)
        self.tracker.feed(old_release)
        self.tracker.feed(kept_release)
        stale_reply = self.success(old_release)
        self.owners[SCREENSAVER[0]] = ':1.301'
        self.tracker.set_owners(dict(self.owners))
        self.confirm(application='new-screen')
        self.events.clear()
        self.changed.reset_mock()
        self.tracker.feed(stale_reply)
        self.tracker.feed(self.success(old_release))
        self.assertCountEqual([r['application'] for r in self.tracker.requests()],
                              ['kept-gnome', 'new-screen'])
        self.assertEqual(self.events, [])
        self.changed.assert_not_called()
        self.tracker.feed(self.success(kept_release))
        self.assertEqual([r['application'] for r in self.tracker.requests()], ['new-screen'])

    def test_unchanged_owner_map_preserves_records_and_pending_calls(self):
        self.confirm()
        pending = self.inhibit_call(application='pending')
        self.tracker.feed(pending)
        self.changed.reset_mock()
        self.tracker.set_owners(dict(self.owners))
        self.assertEqual(len(self.tracker.requests()), 1)
        self.changed.assert_not_called()
        self.tracker.feed(self.success(pending, cookie=18))
        self.assertEqual(len(self.tracker.requests()), 2)

    def test_clear_empties_records_and_pending_calls_and_notifies(self):
        self.confirm()
        pending = self.inhibit_call(application='pending')
        self.tracker.feed(pending)
        self.changed.reset_mock()
        self.tracker.clear()
        self.assertEqual(self.tracker.requests(), [])
        self.changed.assert_called()
        self.tracker.feed(self.success(pending))
        self.assertEqual(self.tracker.requests(), [])

    def test_clear_discards_pending_release_before_cookie_is_reused(self):
        self.confirm(application='original')
        pending = self.release_call(17)
        self.tracker.feed(pending)
        self.tracker.clear()
        self.tracker.set_owners(dict(self.owners))
        self.confirm(application='replacement')
        self.events.clear()
        self.changed.reset_mock()
        self.tracker.feed(self.success(pending))
        self.assertEqual([r['application'] for r in self.tracker.requests()], ['replacement'])
        self.assertEqual(self.events, [])
        self.changed.assert_not_called()

    def test_client_disconnect_drops_only_that_callers_records_across_services(self):
        self.confirm(application='client-screen')
        self.confirm(route=GNOME, application='client-gnome')
        self.confirm(caller=':1.102', application='other-client')
        self.changed.reset_mock()
        self.tracker.feed(self.disconnect())
        self.assertEqual([r['application'] for r in self.tracker.requests()], ['other-client'])
        self.changed.assert_called()

    def test_client_disconnect_discards_only_that_callers_pending_calls(self):
        pending = self.inhibit_call()
        other = self.inhibit_call(caller=':1.102', application='other-client', serial=pending.serial)
        self.tracker.feed(pending)
        self.tracker.feed(other)
        self.tracker.feed(self.disconnect())
        self.tracker.feed(self.success(pending))
        self.assert_no_effects()
        self.tracker.feed(self.success(other))
        self.assertEqual([r['application'] for r in self.tracker.requests()], ['other-client'])

    def test_unknown_client_disconnect_is_harmless(self):
        self.confirm()
        self.changed.reset_mock()
        self.events.clear()
        self.tracker.feed(self.disconnect(caller=':1.999'))
        self.assertEqual(len(self.tracker.requests()), 1)
        self.changed.assert_not_called()
        self.assertEqual(self.events, [])

    def test_forged_or_invalid_owner_change_signals_cannot_drop_records(self):
        invalid = (
            {'sender': ':1.999'}, {'interface': 'org.example.Unrelated'},
            {'path': '/Other'}, {'member': 'Other'},
            {'signature': 'ss', 'body': [':1.101', '']},
            {'body': [':1.101', ':1.101']},
            {'body': [':1.101', ':1.999', '']},
            {'body': [':1.101', ':1.101', ':1.999']},
            {'body': [':1.101', ':1.101', 0]},
        )
        for overrides in invalid:
            with self.subTest(overrides=overrides):
                self.reset_tracker()
                self.confirm()
                self.events.clear()
                self.changed.reset_mock()
                self.tracker.feed(self.disconnect(**overrides))
                self.assertEqual(len(self.tracker.requests()), 1)
                self.changed.assert_not_called()
                self.assertEqual(self.events, [])

    def test_pending_inhibit_succeeds_before_thirty_seconds(self):
        pending = self.inhibit_call()
        self.tracker.feed(pending)
        self.clock.advance(29.999)
        self.tracker.feed(self.success(pending))
        self.assertEqual(len(self.tracker.requests()), 1)

    def test_pending_inhibit_expires_after_thirty_seconds(self):
        pending = self.inhibit_call()
        self.tracker.feed(pending)
        self.clock.advance(30.001)
        self.tracker.feed(self.success(pending))
        self.assert_no_effects()
        self.confirm(application='fresh')
        self.assertEqual([r['application'] for r in self.tracker.requests()], ['fresh'])

    def test_pending_release_expires_but_confirmed_inhibitor_does_not(self):
        self.confirm()
        pending = self.release_call(17)
        self.tracker.feed(pending)
        self.events.clear()
        self.changed.reset_mock()
        self.clock.advance(30.001)
        self.tracker.feed(self.success(pending))
        self.assertEqual(len(self.tracker.requests()), 1)
        self.assertEqual(self.events, [])
        self.changed.assert_not_called()
        fresh = self.release_call(17)
        self.tracker.feed(fresh)
        self.tracker.feed(self.success(fresh))
        self.assertEqual(self.tracker.requests(), [])

    def test_pending_calls_are_bounded_to_256_without_inspecting_internal_storage(self):
        calls = [self.inhibit_call(caller=f':1.{1000 + index}',
                                   application=f'player-{index}') for index in range(300)]
        for call in calls:
            self.tracker.feed(call)
        self.assert_no_effects()
        confirmed = []
        for index, call in enumerate(calls):
            self.tracker.feed(self.success(call, cookie=index + 1))
            confirmed.extend(r['application'] for r in self.tracker.requests())
            # Keep active capacity free, so an unbounded pending store cannot
            # hide behind the separate 256-confirmed-record limit.
            release = self.release_call(index + 1, caller=call.sender)
            self.tracker.feed(release)
            self.tracker.feed(self.success(release))
            self.assertEqual(self.tracker.requests(), [])
        self.assertEqual(len(confirmed), 256)
        self.assertEqual(self.tracker.requests(), [])
        self.events.clear()
        self.changed.reset_mock()
        for index, call in enumerate(calls):
            self.tracker.feed(self.success(call, cookie=index + 1))
        self.assert_no_effects()

    def test_confirmed_requests_are_bounded_to_256_total_across_callers(self):
        for index in range(300):
            self.confirm(cookie=index + 1, caller=f':1.{1000 + index}',
                         application=f'player-{index}')
            self.assertLessEqual(len(self.tracker.requests()), 256)
        records = self.tracker.requests()
        self.assertEqual(len(records), 256)
        for record in records:
            self.assertEqual(record['source'], 'observed')
        # Regardless of overflow policy, releasing retained records frees capacity.
        for record in records:
            index = int(record['application'].split('-')[1])
            call = self.release_call(record['cookie'], caller=f':1.{1000 + index}')
            self.tracker.feed(call)
            self.tracker.feed(self.success(call))
        self.assertEqual(self.tracker.requests(), [])
        self.confirm(application='after-capacity-freed')
        self.assertEqual([r['application'] for r in self.tracker.requests()], ['after-capacity-freed'])

    def test_tracker_never_connects_sends_or_calls_dbus(self):
        with ExitStack() as stack:
            transports = [stack.enter_context(patch.object(cls, method))
                          for cls, method in (
                              (MessageBus, 'connect'), (MessageBus, 'call'),
                              (MessageBus, 'send'), (BaseMessageBus, 'send'),
                          )]
            tracker = InhibitTracker(Mock(), Mock(), clock=self.clock)
            tracker.set_owners(dict(self.owners))
            call = self.inhibit_call()
            tracker.feed(call)
            tracker.feed(self.success(call))
            self.assertEqual(len(tracker.requests()), 1)
            release = self.release_call(17)
            tracker.feed(release)
            tracker.feed(self.success(release))
            self.assertEqual(tracker.requests(), [])
            tracker.feed(self.disconnect())
            tracker.clear()
            for transport in transports:
                transport.assert_not_called()


if __name__ == '__main__':
    unittest.main()
