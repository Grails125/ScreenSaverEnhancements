import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const pluginJson = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
);
const packageLock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
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

test("Stage 4 release metadata advances from the installed 1.3.0 baseline", () => {
  const pnpmLock = readFileSync(
    new URL("../pnpm-lock.yaml", import.meta.url),
    "utf8",
  );
  const deckyStub = readFileSync(
    new URL("../decky.pyi", import.meta.url),
    "utf8",
  );

  assert.equal(packageJson.version, "1.4.0");
  assert.equal(packageLock.version, "1.4.0");
  assert.equal(packageLock.packages[""].version, "1.4.0");
  assert.match(pnpmLock, /'@decky\/api':/);
  assert.doesNotMatch(pnpmLock, /decky-frontend-lib:/);
  assert.match(deckyStub, /async def emit\(event: str, \*args: Any\) -> None:/);
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

test("event pushes replace polling and the legacy RPC adapter is removed", () => {
  const pluginSource = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );
  const apiSource = readFileSync(
    new URL("../src/deckyApi.ts", import.meta.url),
    "utf8",
  );

  assert.match(pluginSource, /serverApi\.subscribeInhibitStateChanged/);
  assert.doesNotMatch(pluginSource, /waitForEvents|listenForPowerEvents|processBackendEvents/);
  assert.doesNotMatch(apiSource, /wait_for_events|waitForEvents|PluginEvent/);
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

test("diagnostics use sleep inhibition terminology without misleading uptime", () => {
  const zh = JSON.parse(
    readFileSync(new URL("../src/i18n/zh-cn.json", import.meta.url), "utf8"),
  );
  const en = JSON.parse(
    readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"),
  );
  const source = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );
  const diagnosticsSource = readFileSync(
    new URL("../src/diagnostics.ts", import.meta.url),
    "utf8",
  );
  const backendSource = readFileSync(new URL("../main.py", import.meta.url), "utf8");

  assert.equal(zh["Backend Status"], "息屏抑制监控");
  assert.equal(en["Backend Status"], "Sleep Inhibition Monitor");
  assert.equal(zh.backend_started, "息屏抑制监控已启动");
  assert.equal(zh.backend_stopped, "息屏抑制监控已停止");
  assert.equal(en.backend_started, "Sleep inhibition monitor started");
  assert.equal(en.backend_stopped, "Sleep inhibition monitor stopped");
  assert.doesNotMatch(source, /t\(['"]Backend Uptime['"]\)/);
  assert.doesNotMatch(diagnosticsSource, /uptimeSeconds/);
  assert.doesNotMatch(backendSource, /"uptimeSeconds"/);
  assert.match(source, /formatDiagnosticEventType\(event\.type\)/);
});

test("monitor switching uses dedicated notifications instead of restore-sleep copy", () => {
  const zh = JSON.parse(
    readFileSync(new URL("../src/i18n/zh-cn.json", import.meta.url), "utf8"),
  );
  const en = JSON.parse(
    readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"),
  );
  const frontend = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(zh["Monitor Enabled Body"], "已开始检测禁用息屏列表并接管系统息屏");
  assert.equal(zh["Monitor Disabled Body"], "已停止检测禁用息屏列表，系统息屏已交还系统管理");
  assert.equal(zh.notify_tip, "监控开关或息屏状态变化时显示通知");
  assert.equal(en["Monitor Enabled Body"], "Monitoring the sleep-inhibition list and managing system sleep");
  assert.equal(en["Monitor Disabled Body"], "Monitoring stopped; system sleep is managed by SteamOS again");
  assert.equal(en.notify_tip, "Show notifications when monitoring or sleep-inhibition status changes");
  assert.match(frontend, /notifyMonitorStatus\(checked\)/);
  assert.match(frontend, /const notifyStateChange = showStateNotification && running/);
  assert.match(frontend, /await stopInhibit\(notifyStateChange, overrideState\)/);
  assert.doesNotMatch(frontend, /event\.reason/);
});

test("diagnostics merge monitor state and process mode behind an accessible detail button", () => {
  const zh = JSON.parse(
    readFileSync(new URL("../src/i18n/zh-cn.json", import.meta.url), "utf8"),
  );
  const source = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );

  assert.equal(zh["Monitor Details"], "查看息屏抑制监控详情");
  assert.equal(zh["Monitoring Method"], "监听方式");
  assert.equal(zh.monitor_details_tip, "开启后优先使用内核进程事件监听；不可用时自动切换为低频扫描。关闭监控后，进程监听也会停止。");
  assert.doesNotMatch(source, /<DiagnosticRow label=\{t\('Process Monitor Mode'\)\}/);
  assert.match(source, /<MonitorStatusRow/);
  assert.match(source, /aria-expanded=\{detailsVisible\}/);
});

test("Stage 4.1 performs silent full-state sync before event subscriptions", () => {
  const source = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /const synchronizeRuntimeState = async \(showStateNotification = false\) =>/);
  assert.match(source, /serverApi\.getInhibitStatus\(\)/);
  assert.match(source, /getPowerSyncAction\(/);
  assert.match(source, /refreshDeckyMusicSetting\(false, running\)/);
  assert.match(source, /await synchronizeRuntimeState\(\);[\s\S]*reconnectPushListeners\(\)/);
  assert.match(source, /const reconnectPushListeners = \([^)]*\) =>[\s\S]*subscribeSettingsChanged[\s\S]*subscribeInhibitStateChanged/);
  assert.match(source, /backendState\.SetState\(running \? 1 : 0\)/);
});

test("Stage 4.2 keeps the narrow settings push independently subscribed", () => {
  const source = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /serverApi\.subscribeSettingsChanged\(\(\) =>/);
  assert.match(source, /enqueuePowerOperation\(\(\) => refreshDeckyMusicSetting\(\)\)/);
  assert.match(source, /unsubscribeSettingsChanged\?\.\(\)/);
  assert.doesNotMatch(source, /event\.type === "SettingsChanged"/);
  assert.match(source, /serverApi\.subscribeInhibitStateChanged/);
});

test("Stage 4.3 treats critical pushes as full-state refresh signals", () => {
  const source = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );
  const apiSource = readFileSync(
    new URL("../src/deckyApi.ts", import.meta.url),
    "utf8",
  );

  assert.match(apiSource, /subscribeInhibitStateChanged/);
  assert.match(source, /serverApi\.subscribeInhibitStateChanged\(\(\) =>/);
  assert.match(source, /const synchronizeRuntimeState = async \(showStateNotification = false\) =>/);
  assert.match(source, /enqueuePowerOperation\(\(\) => synchronizeRuntimeState\(true\)\)/);
  assert.doesNotMatch(source, /startInhibit\(event\.application\)/);
  assert.doesNotMatch(source, /event\.reason/);
});

test("disabling the monitor also disables DeckyMusic inhibition before reporting success", () => {
  const source = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /onMonitorChanged: \(\) => Promise<void>/);
  assert.match(source, /if \(succeeded !== true\) throw new Error\("backend lifecycle RPC failed"\);\s*await onMonitorChanged\(\);\s*notifyMonitorStatus\(checked\)/);
  assert.match(source, /const refreshDeckyMusicSetting = async \(\s*reconcilePower = true,\s*monitorRunning = backendState\.GetState\(\) === 1,\s*\) =>/);
  assert.match(source, /deckyMusicEnabled = monitorRunning\s*&& isDeckyMusicEnabled\(normalizeManualApps\(manualApps\)\)/);
  assert.match(source, /await refreshDeckyMusicSetting\(false, running\)/);
});

test("Stage 4.4 diagnostics report push health instead of polling counters", () => {
  const source = readFileSync(
    new URL("../src/index.tsx", import.meta.url),
    "utf8",
  );
  const diagnosticsSource = readFileSync(
    new URL("../src/diagnostics.ts", import.meta.url),
    "utf8",
  );
  const zh = JSON.parse(
    readFileSync(new URL("../src/i18n/zh-cn.json", import.meta.url), "utf8"),
  );

  assert.doesNotMatch(diagnosticsSource, /eventQueueSize|longPollRequests|longPollTimeouts/);
  assert.match(diagnosticsSource, /pushListenerActive: boolean/);
  assert.match(diagnosticsSource, /pushReconnectCount: number/);
  assert.match(diagnosticsSource, /lastFullSyncAt: number \| null/);
  assert.match(diagnosticsSource, /lastFullSyncSuccessful: boolean \| null/);
  assert.match(source, /getEventChannelDiagnostics/);
  assert.match(source, /reconnectPushListeners/);
  assert.match(source, /reconnectPushListeners\(true\)/);
  assert.match(source, /if \(synchronizeAfterConnect\)[\s\S]*synchronizeRuntimeState\(\)/);
  assert.match(source, /markDisconnected\(\)/);
  assert.match(source, /markConnected\(\)/);
  assert.doesNotMatch(source, /t\('Long Poll Requests'\)|t\('Long Poll Timeouts'\)|t\('Queued Events'\)/);
  assert.equal(zh["Push Listener"], "推送监听");
  assert.equal(zh["Reconnect Count"], "重连次数");
  assert.equal(zh["Last Full Sync"], "最近一次全量同步");
});
