"""Independent, renewable recovery lease; never turns a display off."""

import asyncio
import os
import secrets
import signal
import subprocess
import sys
import time
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path


def guard_interpreter():
    # Decky's bundled PluginLoader is not a general-purpose Python executable.
    return '/usr/bin/python3' if os.access('/usr/bin/python3', os.X_OK) else sys.executable


def restore_display():
    from gamescope_display import GamescopeDisplay
    display = GamescopeDisplay.connect()
    try:
        display.wake_internal()
    finally:
        display.close()


LEASE_FILE = '/run/user/1000/screensaver-enhancements-display-wake.lease'


@contextmanager
def display_lease(token, claim=False, path=LEASE_FILE, wait_timeout=None):
    # The lock covers the complete physical wake. A replacement cannot become
    # READY while a predecessor is still restoring its display.
    import fcntl
    with open(path, 'a+', encoding='utf-8') as lease:
        if wait_timeout is None:
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX)
        else:
            deadline = time.monotonic() + wait_timeout
            while True:
                try:
                    fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Display recovery lease is still owned')
                    time.sleep(min(0.025, max(0, deadline - time.monotonic())))
        lease.seek(0)
        current = lease.read()
        if claim:
            lease.seek(0)
            lease.truncate()
            lease.write(token)
            lease.flush()
            current = token
        try:
            yield current == token
        finally:
            fcntl.flock(lease.fileno(), fcntl.LOCK_UN)


def recover_owned_display(token, path=LEASE_FILE, wait_timeout=5.0):
    # Most delayed helpers can exit without waiting behind a newer active guard.
    # The bounded nonblocking lock also covers a claim racing this first read.
    try:
        with open(path, encoding='utf-8') as lease:
            if lease.read() != token:
                return
    except FileNotFoundError:
        return  # A startup cancelled before claiming never owned an off display.
    try:
        with display_lease(token, path=path, wait_timeout=wait_timeout) as owned:
            if owned:
                restore_display()
    except TimeoutError:
        return


def claim_connected_display(token, path=LEASE_FILE):
    # Called only while display_lease holds the lock and after connecting.
    # A failed connection must leave the predecessor's recovery token valid.
    with open(path, 'r+', encoding='utf-8') as lease:
        lease.write(token)
        lease.truncate()
        lease.flush()


def launch_recovery(token):
    # This helper survives the Loader killing its parent and owns no threads in
    # that parent. Its lease check fences it against later display sessions.
    return subprocess.Popen(
        [guard_interpreter(), str(Path(__file__).resolve()), '--recover', token],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)


