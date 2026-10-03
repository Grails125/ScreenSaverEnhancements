import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

test('a guard-recovered wake timeout cannot leave a new session off before the old native wake settles', async () => {
  const timers = new Map(); let timerId = 0, panelOn = true, delayWake = false, finishWake, phase;
  const response = body => ({ BSuccess: () => true, GetEResult: () => 1, Body: () => ({ toObject: () => body }) });
  const service = {
    SetDisplayPowerStateHandler: { name: 'Gamescope.SetDisplayPowerState#1' },
    GetState: async () => response({ state: { is_service_available: true, is_display_state_management_supported: true,
      active_display_info: { is_external: false, display_state: panelOn ? 2 : 1 } } }),
    SetDisplayPowerState: ({ estate }) => {
      if (estate === 2 && delayWake) {
        delayWake = false;
        return new Promise(resolve => { finishWake = () => { panelOn = true; resolve(response({})); }; });
      }
      panelOn = estate === 2; return Promise.resolve(response({}));
    },
  };
  const context = vm.createContext({
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
    require: () => ({ findModuleExport: predicate => predicate(service) ? service : null }),
  });
  const load = filename => {
    const module = { exports: {} }; context.module = module; context.exports = module.exports;
    const code = ts.transpileModule(readFileSync(new URL('../src/' + filename, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInContext(`(function(module,exports,require){${code}\n})(module,exports,require);`, context);
    return module.exports;
  };
  const native = load('displayPower.ts'), { DisplayOffSession } = load('displayOffSession.ts');
  const session = new DisplayOffSession({
    getDisplayPower: native.getDisplayPower, setDisplayPower: native.setDisplayPower,
    async setAwake() {}, async startGuard() { return 'lease'; }, async stopGuard() { panelOn = true; return true; },
    async heartbeat() { return true; }, subscribeWake() { return () => {}; }, scheduleTick() { return () => {}; },
    onState(value) { phase = value; }, onError() {},
  });
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  await session.start(); delayWake = true;
  const stopping = session.stop(); await flush();
  for (const fn of [...timers.values()]) fn(); timers.clear(); await stopping;
  assert.equal(phase, 'idle'); assert.equal(panelOn, true);
  await assert.rejects(session.start(), /wake request.*pending/i);
  assert.equal(phase, 'idle'); assert.equal(panelOn, true);
  finishWake(); await flush();
  await session.start(); assert.equal(phase, 'active'); assert.equal(panelOn, false);
  await session.stop(); assert.equal(phase, 'idle'); assert.equal(panelOn, true);
});
