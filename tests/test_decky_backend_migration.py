import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class DeckyBackendMigrationTests(unittest.TestCase):
    def setUp(self):
        self.main_source = (ROOT / "main.py").read_text(encoding="utf-8")
        self.main_tree = ast.parse(self.main_source)

    def test_backend_uses_the_modern_decky_module_exclusively(self):
        imported_modules = {
            alias.name
            for node in ast.walk(self.main_tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        }

        self.assertIn("decky", imported_modules)
        self.assertNotIn("decky_plugin", imported_modules)
        self.assertNotIn("decky_plugin", self.main_source)

    def test_backend_uses_target_loader_logging_and_settings_contract(self):
        decky_attributes = {
            node.attr
            for node in ast.walk(self.main_tree)
            if isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "decky"
        }

        self.assertIn("logger", decky_attributes)
        self.assertIn("DECKY_PLUGIN_SETTINGS_DIR", decky_attributes)

    def test_build_packages_the_modern_decky_type_stub(self):
        build_source = (ROOT / "build.py").read_text(encoding="utf-8")

        self.assertTrue((ROOT / "decky.pyi").is_file())
        self.assertFalse((ROOT / "decky_plugin.pyi").exists())
        self.assertIn('"decky.pyi"', build_source)
        self.assertNotIn("decky_plugin.pyi", build_source)


if __name__ == "__main__":
    unittest.main()
