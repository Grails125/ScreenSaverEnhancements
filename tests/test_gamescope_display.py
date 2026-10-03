import socket
import struct
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from gamescope_display import GamescopeDisplay, GamescopeDisplayError


def message(object_id, opcode, payload=b''):
    return struct.pack('=II', object_id, (len(payload) + 8) << 16 | opcode) + payload


def string(value):
    encoded = value.encode() + b'\0'
    return struct.pack('=I', len(encoded)) + encoded + b'\0' * (-len(encoded) % 4)


class FakeGamescope:
    def __init__(self, directory, version=6, fragmented=False, error_on_sleep=False, silent=False):
        self.path = str(Path(directory) / 'gamescope-0')
        self.version = version
        self.fragmented = fragmented
        self.error_on_sleep = error_on_sleep
        self.silent = silent
        self.requests = []
        self.errors = []
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path)
        self.listener.listen(1)
        self.listener.settimeout(3)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def send(self, connection, data):
        if self.fragmented:
            for offset in range(0, len(data), 3):
                connection.sendall(data[offset:offset + 3])
        else:
            connection.sendall(data)

    def serve(self):
        try:
            connection, _ = self.listener.accept()
            connection.settimeout(3)
            with connection:
                def read(size):
                    data = b''
                    while len(data) < size:
                        chunk = connection.recv(size - len(data))
                        if not chunk:
                            return None
                        data += chunk
                    return data

                control = None
                while True:
                    header = read(8)
                    if header is None:
                        return
                    object_id, word = struct.unpack('=II', header)
                    payload = read((word >> 16) - 8)
                    opcode = word & 65535
                    self.requests.append((object_id, opcode, payload))
                    if object_id == 1 and opcode == 1:
                        registry, = struct.unpack('=I', payload)
                        global_payload = struct.pack('=I', 42) + string('gamescope_control') + struct.pack('=I', self.version)
                        self.send(connection, message(registry, 0, global_payload))
                    elif object_id == 1 and opcode == 0:
                        callback, = struct.unpack('=I', payload)
                        if not self.silent:
                            self.send(connection, message(callback, 0, struct.pack('=I', 0)))
                            self.send(connection, message(1, 1, struct.pack('=I', callback)))
                    elif opcode == 0 and object_id == 2:
                        length, = struct.unpack_from('=I', payload, 4)
                        version, control = struct.unpack_from('=II', payload, 8 + (length + 3) // 4 * 4)
                    elif object_id == control and opcode == 3 and self.error_on_sleep:
                        self.send(connection, message(1, 0, struct.pack('=II', control, 1) + string('display denied')))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self.errors.append(error)

    def close(self):
        self.listener.close()
        self.thread.join(4)
        if self.errors:
            raise self.errors[0]


class GamescopeDisplayTests(unittest.TestCase):
    def scenario(self, **options):
        temporary = tempfile.TemporaryDirectory(prefix='gc-', dir='.')
        self.addCleanup(temporary.cleanup)
        server = FakeGamescope(temporary.name, **options)
        self.addCleanup(server.close)
        return temporary.name, server

    @unittest.skipUnless(hasattr(socket, 'AF_UNIX'), 'Unix sockets require Linux')
    def test_sleep_and_wake_target_only_internal_panel_and_close_does_not_wake(self):
        directory, server = self.scenario()
        display = GamescopeDisplay.connect(directory)
        display.sleep_internal()
        display.wake_internal()
        display.close()
        server.thread.join(3)
        binds = [request for request in server.requests if request[:2] == (2, 0)]
        self.assertEqual(len(binds), 1)
        bind = binds[0][2]
        self.assertEqual(struct.unpack_from('=I', bind)[0], 42)
        self.assertIn(b'gamescope_control\0', bind)
        self.assertEqual(struct.unpack_from('=I', bind, len(bind) - 8)[0], 4)
        control = struct.unpack_from('=I', bind, len(bind) - 4)[0]
        self.assertEqual([payload for oid, op, payload in server.requests if oid == control and op == 3],
                         [struct.pack('=II', 1, 1), struct.pack('=II', 1, 2)])
        self.assertEqual(sum(oid == 1 and op == 0 for oid, op, _ in server.requests), 4)

    @unittest.skipUnless(hasattr(socket, 'AF_UNIX'), 'Unix sockets require Linux')
    def test_fragmented_registry_and_callback_messages_are_reassembled(self):
        directory, server = self.scenario(fragmented=True)
        display = GamescopeDisplay.connect(directory)
        display.sleep_internal()
        display.close()

    @unittest.skipUnless(hasattr(socket, 'AF_UNIX'), 'Unix sockets require Linux')
    def test_unsupported_protocol_is_rejected_without_display_requests(self):
        directory, server = self.scenario(version=3)
        with self.assertRaisesRegex(GamescopeDisplayError, 'version|unsupported'):
            GamescopeDisplay.connect(directory)
        server.thread.join(3)
        self.assertFalse(any(op == 3 for _, op, _ in server.requests))

    @unittest.skipUnless(hasattr(socket, 'AF_UNIX'), 'Unix sockets require Linux')
    def test_protocol_error_is_reported_and_connection_closed(self):
        directory, server = self.scenario(error_on_sleep=True)
        display = GamescopeDisplay.connect(directory)
        with self.assertRaisesRegex(GamescopeDisplayError, 'display denied'):
            display.sleep_internal()
        display.close()

    @unittest.skipUnless(hasattr(socket, 'AF_UNIX'), 'Unix sockets require Linux')
    def test_unresponsive_server_times_out_without_display_requests(self):
        directory, server = self.scenario(silent=True)
        with patch.object(GamescopeDisplay, 'TIMEOUT_SECONDS', 0.05):
            with self.assertRaisesRegex(GamescopeDisplayError, 'timed out'):
                GamescopeDisplay.connect(directory)
        server.thread.join(3)
        self.assertFalse(any(op == 3 for _, op, _ in server.requests))

    def test_non_gamescope_and_lock_files_are_not_connected(self):
        with tempfile.TemporaryDirectory(prefix='gc-', dir='.') as directory:
            Path(directory, 'gamescope-0.lock').touch()
            Path(directory, 'gamescope-0-ei').touch()
            Path(directory, 'wayland-0').touch()
            with self.assertRaises(GamescopeDisplayError):
                GamescopeDisplay.connect(directory)


if __name__ == '__main__':
    unittest.main()
