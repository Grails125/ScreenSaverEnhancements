"""Read-only observation of successful calls to externally owned idle APIs.

There is no portable baseline enumeration. A connected monitor is therefore
always partial: it describes observed requests, never all system inhibitors.
"""
import asyncio
import time

from dbus_next import Message, MessageType
from dbus_next.aio import MessageBus


SERVICES = {
    'org.freedesktop.ScreenSaver': ('org.freedesktop.ScreenSaver', ('/ScreenSaver', '/org/freedesktop/ScreenSaver')),
    'org.freedesktop.PowerManagement': ('org.freedesktop.PowerManagement.Inhibit', ('/org/freedesktop/PowerManagement/Inhibit',)),
    'org.freedesktop.PowerManagement.Inhibit': ('org.freedesktop.PowerManagement.Inhibit', ('/org/freedesktop/PowerManagement/Inhibit',)),
    'org.gnome.SessionManager': ('org.gnome.SessionManager', ('/org/gnome/SessionManager',)),
}


class InhibitTracker:
    MAX_REQUESTS = 256
    PENDING_TIMEOUT = 30

    def __init__(self, event_callback, change_callback, clock=time.monotonic):
        self.event = event_callback
        self.changed = change_callback
        self.clock = clock
        self.owners = {}
        self.pending = {}
        self.active = {}

    def set_owners(self, owners):
        self.owners = {name: owner for name, owner in owners.items() if name in SERVICES and owner}
        self.pending = {key: value for key, value in self.pending.items()
                        if self.owners.get(value['service']) == value['owner']}
        retained = {key: value for key, value in self.active.items()
                    if self.owners.get(value['service']) == value['owner']}
        changed = retained != self.active
        self.active = retained
        if changed:
            self.changed()

    def clear(self):
        changed = bool(self.active)
        self.pending.clear()
        self.active.clear()
        self.owners.clear()
        if changed:
            self.changed()

    def requests(self):
        return [dict(value) for value in self.active.values()]

    def feed(self, message):
        if not isinstance(message.body, (list, tuple)):
            return
        now = self.clock()
        self.pending = {key: value for key, value in self.pending.items()
                        if now - value['at'] < self.PENDING_TIMEOUT}
        if (message.message_type == MessageType.SIGNAL
                and message.sender == 'org.freedesktop.DBus'
                and message.path == '/org/freedesktop/DBus' and message.signature == 'sss'
                and message.interface == 'org.freedesktop.DBus'
                and message.member == 'NameOwnerChanged' and len(message.body) == 3):
            name, old, new = message.body
            if not all(isinstance(value, str) for value in (name, old, new)):
                return
            if name in self.owners and self.owners[name] == old:
                self.set_owners({key: value for key, value in self.owners.items() if key != name})
            if name.startswith(':') and old == name and not new:
                self.pending = {key: value for key, value in self.pending.items() if value['sender'] != name}
                retained = {key: value for key, value in self.active.items() if value['sender'] != name}
                if retained != self.active:
                    self.active = retained
                    self.changed()
            return
        if message.message_type == MessageType.METHOD_CALL:
            for service, owner in self.owners.items():
                interface, paths = SERVICES[service]
                if (message.destination not in (service, owner) or message.interface != interface
                        or message.path not in paths):
                    continue
                member, body = message.member, message.body
                if member == 'Inhibit':
                    gnome = interface == 'org.gnome.SessionManager'
                    if message.signature != ('susu' if gnome else 'ss') or len(body) != (4 if gnome else 2):
                        return
                    if gnome and any(type(value) is not int or not 0 <= value <= 0xffffffff for value in (body[1], body[3])):
                        return
                    application, reason = body[0], body[2 if gnome else 1]
                    if (not isinstance(application, str) or not isinstance(reason, str)
                            or len(application.encode('utf-8')) > 1024 or len(reason.encode('utf-8')) > 4096
                            or application in ('Steam', './steamwebhelper')):
                        return
                    data = {'application': application, 'reason': reason}
                elif member in ('UnInhibit', 'Uninhibit'):
                    if message.signature != 'u' or len(body) != 1 or type(body[0]) is not int:
                        return
                    key = (owner, interface, message.sender, body[0])
                    data = {'cookie': body[0], 'target': self.active.get(key)}
                else:
                    return
                if not message.sender or not message.serial or len(self.pending) >= self.MAX_REQUESTS:
                    return
                self.pending[(message.sender, message.serial)] = {
                    **data, 'owner': owner, 'service': service, 'interface': interface,
                    'sender': message.sender, 'member': member, 'at': now,
                }
                return
        elif message.message_type in (MessageType.METHOD_RETURN, MessageType.ERROR):
            correlation = (message.destination, message.reply_serial)
            request = self.pending.get(correlation)
            if request is None or message.sender != request['owner']:
                return
            self.pending.pop(correlation)
            if message.message_type == MessageType.ERROR:
                return
            if request['member'] == 'Inhibit':
                if (message.signature != 'u' or len(message.body) != 1
                        or type(message.body[0]) is not int or not 0 < message.body[0] <= 0xffffffff
                        or len(self.active) >= self.MAX_REQUESTS):
                    return
                cookie = message.body[0]
                key = (request['owner'], request['interface'], request['sender'], cookie)
                self.active[key] = {key: request[key] for key in ('application', 'reason', 'owner', 'sender', 'interface', 'service')}
                self.active[key].update(cookie=cookie, source='observed')
                entry, detail = self.active[key], 'inhibit'
            else:
                if message.signature or message.body:
                    return
                key = (request['owner'], request['interface'], request['sender'], request['cookie'])
                if request['target'] is None or self.active.get(key) is not request['target']:
                    return
                entry = self.active.pop(key, None)
                if entry is None:
                    return
                detail = 'uninhibit'
            self.event('dbus_observed_request', detail, application=entry['application'],
                       reason=entry['reason'], cookie=entry['cookie'], service=entry['service'])
            self.changed()


