import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../src/deckyApi.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

const loadDeckyApi = (callable, eventApi = {}, loaderCall, pluginManifest = manifest) => {
  const module = { exports: {} };
  const deckyApiModule = {
    callable,
    addEventListener: eventApi.addEventListener ?? ((_event, listener) => listener),
    removeEventListener: eventApi.removeEventListener ?? (() => {}),
    routerHook: { addGlobalComponent() {}, removeGlobalComponent() {} },
    toaster: { toast() {} },
  };

  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require(id) {
      if (id === "@decky/api") return deckyApiModule;
      if (id === "@decky/manifest") return pluginManifest;
      throw new Error(`Unexpected import: ${id}`);
    },
    window: {
      LocalizationManager: { m_rgLocalesToUse: [eventApi.locale ?? "en"] },
      DeckyBackend: {
        call: loaderCall ?? (async () => undefined),
      },
    },
  });

  return module.exports;
};

test("exposes typed RPC methods with positional callable arguments", async () => {
  const calls = [];
  const loaderCalls = [];
  const { createPluginServerApi } = loadDeckyApi(
    (route) => async (...args) => {
      calls.push({ route, args });
      return { active: true };
    },
    {},
    async (route, ...args) => {
      loaderCalls.push({ route, args });
    },
  );
  const serverApi = createPluginServerApi();

  const response = await serverApi.getPowerOverrideState();
  await serverApi.getSetting("manual_apps", []);
  await serverApi.beginPowerOverride({
    batteryDim: 60,
    acDim: 120,
    batterySuspend: 300,
    acSuspend: 600,
  });
  await serverApi.getPluginVersion();
  await serverApi.checkUpdate();
  await serverApi.installPluginUpdate({
    downloadUrl: "https://github.com/Grails125/ScreenSaverEnhancements/releases/download/v1.5.0/ScreenSaverEnhancements.zip",
    version: "1.5.0",
    sha256: "abc123",
  });
  await serverApi.startDisplayWakeGuard();
  await serverApi.heartbeatDisplayWakeGuard('lease');
  await serverApi.stopDisplayWakeGuard('lease');

  assert.deepEqual(calls, [
    { route: "get_power_override_state", args: [] },
    { route: "get_settings", args: ["manual_apps", []] },
    {
      route: "begin_power_override",
      args: [{ batteryDim: 60, acDim: 120, batterySuspend: 300, acSuspend: 600 }],
    },
    { route: "get_plugin_version", args: [] },
    { route: "check_update", args: [] },
    { route: 'start_display_wake_guard', args: [] },
    { route: 'heartbeat_display_wake_guard', args: ['lease'] },
    { route: 'stop_display_wake_guard', args: ['lease'] },
  ]);
  assert.deepEqual(loaderCalls, [
    {
      route: "utilities/install_plugin",
      args: [
        "https://github.com/Grails125/ScreenSaverEnhancements/releases/download/v1.5.0/ScreenSaverEnhancements.zip",
        manifest.name,
        "1.5.0",
        "abc123",
        2,
      ],
    },
  ]);
  assert.equal(response.active, true);
});

test("installer identity matches the packaged manifest independently of Steam language", async () => {
  for (const locale of ["en", "zh-cn", "uk"]) {
    const { createPluginServerApi } = loadDeckyApi(() => async () => undefined, { locale },
      async (route, url, name, version, hash, installType) => {
        assert.equal(route, "utilities/install_plugin");
        assert.equal(url, "https://example.test/plugin.zip");
        assert.equal(version, "2.0.4");
        assert.equal(hash, "verified-hash");
        assert.equal(installType, 2);
        // This checks the folder lookup identity, not the install lifecycle.
        // build.py copies this plugin.json into the ZIP without translation.
        const extractedFolders = new Map([[manifest.name, "plugin-folder"]]);
        assert.ok(extractedFolders.get(name), "installer cannot find the extracted plugin by a slug or translated title");
      });
    await createPluginServerApi().installPluginUpdate({
      downloadUrl: "https://example.test/plugin.zip", version: "2.0.4", sha256: "verified-hash",
    });
  }
});

