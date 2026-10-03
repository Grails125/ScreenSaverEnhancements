import asyncio
import unittest
import tempfile
import threading
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, patch

from display_wake_guard import DisplayWakeGuard, run_guard, guard_interpreter, display_lease, recover_owned_display, claim_connected_display, _standalone


class GuardTests(unittest.IsolatedAsyncioTestCase):
    def test_stale_recovery_skips_a_new_lease_without_waiting_for_its_lock(self):
        flock = unittest.mock.Mock(side_effect=BlockingIOError('held by new guard'))
        fcntl = SimpleNamespace(LOCK_EX=1, LOCK_UN=2, LOCK_NB=4, flock=flock)
        with tempfile.TemporaryDirectory() as directory, patch.dict('sys.modules', {'fcntl': fcntl}), patch('display_wake_guard.restore_display') as restore:
            path = directory + '/lease'
            Path(path).write_text('new', encoding='utf-8')
            recover_owned_display('old', path, wait_timeout=0.03)
            flock.assert_not_called()
            restore.assert_not_called()

    def test_recovery_lock_race_with_new_guard_exits_within_total_wait_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            path = directory + '/lease'
            Path(path).write_text('old', encoding='utf-8')
            def busy_lock(fd, op):
                # New guard claims after the initial unlocked owner read.
                Path(path).write_text('new', encoding='utf-8')
                raise BlockingIOError('new guard continues heartbeating')
            fcntl = SimpleNamespace(LOCK_EX=1, LOCK_UN=2, LOCK_NB=4, flock=busy_lock)
            with patch.dict('sys.modules', {'fcntl': fcntl}), patch('display_wake_guard.restore_display') as restore:
                started = time.monotonic()
                recover_owned_display('old', path, wait_timeout=0.03)
                self.assertLess(time.monotonic() - started, 0.15)
                restore.assert_not_called()

    async def test_failed_replacement_connection_keeps_old_recovery_authorized(self):
        fcntl = SimpleNamespace(LOCK_EX=1, LOCK_UN=2, LOCK_NB=4, flock=lambda fd, op: None)
        display_type = SimpleNamespace(connect=unittest.mock.Mock(side_effect=RuntimeError('disconnected')))
        with tempfile.TemporaryDirectory() as directory, patch.dict('sys.modules', {'fcntl': fcntl, 'gamescope_display': SimpleNamespace(GamescopeDisplay=display_type)}):
            path = directory + '/lease'
            with display_lease('old', claim=True, path=path):
                pass
            with display_lease('new', path=path), patch('display_wake_guard.claim_connected_display') as claim:
                with self.assertRaises(RuntimeError):
                    await _standalone('new')
                claim.assert_not_called()
            with patch('display_wake_guard.restore_display') as restore:
                recover_owned_display('old', path)
                restore.assert_called_once()

    async def test_replacement_failure_after_claim_still_restores_and_closes(self):
        display = unittest.mock.Mock()
        display_type = SimpleNamespace(connect=lambda: display)
        loop = asyncio.get_running_loop()
        with patch.dict('sys.modules', {'gamescope_display': SimpleNamespace(GamescopeDisplay=display_type)}), patch('display_wake_guard.signal.SIGHUP', 1, create=True), patch('display_wake_guard.claim_connected_display') as claim, patch.object(loop, 'add_signal_handler', side_effect=RuntimeError('signal setup failed')):
            with self.assertRaises(RuntimeError):
                await _standalone('new')
        claim.assert_called_once_with('new')
        display.wake_internal.assert_called_once()
        display.close.assert_called_once()

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Real flock requires Linux')
    def test_real_process_lease_blocks_new_ready_and_fences_delayed_old_recovery(self):
        root = str(Path(__file__).resolve().parents[1])
        with tempfile.TemporaryDirectory() as directory:
            path = directory + '/lease'
            with display_lease('old', claim=True, path=path):
                pass
            old_script = (
                'import sys, display_wake_guard as guard\n'
                'def wake():\n'
                ' print("WAKING", flush=True)\n'
                ' sys.stdin.readline()\n'
                'guard.restore_display=wake\n'
                'guard.recover_owned_display("old", sys.argv[1])\n'
            )
            new_script = (
                'import sys, display_wake_guard as guard\n'
                'with guard.display_lease("new", claim=True, path=sys.argv[1]):\n'
                ' print("READY", flush=True)\n'
            )
            old = subprocess.Popen([sys.executable, '-c', old_script, path], cwd=root,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            new = None
            try:
                self.assertEqual(old.stdout.readline(), 'WAKING\n')
                new = subprocess.Popen([sys.executable, '-c', new_script, path], cwd=root,
                                       stdout=subprocess.PIPE, text=True)
                time.sleep(0.03)
                self.assertIsNone(new.poll())
                old.communicate('\n', timeout=2)
                output, _ = new.communicate(timeout=2)
                self.assertEqual(output, 'READY\n')
                # Delayed old recovery cannot execute its physical wake callback.
                with patch('display_wake_guard.restore_display') as restore:
                    recover_owned_display('old', path)
                    restore.assert_not_called()
            finally:
                for process in (old, new):
                    if process is not None:
                        if process.poll() is None:
                            process.kill()
                        process.communicate()

    def test_delayed_old_recovery_cannot_wake_a_new_session(self):
        # Emulate flock on Windows while exercising the actual token/file logic.
        fcntl = SimpleNamespace(LOCK_EX=1, LOCK_UN=2, LOCK_NB=4, flock=lambda fd, op: None)
        with tempfile.TemporaryDirectory() as directory, patch.dict('sys.modules', {'fcntl': fcntl}), patch('display_wake_guard.restore_display') as restore:
            path = directory + '/lease'
            with display_lease('old', claim=True, path=path):
                pass
            with display_lease('new', claim=True, path=path):
                pass
            recover_owned_display('old', path=path)
            restore.assert_not_called()
            recover_owned_display('new', path=path)
            restore.assert_called_once()

    def test_old_physical_restore_blocks_replacement_claim_until_finished(self):
        lock = threading.Lock()
        # Closing an fd releases an OS flock. Model that by explicit unlock on
        # context exit, provided by production's LOCK_UN finally below.
        def flock(fd, op):
            if op == 2:
                lock.release()
            elif not lock.acquire(blocking=not bool(op & 4)):
                raise BlockingIOError()
        fcntl = SimpleNamespace(LOCK_EX=1, LOCK_UN=2, LOCK_NB=4, flock=flock)
        entered, release, claimed = threading.Event(), threading.Event(), threading.Event()
        def restore():
            entered.set()
            self.assertTrue(release.wait(1))
        with tempfile.TemporaryDirectory() as directory, patch.dict('sys.modules', {'fcntl': fcntl}), patch('display_wake_guard.restore_display', restore), ThreadPoolExecutor() as pool:
            path = directory + '/lease'
            with display_lease('old', claim=True, path=path):
                pass
            recovery = pool.submit(recover_owned_display, 'old', path)
            self.assertTrue(entered.wait(1))
            def replace():
                with display_lease('new', claim=True, path=path):
                    claimed.set()
            replacement = pool.submit(replace)
            self.assertFalse(claimed.wait(0.02))
            release.set()
            recovery.result(1)
            replacement.result(1)
            self.assertTrue(claimed.is_set())

    async def test_close_includes_contended_lock_in_its_total_budget(self):
        guard = DisplayWakeGuard()
        guard.CLOSE_TIMEOUT = 0.03
        await guard._lock.acquire()
        try:
            await asyncio.wait_for(guard.close(), 0.15)
        finally:
            guard._lock.release()

    async def test_close_cancels_pending_start_without_waiting_for_start_timeout(self):
        guard = DisplayWakeGuard()
        guard.CLOSE_TIMEOUT = 0.03
        entered = asyncio.Event()
        process = AsyncMock()
        process.returncode = None
        process.stdin.close = lambda: None
        process.kill = unittest.mock.Mock()
        async def ready():
            entered.set()
            await asyncio.Event().wait()
        async def wait():
            await asyncio.Event().wait()
        process.stdout.readline.side_effect = ready
        process.wait.side_effect = wait
        with patch('display_wake_guard.asyncio.create_subprocess_exec', return_value=process), patch('display_wake_guard.launch_recovery'):
            start = asyncio.create_task(guard.start())
            await entered.wait()
            await asyncio.wait_for(guard.close(), 0.15)
            process.kill.assert_called_once()
            start.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await start

    async def test_close_cancels_pending_heartbeat_and_releases_owned_session(self):
        guard = DisplayWakeGuard()
        guard.CLOSE_TIMEOUT = 0.03
        entered = asyncio.Event()
        process = AsyncMock()
        process.returncode = None
        process.stdin.write = lambda data: None
        process.stdin.close = lambda: None
        process.kill = unittest.mock.Mock()
        async def drain():
            entered.set()
            await asyncio.Event().wait()
        process.stdin.drain.side_effect = drain
        guard._process, guard._token = process, 'session'
        guard._children.add(process)
        with patch('display_wake_guard.launch_recovery') as recovery:
            heartbeat = asyncio.create_task(guard.heartbeat('session'))
            await entered.wait()
            await asyncio.wait_for(guard.close(), 0.15)
            with self.assertRaises(asyncio.CancelledError):
                await heartbeat
        process.kill.assert_called_once()
        recovery.assert_called_once_with('session')

    async def test_close_reaps_child_left_by_cancelled_stop_before_replacement(self):
        guard = DisplayWakeGuard()
        guard.CLOSE_TIMEOUT = 0.03
        entered = asyncio.Event()
        process = AsyncMock()
        process.returncode = None
        process.stdin.write = lambda data: None
        process.stdin.close = lambda: None
        process.kill = unittest.mock.Mock()
        async def wait():
            entered.set()
            await asyncio.Event().wait()
        process.wait.side_effect = wait
        guard._process, guard._token = process, 'session'
        guard._children.add(process)
        with patch('display_wake_guard.launch_recovery') as recovery:
            stop = asyncio.create_task(guard.stop('session'))
            await entered.wait()
            await asyncio.wait_for(guard.close(), 0.15)
            with self.assertRaises(asyncio.CancelledError):
                await stop
        process.kill.assert_called_once()
        recovery.assert_called_once_with('session')

    async def test_close_hands_failed_wake_to_independent_process_within_budget(self):
        guard = DisplayWakeGuard()
        guard.CLOSE_TIMEOUT = 0.03
        process = AsyncMock()
        process.returncode = None
        process.stdin.write = lambda data: None
        process.stdin.close = lambda: None
        process.kill = unittest.mock.Mock()
        async def blocked_wait():
            await asyncio.Event().wait()
        process.wait.side_effect = blocked_wait
        guard._process, guard._token = process, 'session'
        guard._children.add(process)
        with patch('display_wake_guard.launch_recovery') as recovery:
            await asyncio.wait_for(guard.close(), 0.15)
        process.kill.assert_called_once()
        recovery.assert_called_once_with('session')

    def test_guard_prefers_steamos_python_to_packaged_loader(self):
        with patch('display_wake_guard.os.access', return_value=True), patch('display_wake_guard.sys.executable', '/home/deck/homebrew/services/PluginLoader'):
            self.assertEqual(guard_interpreter(), '/usr/bin/python3')

    def test_guard_uses_local_python_when_system_python_is_absent(self):
        with patch('display_wake_guard.os.access', return_value=False), patch('display_wake_guard.sys.executable', 'local-python'):
            self.assertEqual(guard_interpreter(), 'local-python')

    async def test_failed_emergency_wake_can_be_retried_with_same_token(self):
        process = AsyncMock()
        process.returncode = None
        process.stdout.readline.return_value = b'READY\n'
        process.stdin.write = lambda data: None
        process.stdin.close = lambda: None
        guard = DisplayWakeGuard()
        with patch('display_wake_guard.asyncio.create_subprocess_exec', return_value=process), patch.object(guard, '_recover', side_effect=[RuntimeError('disconnected'), None]) as restore:
            token = await guard.start()
            process.returncode = -9
            process.wait.return_value = -9
            with self.assertRaises(RuntimeError):
                await guard.stop(token)
            self.assertTrue(await guard.stop(token))
            self.assertEqual(restore.call_count, 2)

    async def test_old_token_cannot_release_new_session(self):
        process = AsyncMock()
        process.returncode = None
        process.stdout.readline.return_value = b'READY\n'
        process.stdin.write = lambda data: None
        process.stdin.close = lambda: None
        process.wait.return_value = 0
        guard = DisplayWakeGuard()
        with patch('display_wake_guard.asyncio.create_subprocess_exec', return_value=process):
            token = await guard.start()
            self.assertFalse(await guard.stop('old'))
            self.assertTrue(await guard.heartbeat(token))
            self.assertTrue(await guard.stop(token))
            self.assertFalse(await guard.heartbeat(token))

    async def test_restarting_active_guard_replaces_token_before_late_cleanup(self):
        processes = []
        for _ in range(2):
            process = AsyncMock()
            process.returncode = None
            process.stdout.readline.return_value = b'READY\n'
            process.stdin.write = unittest.mock.Mock()
            process.stdin.close = unittest.mock.Mock()
            process.wait.return_value = 0
            processes.append(process)
        guard = DisplayWakeGuard()
        with patch('display_wake_guard.asyncio.create_subprocess_exec', side_effect=processes):
            old_token = await guard.start()
            new_token = await guard.start()
            self.assertNotEqual(old_token, new_token)
            processes[0].stdin.write.assert_called_once_with(b'wake\n')
            self.assertFalse(await guard.stop(old_token))
            self.assertFalse(await guard.heartbeat(old_token))
            processes[1].stdin.write.assert_not_called()
            self.assertTrue(await guard.heartbeat(new_token))
            self.assertTrue(await guard.stop(new_token))

    async def test_failed_replacement_wake_preserves_old_ownership_for_retry(self):
        old = AsyncMock()
        old.returncode = None
        old.stdout.readline.return_value = b'READY\n'
        old.stdin.write = lambda data: None
        old.stdin.close = lambda: None
        old.wait.return_value = -9
        new = AsyncMock()
        new.returncode = None
        new.stdout.readline.return_value = b'READY\n'
        new.stdin.write = lambda data: None
        new.stdin.close = lambda: None
        new.wait.return_value = 0
        guard = DisplayWakeGuard()
        with patch('display_wake_guard.asyncio.create_subprocess_exec', side_effect=[old, new]) as spawn, patch.object(guard, '_recover', side_effect=[RuntimeError('wake failed'), None]):
            old_token = await guard.start()
            old.returncode = -9
            with self.assertRaises(RuntimeError):
                await guard.start()
            self.assertEqual(spawn.call_count, 1)
            new_token = await guard.start()
            self.assertNotEqual(old_token, new_token)
            self.assertFalse(await guard.stop(old_token))
            self.assertTrue(await guard.stop(new_token))

    async def test_dead_guard_restores_only_owned_session(self):
        process = AsyncMock()
        process.returncode = None
        process.stdout.readline.return_value = b'READY\n'
        process.stdin.write = lambda data: None
        process.stdin.close = lambda: None
        guard = DisplayWakeGuard()
        with patch('display_wake_guard.asyncio.create_subprocess_exec', return_value=process), patch.object(guard, '_recover') as restore:
            token = await guard.start()
            process.returncode = -9
            self.assertFalse(await guard.heartbeat(token))
            restore.assert_called_once()
            await guard.close()
            restore.assert_called_once()

    async def test_standalone_eof_restores_without_sleeping(self):
        reader = asyncio.StreamReader()
        reader.feed_eof()
        display = unittest.mock.Mock()
        await run_guard(reader, display, ready=lambda: None)
        display.wake_internal.assert_called_once()
        display.close.assert_called_once()

    async def test_standalone_expired_lease_restores(self):
        reader = asyncio.StreamReader()
        display = unittest.mock.Mock()
        await run_guard(reader, display, lease_seconds=0.001, ready=lambda: None)
        display.wake_internal.assert_called_once()

    async def test_standalone_cancellation_restores_once(self):
        reader = asyncio.StreamReader()
        display = unittest.mock.Mock()
        ready = asyncio.Event()
        task = asyncio.create_task(run_guard(reader, display, ready=ready.set))
        await ready.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        display.wake_internal.assert_called_once()
        display.close.assert_called_once()

    async def test_failed_start_never_claims_a_lease(self):
        process = AsyncMock()
        process.returncode = 1
        process.stdout.readline.return_value = b''
        process.stdin.close = lambda: None
        process.wait.return_value = 1
        guard = DisplayWakeGuard()
        with patch('display_wake_guard.asyncio.create_subprocess_exec', return_value=process), patch('display_wake_guard.restore_display') as restore:
            with self.assertRaises(RuntimeError):
                await guard.start()
            await guard.close()
            restore.assert_not_called()


if __name__ == '__main__':
    unittest.main()