class DisplayWakeGuard:
    START_TIMEOUT = 5.0
    STOP_TIMEOUT = 5.0
    CLOSE_TIMEOUT = 2.0

    def __init__(self):
        self._lock = asyncio.Lock()
        self._process = None
        self._token = None
        self._launch_token = None
        self._closing = False
        self._operation = None
        self._children = set()

    @asynccontextmanager
    async def _operation_lock(self):
        async with self._lock:
            if self._closing:
                raise RuntimeError('Display recovery guard is closing')
            self._operation = asyncio.current_task()
            try:
                yield
            finally:
                self._operation = None

    async def start(self):
        async with self._operation_lock():
            if self._token is not None:
                # Each activation owns a distinct lease. A delayed cleanup from a
                # previous frontend must never wake the newly activated display.
                await self._stop_locked()
            self._launch_token = secrets.token_urlsafe(24)
            process = await asyncio.create_subprocess_exec(
                guard_interpreter(), str(Path(__file__).resolve()), '--guard', self._launch_token,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL)
            self._process = process
            self._children.add(process)
            try:
                ready = await asyncio.wait_for(process.stdout.readline(), self.START_TIMEOUT)
                if ready != b'READY\n' or process.returncode is not None:
                    raise RuntimeError('Display recovery guard did not become ready')
            except BaseException:
                # It has not been authorized to own a sleeping display yet.
                self._process = None
                process.stdin.close()
                await self._reap(process)
                raise
            self._token = self._launch_token
            self._launch_token = None
            return self._token

    async def heartbeat(self, token):
        async with self._operation_lock():
            if token != self._token or self._token is None:
                return False
            if self._process is None or self._process.returncode is not None:
                await self._stop_locked()
                return False
            try:
                self._process.stdin.write(b'ping\n')
                await asyncio.wait_for(self._process.stdin.drain(), self.STOP_TIMEOUT)
                return True
            except (BrokenPipeError, ConnectionError, asyncio.TimeoutError):
                await self._stop_locked()
                return False

    async def stop(self, token):
        async with self._operation_lock():
            if token != self._token or self._token is None:
                return False
            await self._stop_locked()
            return True

    async def close(self):
        self._closing = True
        if self._operation is not None:
            self._operation.cancel()
        token = self._token or self._launch_token
        async def finish():
            async with self._lock:
                await self._stop_locked()
                # A cancelled start/stop can leave a child outside _process.
                # Its EOF wake still needs to finish within this same budget.
                for process in tuple(self._children):
                    await self._reap(process)
        try:
            await asyncio.wait_for(finish(), self.CLOSE_TIMEOUT)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            for process in self._children:
                if process.returncode is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
            if token is not None:
                launch_recovery(token)
            self._process = None
            self._token = None

    async def _recover(self, token):
        process = launch_recovery(token)
        deadline = asyncio.get_running_loop().time() + self.STOP_TIMEOUT
        while process.poll() is None:
            if asyncio.get_running_loop().time() >= deadline:
                raise RuntimeError('Independent display recovery did not finish')
            await asyncio.sleep(0.025)
        if process.returncode != 0:
            raise RuntimeError('Independent display recovery failed')

    async def _reap(self, process):
        try:
            result = await asyncio.wait_for(process.wait(), self.STOP_TIMEOUT)
        except asyncio.TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            result = await asyncio.wait_for(process.wait(), self.STOP_TIMEOUT)
        self._children.discard(process)
        return result

    async def _stop_locked(self):
        process, owned = self._process, self._token is not None
        if not owned:
            return
        if process is None:
            await self._recover(self._token)
            self._token = None
            return
        failed = True
        cancelled = False
        try:
            if process.returncode is None:
                process.stdin.write(b'wake\n')
                await asyncio.wait_for(process.stdin.drain(), self.STOP_TIMEOUT)
            process.stdin.close()
            failed = await self._reap(process) != 0
        except (BrokenPipeError, ConnectionError, asyncio.TimeoutError):
            failed = True
            process.stdin.close()
            await self._reap(process)
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            process.stdin.close()
            self._process = None
            if owned and failed:
                if self._closing:
                    if not cancelled:
                        launch_recovery(self._token)
                else:
                    await self._recover(self._token)
            # Keep ownership if emergency restoration raised, so stop can retry.
            self._token = None


async def run_guard(reader, display, lease_seconds=30.0, ready=None):
    try:
        (ready or (lambda: print('READY', flush=True)))()
        while True:
            try:
                line = await asyncio.wait_for(reader.readline(), lease_seconds)
            except asyncio.TimeoutError:
                break
            if line != b'ping\n':
                break
    finally:
        try:
            await asyncio.to_thread(display.wake_internal)
        finally:
            display.close()


async def _standalone(token):
    from gamescope_display import GamescopeDisplay
    display = await asyncio.to_thread(GamescopeDisplay.connect)
    reader = asyncio.StreamReader()
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    delegated = False
    try:
        claim_connected_display(token)
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            loop.add_signal_handler(sig, task.cancel)
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
        delegated = True
        await run_guard(reader, display)
    except asyncio.CancelledError:
        pass
    finally:
        if not delegated:
            try:
                await asyncio.to_thread(display.wake_internal)
            finally:
                display.close()


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('--guard', '--recover'):
        raise SystemExit('Usage: display_wake_guard.py --guard|--recover TOKEN')
    if sys.argv[1] == '--recover':
        recover_owned_display(sys.argv[2])
    else:
        with display_lease(sys.argv[2]):
            asyncio.run(_standalone(sys.argv[2]))
