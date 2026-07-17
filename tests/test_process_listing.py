import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ProcessListingTests(unittest.TestCase):
    def setUp(self):
        source = (ROOT / "main.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        namespace = {"os": __import__("os"), "shlex": __import__("shlex")}
        functions = [
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name in {
                "normalize_process_name",
                "split_process_args",
                "display_process_name",
                "parse_process_listing_line",
                "is_decky_music_name",
                "get_decky_music_rule",
            }
        ]
        exec(compile(ast.Module(body=functions, type_ignores=[]), "main.py", "exec"), namespace)
        self.parse_line = namespace["parse_process_listing_line"]
        self.is_decky_music_name = namespace["is_decky_music_name"]
        self.get_decky_music_rule = namespace["get_decky_music_rule"]

    def test_preserves_a_process_name_containing_spaces(self):
        line = f"{'deck':<16}{'Decky Music':<32}Decky Music (/home/deck/homebrew/plugins/Decky Music/main.py)"

        self.assertEqual(
            self.parse_line(line),
            ("Decky Music", "deck", "Decky Music (/home/deck/homebrew/plugins/Decky Music/main.py)"),
        )

    def test_keeps_the_existing_decky_music_rule_name_while_recognizing_it(self):
        self.assertTrue(self.is_decky_music_name("DeckyMusic"))
        self.assertTrue(self.is_decky_music_name("Decky Music"))
        self.assertFalse(self.is_decky_music_name("music"))
        self.assertEqual(
            self.get_decky_music_rule(["chrome", "Decky Music", "wiliwili"]),
            "Decky Music",
        )