class ExternalInhibitMonitor:
    def __init__(self, event_callback, change_callback):
        self.tracker = InhibitTracker(event_callback, change_callback)
        self.event = event_callback
        self.connection = None
        self.task = None
        self.status = 'stopped'
        self.owner_revision = 0

    def _handle_message(self, message, control):
        self.tracker.feed(message)
        if (message.message_type == MessageType.SIGNAL and message.sender == 'org.freedesktop.DBus'
                and message.interface == 'org.freedesktop.DBus' and message.path == '/org/freedesktop/DBus'
                and message.member == 'NameOwnerChanged' and message.signature == 'sss'
                and isinstance(message.body, (list, tuple)) and len(message.body) == 3
                and all(isinstance(value, str) for value in message.body)):
            name, old, new = message.body
            if name in SERVICES:
                self.owner_revision += 1
                state = getattr(control, 'sse_service_states', {}).get(name, {})
                if new and new != getattr(control, 'unique_name', None) and state.get('status') == 'external':
                    self.tracker.set_owners({**self.tracker.owners, name: new})
        return message.message_type == MessageType.METHOD_CALL

    def _status(self, status):
        if status != self.status:
            self.status = status
            self.event('dbus_observer', status)

    def start(self, control_bus):
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run(control_bus))

    async def stop(self):
        task, self.task = self.task, None
        try:
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        finally:
            self._disconnect()
            self._status('stopped')

    def _disconnect(self):
        connection, self.connection = self.connection, None
        try:
            if connection:
                connection.disconnect()
        except Exception:
            self.event('dbus_observer', 'disconnect_failed')
        finally:
            self.tracker.clear()

    async def _run(self, control):
        try:
            while control.connected:
                try:
                    batch_revision = self.owner_revision
                    owners = {}
                    lookup_failed = False
                    for name, state in getattr(control, 'sse_service_states', {}).items():
                        if state['status'] != 'external':
                            continue
                        revision = self.owner_revision
                        try:
                            reply = await asyncio.wait_for(control.call(Message(
                                destination='org.freedesktop.DBus', path='/org/freedesktop/DBus',
                                interface='org.freedesktop.DBus', member='GetNameOwner', signature='s', body=[name])), 1)
                        except asyncio.CancelledError:
                            raise
                        except Exception:
                            reply = None
                        if revision != self.owner_revision:
                            if name in self.tracker.owners:
                                owners[name] = self.tracker.owners[name]
                            continue
                        if (reply is None or (reply.message_type == MessageType.ERROR
                                and reply.error_name != 'org.freedesktop.DBus.Error.NameHasNoOwner')):
                            # A failed metadata lookup is not an owner loss or a
                            # monitor outage. Keep its live cookies and retry on
                            # the next poll; signals/releases remain authoritative.
                            lookup_failed = True
                            if name in self.tracker.owners:
                                owners[name] = self.tracker.owners[name]
                            continue
                        if (reply.message_type != MessageType.ERROR and reply.body
                                and state['status'] == 'external'
                                and reply.body[0] != getattr(control, 'unique_name', None)):
                            owners[name] = reply.body[0]
                            state['owner'] = reply.body[0]
                    if batch_revision != self.owner_revision:
                        # A later query can overlap a change to an earlier
                        # service. The whole stale batch must yield to signals.
                        owners = dict(self.tracker.owners)
                    owners = {name: owner for name, owner in owners.items()
                              if control.sse_service_states[name]['status'] == 'external'
                              and owner != getattr(control, 'unique_name', None)}
                    if not owners:
                        if lookup_failed and self.connection is not None and self.connection.connected:
                            self.tracker.set_owners(owners)
                            self._status('partial')
                        else:
                            self._disconnect()
                            self._status('unavailable' if lookup_failed else 'not_needed')
                    elif self.connection is None or not self.connection.connected:
                        self._disconnect()
                        self.connection = MessageBus()
                        await asyncio.wait_for(self.connection.connect(), 2)
                        # Consume method calls, but let dbus_next deliver the
                        # BecomeMonitor return to its pending call future.
                        self.connection.add_message_handler(lambda msg: self._handle_message(msg, control))
                        # Well-known sender matches follow owner changes. Keep a
                        # stable subscription instead of dropping unrelated live
                        # cookies whenever one external service changes owner.
                        rules = [f"type='method_call',interface='{interface}'" for interface in sorted({value[0] for value in SERVICES.values()})]
                        for name in SERVICES:
                            rules.extend(f"type='{kind}',sender='{name}'" for kind in ('method_return', 'error'))
                        rules.append("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged'")
                        self.tracker.set_owners(owners)
                        reply = await asyncio.wait_for(self.connection.call(Message(
                            destination='org.freedesktop.DBus', path='/org/freedesktop/DBus',
                            interface='org.freedesktop.DBus.Monitoring', member='BecomeMonitor',
                            signature='asu', body=[rules, 0])), 2)
                        if reply.message_type == MessageType.ERROR:
                            raise RuntimeError(reply.error_name)
                        self._status('partial')
                    else:
                        self.tracker.set_owners(owners)
                        self._status('partial')
                    await asyncio.sleep(5)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self._disconnect()
                    self._status('unavailable')
                    await asyncio.sleep(5)
        finally:
            self._disconnect()
            if self.task is not None:
                self._status('unavailable')
