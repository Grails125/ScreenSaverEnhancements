"""Execute the real Plugin methods without importing Decky's host runtime."""
import ast
import copy
from pathlib import Path
import unittest

from power_settings import normalize_power_settings


NORMAL = {"batteryDim": 300, "acDim": 300, "batterySuspend": 600, "acSuspend": 600}


class MemorySettings:
    def __init__(self):
        self.values = {}
        self.writes = []

    def getSetting(self, key, default):
        return self.values.get(key, default)

    def setSettings(self, values):
        self.writes.append(("set", copy.deepcopy(values)))
        self.values.update(copy.deepcopy(values))
        return True

    def unsetSettings(self, keys):
        self.writes.append(("unset", tuple(keys)))
        for key in keys:
            self.values.pop(key, None)
        return True


def real_plugin(settings):
    source = ast.parse((Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8"))
    plugin = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == "Plugin")
    names = {"get_power_override_state", "begin_power_override", "end_power_override"}
    methods = [node for node in plugin.body if isinstance(node, ast.AsyncFunctionDef) and node.name in names]
    assert len(methods) == len(names)
    methods += [node for node in plugin.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "save_power_settings"]
    cls = ast.ClassDef(name="Plugin", bases=[], keywords=[], body=methods, decorator_list=[])
    namespace = {
        "settings": settings,
        "normalize_power_settings": normalize_power_settings,
        "POWER_OVERRIDE_ACTIVE": "power_override_active",
        "POWER_OVERRIDE_SNAPSHOT": "power_override_snapshot",
        "POWER_OVERRIDE_OWNER": "power_override_owner",
    }
    exec(compile(ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[])), "main.py", "exec"), namespace)
    return namespace["Plugin"]()


class PowerOverrideOwnershipTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.settings = MemorySettings()
        self.plugin = real_plugin(self.settings)

    async def test_owner_cas_prevents_a_late_old_end_from_deleting_a_new_snapshot(self):
        self.assertTrue(await self.plugin.begin_power_override(NORMAL, "old", None))
        desired = {**NORMAL, "batteryDim": 900}
        self.assertTrue(await self.plugin.begin_power_override(desired, "new", "old"))
        writes = len(self.settings.writes)
        self.assertFalse(await self.plugin.end_power_override("old"))
        self.assertEqual(len(self.settings.writes), writes)
        self.assertEqual(await self.plugin.get_power_override_state(), {"active": True, "snapshot": desired, "owner": "new"})
        self.assertTrue(await self.plugin.end_power_override("new", "inactive-next"))
        self.assertFalse((await self.plugin.get_power_override_state())["active"])
        self.assertEqual((await self.plugin.get_power_override_state())["owner"], "inactive-next")
        self.assertIsNone(self.settings.values.get("power_override_snapshot"))

    async def test_profile_save_rotates_revision_without_replacing_the_recovery_snapshot(self):
        self.assertTrue(await self.plugin.begin_power_override(NORMAL, "active", None))
        desired = {**NORMAL, "acDim": 180}
        self.assertTrue(await self.plugin.save_power_settings(desired, "saved", "active"))
        self.assertEqual(await self.plugin.get_power_override_state(), {"active": True, "snapshot": NORMAL, "owner": "saved"})
        self.assertEqual(self.settings.values["ac_dim_timeout"], 180)
        self.assertEqual(self.settings.values["battery_dim_timeout"], 300)

    async def test_late_profile_save_cannot_overwrite_a_replacement_or_a_rollback(self):
        self.assertTrue(await self.plugin.end_power_override(None, "before"))
        self.assertTrue(await self.plugin.end_power_override("before", "replacement"))
        writes = len(self.settings.writes)
        self.assertFalse(await self.plugin.save_power_settings({**NORMAL, "acDim": 180}, "old-saved", "before"))
        self.assertEqual(len(self.settings.writes), writes)
        self.assertTrue(await self.plugin.save_power_settings(NORMAL, "rolled-back", "replacement"))
        self.assertFalse(await self.plugin.save_power_settings({**NORMAL, "acDim": 180}, "late-saved", "replacement"))
        self.assertEqual(self.settings.values["ac_dim_timeout"], 300)
        self.assertEqual((await self.plugin.get_power_override_state())["owner"], "rolled-back")

    async def test_owned_profile_save_validates_a_complete_profile_and_a_fresh_revision(self):
        for owner in (None, "", "x" * 129, 42, []):
            self.assertFalse(await self.plugin.save_power_settings(NORMAL, owner, None))
        self.assertFalse(await self.plugin.save_power_settings({"batteryDim": 300}, "saved", None))
        self.assertTrue(await self.plugin.end_power_override(None, "existing"))
        writes = len(self.settings.writes)
        self.assertFalse(await self.plugin.save_power_settings(NORMAL, "existing", "existing"))
        self.assertEqual(len(self.settings.writes), writes)

    async def test_stale_begin_cannot_replace_a_new_owner_or_snapshot(self):
        self.assertTrue(await self.plugin.begin_power_override(NORMAL, "new", None))
        writes = len(self.settings.writes)
        self.assertFalse(await self.plugin.begin_power_override({**NORMAL, "batteryDim": 900}, "old", None))
        self.assertFalse(await self.plugin.begin_power_override(NORMAL, "old", "unrelated"))
        self.assertEqual(len(self.settings.writes), writes)
        self.assertEqual((await self.plugin.get_power_override_state())["owner"], "new")

    async def test_current_owner_can_edit_its_restore_profile(self):
        self.assertTrue(await self.plugin.begin_power_override(NORMAL, "same", None))
        desired = {**NORMAL, "acSuspend": 1200}
        self.assertFalse(await self.plugin.begin_power_override(desired, "same", "same"))
        self.assertTrue(await self.plugin.begin_power_override(desired, "same-revision-2", "same"))
        self.assertEqual((await self.plugin.get_power_override_state())["snapshot"], desired)
        self.assertFalse(await self.plugin.end_power_override("same"))
        self.assertEqual((await self.plugin.get_power_override_state())["owner"], "same-revision-2")

    async def test_existing_legacy_snapshot_can_be_claimed_without_losing_the_profile(self):
        self.assertTrue(await self.plugin.begin_power_override(NORMAL))
        self.assertIsNone((await self.plugin.get_power_override_state())["owner"])
        self.assertTrue(await self.plugin.begin_power_override(NORMAL, "new", None))
        self.assertFalse(await self.plugin.end_power_override())
        self.assertEqual((await self.plugin.get_power_override_state())["snapshot"], NORMAL)

    async def test_unowned_legacy_end_still_clears_an_unowned_override(self):
        self.assertTrue(await self.plugin.begin_power_override(NORMAL))
        self.assertTrue(await self.plugin.end_power_override())
        self.assertFalse((await self.plugin.get_power_override_state())["active"])

    async def test_invalid_owner_and_snapshot_never_write(self):
        for owner in ("", "x" * 129, 42, [], {}):
            self.assertFalse(await self.plugin.begin_power_override(NORMAL, owner, None))
        self.assertFalse(await self.plugin.begin_power_override({"batteryDim": 300}, "valid", None))
        self.assertEqual(self.settings.writes, [])
        self.assertTrue(await self.plugin.begin_power_override(NORMAL, "x" * 128, None))

    async def test_end_rotates_an_inactive_revision_and_blocks_a_delayed_first_begin(self):
        self.assertTrue(await self.plugin.end_power_override(None, "inactive-revision"))
        state = await self.plugin.get_power_override_state()
        self.assertEqual(state, {"active": False, "snapshot": None, "owner": "inactive-revision"})
        self.assertFalse(await self.plugin.begin_power_override(NORMAL, "old-delayed", None))
        self.assertTrue(await self.plugin.begin_power_override(NORMAL, "new-active", "inactive-revision"))
        self.assertTrue(await self.plugin.end_power_override("new-active", "next-inactive"))
        self.assertFalse(await self.plugin.end_power_override("new-active", "old-clear"))
        self.assertFalse(await self.plugin.begin_power_override(NORMAL, "old-write", "new-active"))
        self.assertEqual((await self.plugin.get_power_override_state())["owner"], "next-inactive")

    async def test_invalid_or_identical_next_revision_cannot_clear_owned_snapshot(self):
        self.assertTrue(await self.plugin.begin_power_override(NORMAL, "owner", None))
        writes = len(self.settings.writes)
        for next_owner in ("", "owner", "x" * 129, 42):
            self.assertFalse(await self.plugin.end_power_override("owner", next_owner))
        self.assertEqual(len(self.settings.writes), writes)
        self.assertTrue((await self.plugin.get_power_override_state())["active"])


if __name__ == "__main__":
    unittest.main()
