import ast
import asyncio
from pathlib import Path
import types
import unittest


ROOT = Path(__file__).resolve().parents[1]
PLAYER = {"service": "org.mpris.MediaPlayer2.chrome", "application": "Chrome"}
PLAYING = {"sources": [PLAYER], "unknown": set()}
PAUSED = {"sources": [], "unknown": set()}


class NestedPollingTests(unittest.IsolatedAsyncioTestCase):
    def load(self):
        tree = ast.parse((ROOT / "main.py").read_text(encoding="utf8"))
        plugin = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Plugin")
        names = {"_nested_media_watch_loop", "_merge_nested_media_results", "_set_nested_media_sources",
                 "_stop_nested_media_watch", "_start_nested_media_watch", "_process_event_loop", "_process_matches_manual_rule"}
        nodes = [n for n in tree.body if isinstance(n, ast.Assign)
                 and any(isinstance(t, ast.Name) and t.id.startswith("NESTED_MPRIS_") for t in n.targets)]
        nodes.extend(n for n in plugin.body if getattr(n, "name", "") in names)
        ns = dict(asyncio=asyncio, time=types.SimpleNamespace(time=lambda: self.now, monotonic=lambda: self.now),
                  decky=types.SimpleNamespace(logger=types.SimpleNamespace(info=lambda *a: None,
                      warning=lambda *a: None, error=lambda *a: None)), sync_inhibit_state=lambda *a, **kw: None)
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "main.py", "exec"), ns)
        ns["Plugin"] = types.SimpleNamespace(**{name: ns[name] for name in names}, _init_runtime_state=lambda self: None)
        return ns

    async def simulate(self, scans, replies=None, horizon=None):
        self.now = 0
        ns = self.load()
        runtime = types.SimpleNamespace(nested_media_scan_count=0, nested_media_last_scan_at=None,
            nested_media_last_bus_count=0, nested_media_sources=[], nested_media_active=False,
            nested_media_poll_interval_seconds=None, nested_media_status="checking",
            process_monitor_mode="fallback_scan", nested_media_wakeup=asyncio.Event())
        samples, sleeps = [], []
        scan_index = 0

        def discover():
            nonlocal scan_index
            value = scans[min(scan_index, len(scans) - 1)]
            scan_index += 1
            if isinstance(value, Exception):
                raise value
            return value

        async def query(address):
            value = (replies or [PAUSED])[min(scan_index - 1, len(replies or [PAUSED]) - 1)]
            if isinstance(value, Exception):
                raise value
            return value

        async def to_thread(fn):
            return fn()

        async def sleep(delay):
            samples.append((self.now, runtime.nested_media_active, runtime.nested_media_status))
            sleeps.append(delay)
            self.now += delay
            if (horizon is not None and self.now >= horizon) or (horizon is None and scan_index >= len(scans)):
                raise asyncio.CancelledError

        async def wait_for(awaitable, timeout):
            awaitable.close()
            await sleep(timeout)
            raise asyncio.TimeoutError

        ns.update(discover_nested_desktop_bus_addresses=discover, query_nested_mpris_sources=query,
                  asyncio=types.SimpleNamespace(to_thread=to_thread, gather=asyncio.gather,
                      sleep=sleep, wait_for=wait_for, TimeoutError=asyncio.TimeoutError, CancelledError=asyncio.CancelledError))
        with self.assertRaises(asyncio.CancelledError):
            await ns["_nested_media_watch_loop"](runtime)
        return runtime, samples, sleeps

    async def test_no_session_reduces_full_proc_scans_to_six_per_minute(self):
        runtime, samples, sleeps = await self.simulate([[]], horizon=60)
        self.assertEqual(runtime.nested_media_scan_count, 6)
        self.assertEqual([s[0] for s in samples], [0, 10, 20, 30, 40, 50])
        self.assertEqual(sleeps, [10] * 6)
        self.assertEqual(runtime.nested_media_status, "waiting")
        self.assertEqual(runtime.nested_media_poll_interval_seconds, 10)

    async def test_existing_session_checks_every_five_seconds_even_when_paused(self):
        _, samples, sleeps = await self.simulate([[], ["bus"], ["bus"], ["bus"], []],
                                                [PAUSED, PAUSED, PLAYING, PAUSED, PAUSED])
        self.assertEqual(sleeps, [10, 5, 5, 5, 10])
        self.assertEqual([s[1] for s in samples], [False, False, True, False, False])

    async def test_bus_failures_retry_fast_and_do_not_extend_grace(self):
        _, samples, sleeps = await self.simulate([["bus"]] * 7, [PLAYING] + [ConnectionError()] * 6)
        self.assertEqual(sleeps, [5] + [2] * 6)
        self.assertEqual([s[1] for s in samples], [True] * 4 + [False] * 3)
        self.assertEqual(samples[-1][2], "partial")

    async def test_discovery_failure_is_not_a_confirmed_missing_session(self):
        _, samples, sleeps = await self.simulate([["bus"]] + [OSError()] * 6,
                                                [PLAYING])
        self.assertEqual(sleeps, [5] + [2] * 6)
        self.assertTrue(samples[1][1])
        self.assertFalse(samples[-1][1])
        self.assertEqual(samples[-1][2], "error")

    async def test_unknown_player_retains_two_second_retry(self):
        _, samples, sleeps = await self.simulate([["bus"], ["bus"]],
            [PLAYING, {"sources": [], "unknown": {PLAYER["service"]}}])
        self.assertEqual(sleeps, [5, 2])
        self.assertEqual(samples[-1][1:], (True, "partial"))

    async def test_manual_stop_cancels_idle_wait_and_clears_current_status(self):
        self.now = 0
        ns = self.load()
        runtime = types.SimpleNamespace(nested_media_sources=[PLAYER], nested_media_confirmed={},
            nested_media_active=True, nested_media_last_bus_count=1,
            nested_media_poll_interval_seconds=10, nested_media_status="waiting")
        runtime.nested_media_watch_task = asyncio.create_task(asyncio.sleep(10))
        task = runtime.nested_media_watch_task
        await asyncio.wait_for(ns["_stop_nested_media_watch"](runtime), .2)
        self.assertTrue(task.cancelled())
        self.assertEqual(runtime.nested_media_sources, [])
        self.assertEqual(runtime.nested_media_status, "stopped")
        self.assertIsNone(runtime.nested_media_poll_interval_seconds)
        self.assertEqual(runtime.nested_media_last_bus_count, 0)

    async def test_event_mode_has_no_idle_timer_and_preserves_wakeup_during_discovery(self):
        self.now = 0
        ns = self.load()
        calls, waits = [], []
        wake = asyncio.Event()
        runtime = types.SimpleNamespace(nested_media_wakeup=wake, process_monitor_mode="proc_connector",
            process_event_source=types.SimpleNamespace(subscription_confirmed=True),
            nested_media_sources=[], nested_media_active=False, nested_media_scan_count=0)

        def discover():
            calls.append(True)
            if len(calls) == 1:
                # A Plasma exec arrives after its directory was passed by the scan.
                wake.set()
                return []
            return ["bus"]

        async def query(address):
            return PLAYING

        async def wait_for(awaitable, timeout):
            waits.append(timeout)
            if len(waits) == 1:
                self.assertEqual(runtime.nested_media_status, 'waiting_event')
                self.assertIsNone(timeout, 'idle event mode must not schedule any periodic scan')
                return await awaitable
            awaitable.close()
            raise asyncio.CancelledError

        ns.update(discover_nested_desktop_bus_addresses=discover, query_nested_mpris_sources=query,
            asyncio=types.SimpleNamespace(to_thread=asyncio.to_thread, gather=asyncio.gather,
                wait_for=wait_for, TimeoutError=asyncio.TimeoutError, CancelledError=asyncio.CancelledError))
        with self.assertRaises(asyncio.CancelledError):
            await ns['_nested_media_watch_loop'](runtime)
        self.assertEqual(waits, [None, 5])
        self.assertEqual(len(calls), 2)
        self.assertTrue(runtime.nested_media_active)

    async def test_plasma_exec_wakes_nested_without_a_manual_application_rule(self):
        self.now = 0
        ns = self.load()
        events = iter([(2, 99), (2, 100)])
        calls = []
        runtime = types.SimpleNamespace(active_manual_pids=set(), manual_watch_wakeup=asyncio.Event(),
            nested_media_wakeup=asyncio.Event(), process_monitor_mode='proc_connector')
        async def event():
            if runtime.nested_media_wakeup.is_set():
                raise asyncio.CancelledError
            return next(events)
        def read(pid):
            calls.append(pid)
            return {'comm': 'plasmashell' if pid == 100 else 'unrelated', 'args': ''}
        runtime.process_event_source = types.SimpleNamespace(wait_for_process_change=event, subscription_confirmed=True)
        ns.update(process_events=types.SimpleNamespace(PROC_EVENT_EXEC=2, PROC_EVENT_EXIT=8),
            process_utils=types.SimpleNamespace(read_process_entry=read),
            process_candidates=lambda *a: [], settings=types.SimpleNamespace(getSetting=lambda *a: []))
        with self.assertRaises(asyncio.CancelledError):
            await ns['_process_event_loop'](runtime)
        self.assertEqual(calls, [99, 100], 'read each exec once, never enumerate all processes')
        self.assertTrue(runtime.nested_media_wakeup.is_set())
        self.assertFalse(runtime.manual_watch_wakeup.is_set())

    async def test_listener_failure_wakes_idle_nested_to_enable_fallback(self):
        self.now = 0
        ns = self.load()
        closed = []
        async def fail():
            raise OSError('listener unavailable')
        runtime = types.SimpleNamespace(process_event_source=types.SimpleNamespace(wait_for_process_change=fail, subscription_confirmed=True,
            close=lambda: closed.append(True)),
            manual_watch_wakeup=asyncio.Event(), nested_media_wakeup=asyncio.Event(), process_monitor_mode='proc_connector')
        await ns['_process_event_loop'](runtime)
        self.assertTrue(runtime.nested_media_wakeup.is_set())
        self.assertEqual(runtime.process_monitor_mode, 'fallback_scan')
        self.assertEqual(closed, [True])
        self.assertIsNone(runtime.process_event_source)


if __name__ == "__main__":
    unittest.main()
