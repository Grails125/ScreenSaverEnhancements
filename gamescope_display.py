"""Small Wayland client for Gamescope's internal-display sleep request.

Protocol: ValveSoftware/gamescope, protocol/gamescope-control.xml (version 4).
This changes display output only. The caller owns wake and crash recovery;
closing a connection deliberately does not wake a display owned by Steam.
"""

import re
import socket
import struct
import threading
import time
from pathlib import Path


class GamescopeDisplayError(RuntimeError):
    pass


def _string(value):
    encoded = value.encode('utf-8') + b'\0'
    return struct.pack('=I', len(encoded)) + encoded + b'\0' * (-len(encoded) % 4)


def _read_string(payload, offset):
    if len(payload) < offset + 4:
        raise GamescopeDisplayError('Malformed Wayland string')
    length, = struct.unpack_from('=I', payload, offset)
    offset += 4
    end = offset + length
    padded_end = offset + (length + 3) // 4 * 4
    if length < 1 or padded_end > len(payload) or payload[end - 1] != 0:
        raise GamescopeDisplayError('Malformed Wayland string')
    try:
        return payload[offset:end - 1].decode('utf-8'), padded_end
    except UnicodeDecodeError as error:
        raise GamescopeDisplayError('Invalid Wayland string') from error


class GamescopeDisplay:
    TIMEOUT_SECONDS = 2.0

    def __init__(self, connection):
        self._connection = connection
        self._next_id = 3
        self._control_id = None
        self._globals = []
        self._lock = threading.Lock()

    @classmethod
    def connect(cls, runtime_dir='/run/user/1000'):
        deadline = time.monotonic() + cls.TIMEOUT_SECONDS
        errors = []
        try:
            candidates = sorted(path for path in Path(runtime_dir).iterdir()
                                if re.fullmatch(r'gamescope-\d+', path.name))
        except OSError as error:
            raise GamescopeDisplayError(f'Cannot inspect Gamescope runtime directory: {error}') from error
        for path in candidates:
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            display = cls(connection)
            try:
                display._set_timeout(deadline)
                connection.connect(str(path))
                display._send(1, 1, struct.pack('=I', 2), deadline)  # wl_display.get_registry
                display._sync(deadline)
                supported = [(name, version) for name, interface, version in display._globals
                             if interface == 'gamescope_control' and version >= 4]
                if not supported:
                    raise GamescopeDisplayError('Unsupported gamescope_control version (requires >= 4)')
                name, _ = supported[0]
                display._control_id = display._allocate_id()
                payload = struct.pack('=I', name) + _string('gamescope_control')
                payload += struct.pack('=II', 4, display._control_id)
                display._send(2, 0, payload, deadline)  # wl_registry.bind
                display._sync(deadline)
                return display
            except (OSError, GamescopeDisplayError) as error:
                display.close()
                errors.append(f'{path.name}: {error}')
                if time.monotonic() >= deadline:
                    break
        raise GamescopeDisplayError('Gamescope display control unavailable: ' +
                                    ('; '.join(errors) if errors else 'no Gamescope Wayland socket'))

    def _allocate_id(self):
        value = self._next_id
        self._next_id += 1
        return value

    def _set_timeout(self, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise GamescopeDisplayError('Gamescope Wayland request timed out')
        self._connection.settimeout(remaining)

    def _send(self, object_id, opcode, payload, deadline):
        self._set_timeout(deadline)
        header = struct.pack('=II', object_id, ((8 + len(payload)) << 16) | opcode)
        self._connection.sendall(header + payload)

    def _receive(self, length, deadline):
        data = bytearray()
        while len(data) < length:
            self._set_timeout(deadline)
            chunk = self._connection.recv(length - len(data))
            if not chunk:
                raise GamescopeDisplayError('Gamescope Wayland connection closed')
            data.extend(chunk)
        return bytes(data)

    def _sync(self, deadline):
        callback = self._allocate_id()
        self._send(1, 0, struct.pack('=I', callback), deadline)
        while True:
            object_id, word = struct.unpack('=II', self._receive(8, deadline))
            length, opcode = word >> 16, word & 65535
            if length < 8 or length % 4:
                raise GamescopeDisplayError('Malformed Wayland message size')
            payload = self._receive(length - 8, deadline)
            if object_id == 1 and opcode == 0:
                if len(payload) < 12:
                    raise GamescopeDisplayError('Malformed Wayland protocol error')
                text, _ = _read_string(payload, 8)
                raise GamescopeDisplayError(f'Gamescope Wayland protocol error: {text}')
            if object_id == 2 and opcode == 0:
                if len(payload) < 12:
                    raise GamescopeDisplayError('Malformed Wayland global')
                name, = struct.unpack_from('=I', payload)
                interface, offset = _read_string(payload, 4)
                if len(payload) != offset + 4:
                    raise GamescopeDisplayError('Malformed Wayland global version')
                version, = struct.unpack_from('=I', payload, offset)
                self._globals.append((name, interface, version))
            if object_id == callback and opcode == 0:
                if len(payload) != 4:
                    raise GamescopeDisplayError('Malformed Wayland sync callback')
                return

    def _set_sleep(self, asleep):
        with self._lock:
            if self._connection is None or self._control_id is None:
                raise GamescopeDisplayError('Gamescope display connection is closed')
            deadline = time.monotonic() + self.TIMEOUT_SECONDS
            try:
                # gamescope_control.display_sleep is request opcode 3.
                self._send(self._control_id, 3, struct.pack('=II', 1, 1 if asleep else 2), deadline)
                self._sync(deadline)
            except (OSError, GamescopeDisplayError) as error:
                self._close_connection()
                raise GamescopeDisplayError(f'Gamescope display request failed: {error}') from error

    def sleep_internal(self):
        self._set_sleep(True)

    def wake_internal(self):
        self._set_sleep(False)

    def _close_connection(self):
        if self._connection is not None:
            self._connection.close()
            self._connection = None

    def close(self):
        with self._lock:
            self._close_connection()
