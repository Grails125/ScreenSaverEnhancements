import ast, asyncio
from pathlib import Path
from types import SimpleNamespace as NS
import unittest
import time
from unittest.mock import AsyncMock, Mock
from contextlib import asynccontextmanager

ROOT=Path(__file__).resolve().parents[1]

def plugin_logic(namespace):
    tree=ast.parse((ROOT/'main.py').read_text(encoding='utf-8'))
    plugin=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Plugin')
    names={'_unload','stop_backend','_stop_backend_locked','_backend_operation_lock'}
    body=[n for n in plugin.body if isinstance(n,ast.AsyncFunctionDef) and n.name in names]
    helper=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_stop_loader_ipc_listener']
    namespace['asynccontextmanager'] = asynccontextmanager
    exec(compile(ast.fix_missing_locations(ast.Module(body=helper+[ast.ClassDef(name='Plugin',bases=[],keywords=[],body=body,decorator_list=[])],type_ignores=[])),'plugin-lifecycle','exec'),namespace)
    cls = namespace['Plugin']
    async def stop_nested(instance):
        callback = namespace.get('stop_nested_media_watch')
        if callback:
            await callback(instance)
    cls._stop_nested_media_watch = stop_nested
    return cls

class PluginUnloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_unload_gracefully_stops_only_its_loader_ipc_listener_before_eof_busy_loop(self):
        # Exact Decky 3.2.9 listener/read functions, with a finite assertion guard
        # to fail rather than freeze the test process if compatibility is absent.
        class UnixSocket:
            def __init__(self, owner, reader):
                self.active=True; self.on_new_message=owner.on_new_message; self.reader=reader
                self.empty_reads=0
            async def _read_single_line(self, reader):
                try:
                    return (await reader.readuntil()).decode()
                except asyncio.IncompleteReadError as error:
                    return error.partial.decode()
            async def _listen_for_method_call(self, reader, writer):
                while self.active and self.on_new_message:
                    line=await self._read_single_line(reader)
                    if not line:
                        self.empty_reads+=1
                        if self.empty_reads>100:
                            raise RuntimeError('Decky EOF listener starved the event loop')
                    asyncio.create_task(self.on_new_message(line))
        UnixSocket.__module__='decky_loader.localplatform.localsocket'
        UnixSocket._listen_for_method_call.__qualname__='UnixSocket._listen_for_method_call'
        ns={'asyncio':asyncio,'UNLOAD_TIMEOUT':0.05,'decky':NS(logger=NS(info=lambda *a:None,warning=lambda *a:None))}
        Plugin=plugin_logic(ns)
        Plugin._init_runtime_state=lambda instance:None
        async def cleanup(*args,**kwargs):
            await asyncio.sleep(0)
        Plugin.stop_backend=cleanup
        plugin=Plugin();plugin.display_wake_guard=NS(close=cleanup)
        class Runner:
            def __init__(self, value):self.Plugin=value
            async def on_new_message(self,line):pass
        reader=asyncio.StreamReader();other_reader=asyncio.StreamReader();unknown_reader=asyncio.StreamReader()
        class UnknownSocket(UnixSocket):
            pass
        UnknownSocket.__module__='other_loader.socket'
        own=UnixSocket(Runner(plugin),reader)
        other=UnixSocket(Runner(object()),other_reader)
        unknown=UnknownSocket(Runner(plugin),unknown_reader)
        own_task=asyncio.create_task(own._listen_for_method_call(reader,None))
        other_task=asyncio.create_task(other._listen_for_method_call(other_reader,None))
        unknown_task=asyncio.create_task(unknown._listen_for_method_call(unknown_reader,None))
        await asyncio.sleep(0)
        reader.feed_eof()
        await plugin._unload()
        self.assertTrue(own_task.done())
        self.assertFalse(own_task.cancelled())
        self.assertIsNone(own_task.exception())
        self.assertLessEqual(own.empty_reads,1)
        self.assertFalse(other_task.done())
        self.assertFalse(unknown_task.done())
        self.assertFalse(asyncio.current_task().cancelling())
        other_task.cancel()
        unknown_task.cancel()
        with self.assertRaises(asyncio.CancelledError):await other_task
        with self.assertRaises(asyncio.CancelledError):await unknown_task

    async def test_unloading_gates_all_emit_entries_and_does_not_join_old_ipc(self):
        release = asyncio.Event()
        async def old_ipc():
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()
        old_task = asyncio.create_task(old_ipc())
        await asyncio.sleep(0)
        slot = NS(task=old_task, schedule=Mock())
        emit = AsyncMock()
        namespace={'asyncio':asyncio,'unloading':True,'inhibit_state_changed_task':slot,
                   'decky':NS(emit=emit,logger=NS(warning=Mock())),
                   'record_diagnostic_event':Mock()}
        tree=ast.parse((ROOT/'main.py').read_text(encoding='utf-8'))
        names={'emit_inhibit_state_changed','schedule_inhibit_state_changed','cancel_inhibit_state_changed_task'}
        nodes=[node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)) and node.name in names]
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'plugin-emit', 'exec'),namespace)
        try:
            namespace['schedule_inhibit_state_changed']()
            await namespace['emit_inhibit_state_changed']()
            await asyncio.wait_for(namespace['cancel_inhibit_state_changed_task'](wait=False),0.1)
            slot.schedule.assert_not_called()
            emit.assert_not_called()
            self.assertIsNone(slot.task)
        finally:
            release.set()
            await old_task

    async def test_unload_deadline_does_not_wait_for_cancel_resistant_ipc_cleanup(self):
        release = asyncio.Event()
        ns={'asyncio':asyncio,'UNLOAD_TIMEOUT':0.03,'decky':NS(logger=NS(info=lambda *a:None,warning=lambda *a:None))}
        Plugin=plugin_logic(ns)
        Plugin._init_runtime_state=lambda instance:None
        async def blocked(*args,**kwargs):
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()
        async def guard_close():
            pass
        Plugin.stop_backend=blocked
        plugin=Plugin();plugin.display_wake_guard=NS(close=guard_close)
        timer = asyncio.get_running_loop().call_later(0.25, release.set)
        started = time.monotonic()
        try:
            await plugin._unload()
            self.assertLess(time.monotonic() - started, 0.15)
        finally:
            release.set()
            timer.cancel()

    async def test_normal_stop_still_pushes_state_after_releasing_resources(self):
        released=[]
        async def stop_nested(instance):released.append('nested')
        async def stop_watch(instance):released.append('watch')
        async def stop_bus():released.append('bus')
        async def cancel_emit(wait=True):released.append('cancel')
        async def emit():released.append('emit')
        ns={'asyncio':asyncio,'decky':NS(logger=NS(info=lambda *a:None)),
            'stop_dbus':stop_bus,'clear_dbus_requests':lambda:released.append('requests'),
            'cancel_inhibit_state_changed_task':cancel_emit,'emit_inhibit_state_changed':emit,
            'record_diagnostic_event':lambda *a:None,'stop_nested_media_watch':stop_nested}
        Plugin=plugin_logic(ns)
        Plugin._stop_manual_watch=stop_watch
        self.assertTrue(await Plugin().stop_backend())
        self.assertEqual(released,['nested','watch','bus','requests','cancel','emit'])

    async def test_unload_does_not_wait_for_frontend_emit_after_loader_listener_stops(self):
        released=[]
        async def stop_watch(instance):released.append('watch')
        async def stop_bus():released.append('bus')
        async def cancel_emit(wait=True):released.append('cancel')
        async def blocked_emit():await asyncio.Event().wait()
        async def guard_close():released.append('guard')
        ns={'asyncio':asyncio,'UNLOAD_TIMEOUT':0.1,'decky':NS(logger=NS(info=lambda *a:None,warning=lambda *a:None)),
            'stop_dbus':stop_bus,'clear_dbus_requests':lambda:released.append('requests'),
            'cancel_inhibit_state_changed_task':cancel_emit,'emit_inhibit_state_changed':blocked_emit,
            'record_diagnostic_event':lambda *a:None}
        Plugin=plugin_logic(ns)
        Plugin._init_runtime_state=lambda instance:None
        Plugin._stop_manual_watch=stop_watch
        plugin=Plugin();plugin.display_wake_guard=NS(close=guard_close)
        await asyncio.wait_for(plugin._unload(),0.25)
        self.assertEqual(set(released),{'guard','watch','bus','requests','cancel'})

    async def test_unload_total_deadline_includes_both_parallel_cleanup_paths(self):
        ns={'asyncio':asyncio,'UNLOAD_TIMEOUT':0.03,'decky':NS(logger=NS(info=lambda *a:None,warning=lambda *a:None))}
        Plugin=plugin_logic(ns)
        Plugin._init_runtime_state=lambda instance:None
        async def blocked(*args,**kwargs):await asyncio.Event().wait()
        Plugin.stop_backend=blocked
        plugin=Plugin();plugin.display_wake_guard=NS(close=blocked)
        await asyncio.wait_for(plugin._unload(),0.15)

if __name__=='__main__':unittest.main()