test("installer uses the supplied manifest identity instead of a hardcoded display name", async () => {
  const calls = [];
  const pluginManifest = { ...manifest, name: "Manifest identity fixture" };
  const { createPluginServerApi } = loadDeckyApi(() => async () => undefined, {},
    async (_route, ...args) => { calls.push(args); }, pluginManifest);
  await createPluginServerApi().installPluginUpdate({ downloadUrl: "artifact", version: "2.0.4", sha256: "hash" });
  assert.equal(calls[0][1], pluginManifest.name);
});

test("passes power recovery revisions without changing the legacy positional contract", async () => {
  const calls = [];
  const { createPluginServerApi } = loadDeckyApi(route => async (...args) => {
    calls.push({ route, args });
    return true;
  });
  const api = createPluginServerApi();
  const snapshot = { batteryDim: 300, acDim: 300, batterySuspend: 600, acSuspend: 600 };
  await api.beginPowerOverride(snapshot, 'next-revision', 'previous-revision');
  await api.endPowerOverride('next-revision', 'inactive-revision');
  await api.beginPowerOverride(snapshot, 'first-revision', null);
  await api.endPowerOverride();
  assert.deepEqual(calls, [
    { route: 'begin_power_override', args: [snapshot, 'next-revision', 'previous-revision'] },
    { route: 'end_power_override', args: ['next-revision', 'inactive-revision'] },
    { route: 'begin_power_override', args: [snapshot, 'first-revision', null] },
    { route: 'end_power_override', args: [] },
  ]);
});

test("does not expose the obsolete frontend DeckyMusic playback RPC", () => {
  assert.doesNotMatch(source, /record_decky_music_playback_state/);
  assert.doesNotMatch(source, /recordDeckyMusicPlaybackState/);
});

test('profile persistence carries the current revision and its atomic replacement', async () => {
  const calls = [];
  const { createPluginServerApi } = loadDeckyApi(route => async (...args) => { calls.push({ route, args }); return true; });
  const api = createPluginServerApi();
  const profile = { batteryDim: 300, acDim: 180, batterySuspend: 600, acSuspend: 600 };
  assert.equal(await api.savePowerSettings(profile, 'saved-revision', 'previous-revision'), true);
  assert.deepEqual(calls, [{ route: 'save_power_settings', args: [profile, 'saved-revision', 'previous-revision'] }]);
});

test("propagates callable rejections to feature boundaries", async () => {
  const failure = new Error("backend unavailable");
  const { createPluginServerApi } = loadDeckyApi(
    () => async () => {
      throw failure;
    },
  );
  const serverApi = createPluginServerApi();

  await assert.rejects(serverApi.getDiagnostics(), failure);
});

test("subscribes to the narrow settings-changed event contract and cleans it up", () => {
  const registrations = [];
  const removals = [];
  const { createPluginServerApi } = loadDeckyApi(
    () => async () => undefined,
    {
      addEventListener(event, listener) {
        registrations.push({ event, listener });
        return listener;
      },
      removeEventListener(event, listener) {
        removals.push({ event, listener });
      },
    },
  );
  const serverApi = createPluginServerApi();
  const received = [];
  const unsubscribe = serverApi.subscribeSettingsChanged((key) => received.push(key));

  registrations[0].listener("unknown_setting");
  registrations[0].listener("manual_apps");
  unsubscribe();

  assert.equal(registrations[0].event, "settings_changed");
  assert.deepEqual(received, ["manual_apps"]);
  assert.equal(removals[0].event, "settings_changed");
  assert.equal(removals[0].listener, registrations[0].listener);
});

test("subscribes to payload-free inhibit state pushes and cleans them up", () => {
  const registrations = [];
  const removals = [];
  const { createPluginServerApi } = loadDeckyApi(
    () => async () => undefined,
    {
      addEventListener(event, listener) {
        registrations.push({ event, listener });
        return listener;
      },
      removeEventListener(event, listener) {
        removals.push({ event, listener });
      },
    },
  );
  const serverApi = createPluginServerApi();
  let changes = 0;
  const unsubscribe = serverApi.subscribeInhibitStateChanged(() => changes += 1);

  registrations[0].listener("ignored payload");
  unsubscribe();

  assert.equal(registrations[0].event, "inhibit_state_changed");
  assert.equal(changes, 1);
  assert.equal(removals[0].event, "inhibit_state_changed");
  assert.equal(removals[0].listener, registrations[0].listener);
});
