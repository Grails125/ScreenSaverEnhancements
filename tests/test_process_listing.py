import ast
import asyncio
import shlex
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch

import process_utils as utils

ROOT = Path(__file__).resolve().parents[1]
# Actual Deck C.UTF-8 ps rows: padding counts display cells, not Python characters.
DECK_ROWS = [
    'deck             系统主题                         系统主题 (/home/deck/homebrew/plugins/SDH-CssLoader/main.py)',
    'deck             屏幕保护增                       屏幕保护增强 (/home/deck/homebrew/plugins/ScreenSaverEnhancements/main.py)',
    'root             kworker/R-amdgpu-reset-dev       [kworker/R-amdgpu-reset-dev]',
]

class ProcessListingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.proc = Path(self.directory.name)

    def process(self, pid, comm, argv):
        folder = self.proc / str(pid)
        folder.mkdir()
        (folder/'comm').write_text(comm+'\n', encoding='utf8')
        (folder/'cmdline').write_bytes(b'\0'.join(arg.encode('utf8') for arg in argv)+(b'\0' if argv else b''))
        return {'pid':pid, 'comm':comm, 'args':shlex.join(argv), 'user':'deck'}

    def plugin(self, rules=(), old_rows=DECK_ROWS):
        source = ast.parse((ROOT/'main.py').read_text(encoding='utf8'))
        plugin = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name=='Plugin')
        names = {'get_running_processes', '_get_all_process_entries', '_get_all_process_lines', '_find_running_manual_app', '_process_matches_manual_rule'}
        methods = [node for node in plugin.body if isinstance(node,(ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
        helper = NS(get_process_entries=lambda:utils.get_process_entries(self.proc),
                    read_process_entry=lambda pid:utils.read_process_entry(pid,self.proc))
        cls = ast.ClassDef(name='Plugin',bases=[],keywords=[],decorator_list=[],body=methods)
        namespace = {**vars(utils), 'process_utils':helper, 'asyncio':asyncio, 'time':time,
                     'get_process_lines':lambda command:old_rows,
                     'settings':NS(getSetting=lambda *args:list(rules))}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[cls],type_ignores=[])), 'real-process-methods','exec'), namespace)
        state=namespace['Plugin']()
        state.process_scan_count=0
        state.active_manual_pids=set()
        return state

    async def test_actual_deck_chinese_rows_produce_clean_matchable_names(self):
        self.process(101,'系统主题',['系统主题 (/home/deck/homebrew/plugins/SDH-CssLoader/main.py)'])
        self.process(102,'屏幕保护增',['屏幕保护增强 (/home/deck/homebrew/plugins/ScreenSaverEnhancements/main.py)'])
        self.process(103,'kworker/R-amdgpu-reset-dev',[])
        plugin=self.plugin()
        with patch.object(utils,'_username_for_uid',return_value='deck',create=True):
            listed=await plugin.get_running_processes()
        self.assertEqual({row['name'] for row in listed},{'系统主题','屏幕保护增'})
        for name,pid in [('系统主题',101),('屏幕保护增',102)]:
            with patch.object(utils,'_username_for_uid',return_value='deck',create=True):
                self.assertEqual(await plugin._find_running_manual_app([name]),name)
            self.assertEqual(plugin.active_manual_pids,{pid})

    async def test_preserves_space_comm_and_argument_boundaries_in_list_scan_and_event_path(self):
        self.process(201,'my app',['/opt/my app','--open','/tmp/file with spaces'])
        plugin=self.plugin(['my app'],old_rows=['201 my app /opt/my app --open /tmp/file with spaces'])
        with patch.object(utils,'_username_for_uid',return_value='deck',create=True):
            self.assertEqual(await plugin._find_running_manual_app(['my app']),'my app')
        self.assertEqual(plugin.active_manual_pids,{201})
        self.assertTrue(plugin._process_matches_manual_rule(201))
        entry=utils.read_process_entry(201,self.proc)
        self.assertEqual(shlex.split(entry['args']),['/opt/my app','--open','/tmp/file with spaces'])

    async def test_full_quoted_executable_is_listed_and_matches_scan_and_event_rules(self):
        executable='/opt/my media player'
        self.process(202,'my media player',[executable,'/tmp/track with spaces.flac'])
        plugin=self.plugin(['my media player'],old_rows=['202 my media player /opt/my media player /tmp/track with spaces.flac'])
        with patch.object(utils,'_username_for_uid',return_value='deck',create=True):
            self.assertEqual(await plugin.get_running_processes(),[{'name':'my media player','type':'app'}])
            self.assertEqual(await plugin._find_running_manual_app(['my media player']),'my media player')
        self.assertTrue(plugin._process_matches_manual_rule(202))

    def test_kernel_thread_names_are_excluded_before_basename_normalization(self):
        self.assertEqual(utils.display_process_name('kworker/R-amdgpu-reset-dev','[kworker/R-amdgpu-reset-dev]'),'')
        self.process(301,'kworker/R-amdgpu-reset-dev',[])
        with patch.object(utils,'_username_for_uid',return_value='root',create=True):
            self.assertEqual(utils.get_process_entries(self.proc),[])

    def test_missing_or_exiting_processes_are_skipped(self):
        (self.proc/'401').mkdir()
        (self.proc/'not-a-pid').mkdir()
        self.assertIsNone(utils.read_process_entry(401,self.proc))
        self.assertIsNone(utils.read_process_entry(402,self.proc))
        self.assertEqual(utils.get_process_entries(self.proc),[])

    def test_uid_names_are_resolved_once_per_distinct_uid(self):
        self.process(501,'one',['one'])
        self.process(502,'two',['two'])
        with patch.object(utils,'_username_for_uid',return_value='deck',create=True) as lookup:
            entries=utils.get_process_entries(self.proc)
        self.assertEqual(len(entries),2)
        self.assertEqual(lookup.call_count,1)

    def test_preserves_empty_arguments_and_quoted_argument_text(self):
        argv=['/opt/a player', '', 'a "quoted" song', '']
        self.process(503,'a player',argv)
        self.assertEqual(shlex.split(utils.read_process_entry(503,self.proc)['args']),argv)

    def test_ascii_truncation_and_flatpak_names_preserve_existing_rules(self):
        self.assertEqual(utils.display_process_name('long-applicatio','/opt/long-application --flag'),'long-application')
        self.assertEqual(utils.display_process_name('flatpak','flatpak run --branch=stable org.example.Player'),'org.example.Player')

    def test_reads_chinese_process_names_without_fixed_width_column_parsing(self):
        with tempfile.TemporaryDirectory() as proc_root:
            process_dir = Path(proc_root) / "123"
            process_dir.mkdir()
            (process_dir / "comm").write_text("网易云音乐\n", encoding="utf-8")
            (process_dir / "cmdline").write_bytes("网易云音乐\0--background".encode("utf-8"))

            with patch.object(utils, '_username_for_uid', return_value='deck'):
                entries = utils.get_process_entries(proc_root)
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]['comm'], '网易云音乐')
            self.assertEqual(entries[0]['user'], 'deck')
            self.assertEqual(shlex.split(entries[0]['args']), ['网易云音乐', '--background'])

    def test_keeps_the_existing_decky_music_rule_name_while_recognizing_it(self):
        self.assertTrue(utils.is_decky_music_name('DeckyMusic'))
        self.assertTrue(utils.is_decky_music_name('Decky Music'))
        self.assertFalse(utils.is_decky_music_name('music'))
        self.assertEqual(utils.get_decky_music_rule(['chrome','Decky Music','wiliwili']),'Decky Music')
        self.assertEqual(utils.get_decky_music_rule_source('DeckyMusic'),'legacy_cdp')
        self.assertEqual(utils.get_decky_music_rule_source('Decky Music'),'mpris')

if __name__=='__main__': unittest.main()
