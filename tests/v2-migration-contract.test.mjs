import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const pluginJson = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
);

test("pins the Decky 3.2.6 compatible modern frontend toolchain", () => {
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.dependencies["@decky/api"], "1.1.3");
  assert.equal(packageJson.devDependencies["@decky/ui"], "4.11.6");
  assert.equal(packageJson.devDependencies["@decky/rollup"], "1.0.2");
  assert.match(packageJson.scripts["build:v2-probe"], /rollup\.v2-probe\.config\.js/);
  assert.equal(packageJson.scripts.build, "rollup -c");
  assert.equal(packageJson.dependencies["decky-frontend-lib"], undefined);
  assert.equal(pluginJson.api_version, 1);
});

test("the V2 probe uses typed callable RPC and reversible modern APIs", () => {
  const source = readFileSync(
    new URL("../src/v2Probe.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /callable<\[\], Diagnostics>/);
  assert.match(source, /routerHook\.addGlobalComponent/);
  assert.match(source, /routerHook\.removeGlobalComponent/);
  assert.match(source, /toaster\.toast/);
  assert.doesNotMatch(source, /ServerAPI|callPluginMethod|decky-frontend-lib/);
});

test("the V2 probe build delegates to the official Decky Rollup preset", () => {
  const source = readFileSync(
    new URL("../rollup.v2-probe.config.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /from ["']@decky\/rollup["']/);
  assert.match(source, /format:\s*["']esm["']/);
  assert.match(source, /build\/v2-probe/);
  assert.match(source, /entryFileNames:\s*["']index\.js["']/);
});

test("shared TypeScript options do not pin Rollup to an output directory", () => {
  const tsconfig = JSON.parse(
    readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8"),
  );

  assert.equal(tsconfig.compilerOptions.outDir, undefined);
  assert.equal(tsconfig.compilerOptions.suppressImplicitAnyIndexErrors, undefined);
  assert.match(packageJson.scripts.test, /tsc --noEmit/);
});

test("the V2 probe type-check is isolated from the legacy frontend", () => {
  const config = readFileSync(
    new URL("../rollup.v2-probe.config.js", import.meta.url),
    "utf8",
  );
  const probeTsconfig = JSON.parse(
    readFileSync(new URL("../tsconfig.v2-probe.json", import.meta.url), "utf8"),
  );

  assert.match(config, /tsconfig:\s*["']\.\/tsconfig\.v2-probe\.json["']/);
  assert.deepEqual(probeTsconfig.include, ["src/v2Probe.tsx"]);
  assert.equal(probeTsconfig.compilerOptions.jsx, "react-jsx");
});

test("the production build uses the official Decky ESM Rollup preset", () => {
  const source = readFileSync(
    new URL("../rollup.config.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /from ["']@decky\/rollup["']/);
  assert.doesNotMatch(source, /format:\s*["']iife["']|decky-frontend-lib/);
});

test("shared frontend modules no longer depend on decky-frontend-lib", () => {
  const sharedModules = [
    "../src/blackOverlay.tsx",
    "../src/settingsClient.ts",
    "../src/sleepManager.ts",
    "../src/uiComposition.ts",
  ];

  for (const modulePath of sharedModules) {
    const source = readFileSync(new URL(modulePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /decky-frontend-lib|ServerAPI/);
  }
});

test("Steam module lookups avoid deprecated Decky helpers", () => {
  const lookupModules = [
    "../src/sleepManager.ts",
    "../src/uiComposition.ts",
  ];

  for (const modulePath of lookupModules) {
    const source = readFileSync(new URL(modulePath, import.meta.url), "utf8");
    assert.match(source, /findModuleExport/);
    assert.doesNotMatch(source, /findModuleChild/);
  }
});

test("the full plugin entry uses the modern Decky UI shell", () => {
  const source = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /from ["']@decky\/ui["']/);
  assert.match(source, /from ["']@decky\/api["']/);
  assert.match(source, /definePlugin\(\(\) =>/);
  assert.doesNotMatch(source, /decky-frontend-lib|ServerAPI/);
});

test("settings and diagnostics use direct typed RPC results", () => {
  const settingsSource = readFileSync(
    new URL("../src/settingsClient.ts", import.meta.url),
    "utf8",
  );
  const pluginSource = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );

  assert.match(settingsSource, /serverApi\.getSetting/);
  assert.match(settingsSource, /serverApi\.setSetting/);
  assert.match(settingsSource, /serverApi\.setSettings/);
  assert.doesNotMatch(settingsSource, /callPluginMethod|\.success|\.result/);
  assert.match(pluginSource, /serverApi\.getDiagnostics/);
  assert.doesNotMatch(pluginSource, /callPluginMethod[^\n]*get_diagnostics/);
});

test("backend lifecycle uses direct typed RPC results", () => {
  const source = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /serverApi\.startBackend\(\)/);
  assert.match(source, /serverApi\.stopBackend\(\)/);
  assert.match(source, /serverApi\.isRunning\(\)/);
  assert.doesNotMatch(source, /callPluginMethod[^\n]*(start_backend|stop_backend|is_running)/);
});

test("process and inhibit status use direct typed RPC results", () => {
  const source = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /serverApi\.getRunningProcesses\(\)/);
  assert.match(source, /serverApi\.getInhibitStatus\(\)/);
  assert.doesNotMatch(source, /callPluginMethod[^\n]*(get_running_processes|get_inhibit_status)/);
});

test("power settings and recovery use direct typed RPC results", () => {
  const source = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /serverApi\.getSystemPowerSettings\(\)/);
  assert.match(source, /serverApi\.getPowerOverrideState\(\)/);
  assert.match(source, /serverApi\.beginPowerOverride\(snapshot\)/);
  assert.match(source, /serverApi\.endPowerOverride\(\)/);
  assert.doesNotMatch(source, /callPluginMethod[^\n]*(get_system_power_settings|get_power_override_state|begin_power_override|end_power_override)/);
});

test("event polling uses direct results and the legacy RPC adapter is removed", () => {
  const pluginSource = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );
  const apiSource = readFileSync(
    new URL("../src/deckyApi.ts", import.meta.url),
    "utf8",
  );

  assert.match(pluginSource, /serverApi\.waitForEvents\(25\)/);
  assert.doesNotMatch(pluginSource, /callPluginMethod|response\.success|response\.result/);
  assert.doesNotMatch(apiSource, /callPluginMethod|PluginMethodResponse|getPluginMethodArguments|PLUGIN_METHOD_ARGUMENT_KEYS/);
});

test("the monitoring toggle describes sleep inhibition behavior", () => {
  const zh = JSON.parse(
    readFileSync(new URL("../src/i18n/zh-cn.json", import.meta.url), "utf8"),
  );
  const en = JSON.parse(
    readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"),
  );

  assert.equal(zh["Background Monitor"], "息屏抑制监控");
  assert.equal(zh.plugin_switch_tip, "检测禁用息屏列表，接管系统息屏");
  assert.equal(zh["Background Monitor Failed"], "息屏抑制监控切换失败");
  assert.equal(en["Background Monitor"], "Sleep Inhibition Monitor");
});
