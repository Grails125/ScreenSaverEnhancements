import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/displayOffSession.ts', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module, exports: module.exports, setTimeout, clearTimeout });
const { DisplayOffSession } = module.exports;

function fixture(overrides = {}) {
  const state = { on: true, awake: false, guard: null, input: null, tick: null, phase: 'idle', offCount: 0 };
  const dependencies = {
    guardTimeoutMs: 15,
    async getDisplayPower() { return { supported: true, isInternal: true, isOn: state.on }; },
    async setDisplayPower(on) {
      assert.ok(on || (state.awake && state.guard && state.input), 'wake and recovery must exist before off');
      state.on = on;
      if (!on) state.offCount++;
    },
    async setAwake(awake) { state.awake = awake; },
    async startGuard() { return state.guard = 'lease'; },
    async heartbeat(token) { return token === state.guard; },
    async stopGuard(token) { assert.equal(token, state.guard); state.on = true; state.guard = null; return true; },
    subscribeWake(wake) { state.input = wake; return () => { state.input = null; }; },
    scheduleTick(tick) { state.tick = tick; return () => { state.tick = null; }; },
    onState(phase) { state.phase = phase; },
    onError() {},
    ...overrides,
  };
  return { state, dependencies, session: new DisplayOffSession(dependencies) };
}

test('turns off only after recovery is armed, then input wake releases this session', async () => {
  const { state, session } = fixture();
  await session.start();
  assert.equal(state.phase, 'active');
  assert.equal(state.on, false);
  state.input();
  await session.stop();
  assert.equal(state.on, true);
  assert.equal(state.awake, false);
  assert.equal(state.guard, null);
  assert.equal(state.input, null);
  assert.equal(state.tick, null);
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('guard wake starts before native On and releases input while native settlement blocks a new Off', async () => {
  const native=deferred(), events=[];
  const {state,dependencies,session}=fixture();
  await session.start();
  dependencies.stopGuard=async()=>{events.push('guard');state.on=true;state.guard=null;return true;};
  dependencies.setDisplayPower=async on=>{
    if(on){events.push('native');await native.promise;state.on=true;}
    else {state.on=false;state.offCount++;}
  };
  const stopping=session.stop();await flush();
  assert.deepEqual(events,['guard','native']);
  assert.equal(state.input,null);
  assert.equal(state.phase,'waking');assert.equal(state.awake,true);
  const restarting=session.start();await flush();assert.equal(state.offCount,1);
  native.resolve();await stopping;await restarting;
  assert.equal(state.offCount,2);assert.equal(state.on,false);
  await session.stop();
});
test('guard wake succeeds even when concurrent native On fails', async () => {
  const {state,dependencies,session}=fixture();await session.start();
  dependencies.setDisplayPower=async()=>{throw Error('native unavailable');};
  await session.stop();
  assert.equal(state.on,true);assert.equal(state.phase,'idle');assert.equal(state.input,null);
});
test('native wake succeeds even when concurrent owned guard stop fails', async () => {
  const {state,dependencies,session}=fixture();await session.start();
  dependencies.stopGuard=async()=>{throw Error('guard unavailable');};
  await session.stop();
  assert.equal(state.on,true);assert.equal(state.phase,'idle');assert.equal(state.input,null);
});
test('a successful native wake still waits for the owned guard reply before a new Off', async () => {
  const guard=deferred();
  const {state,dependencies,session}=fixture({guardTimeoutMs:300});await session.start();
  const originalStop=dependencies.stopGuard;
  dependencies.stopGuard=async token=>{await guard.promise;return originalStop(token);};
  const stopping=session.stop();await flush();
  assert.equal(state.on,true);assert.equal(state.input,null);assert.equal(state.phase,'waking');
  const restarting=session.start();await flush();assert.equal(state.offCount,1);
  guard.resolve();await stopping;await restarting;
  assert.equal(state.offCount,2);assert.equal(state.on,false);
  await session.stop();
});

test('a hung guard stop cannot retain input or keep-awake after native wake', { timeout: 300 }, async () => {
  const pending = deferred();
  const { state, session } = fixture({ stopGuard: () => pending.promise });
  await session.start();
  const stopping = session.stop();
  await flush();
  assert.equal(state.on, true);
  assert.equal(state.input, null, 'release input as soon as native On succeeds');
  await stopping;
  assert.equal(state.phase, 'idle');
  assert.equal(state.on, true);
  assert.equal(state.awake, false);
  assert.equal(state.input, null);
  pending.reject(Error('late backend failure'));
  await flush();
});

test('a hung heartbeat wakes and cleans the session within its deadline', { timeout: 300 }, async () => {
  const pending = deferred();
  const { state, session } = fixture({ heartbeat: () => pending.promise });
  await session.start();
  await state.tick();
  assert.equal(state.phase, 'idle');
  assert.equal(state.on, true);
  assert.equal(state.awake, false);
  pending.reject(Error('late heartbeat failure'));
  await flush();
});

test('a guard stop deadline preserves recovery ownership if native wake also failed', { timeout: 300 }, async () => {
  const pending = deferred();
  const { state, dependencies, session } = fixture();
  await session.start();
  const nativePower = dependencies.setDisplayPower;
  const guardStop = dependencies.stopGuard;
  dependencies.setDisplayPower = async () => { throw Error('native offline'); };
  dependencies.stopGuard = () => pending.promise;
  await assert.rejects(session.stop(), /timed out/);
  assert.equal(state.phase, 'waking');
  assert.equal(state.awake, true);
  assert.ok(state.input);
  assert.ok(state.tick);
  pending.resolve(false);
  await flush();
  dependencies.setDisplayPower = nativePower;
  dependencies.stopGuard = guardStop;
  await state.tick();
  assert.equal(state.phase, 'idle');
  assert.equal(state.awake, false);
  assert.equal(state.input, null);
});

test('failed dispose retires old recovery and input before another instance turns off', async () => {
  const old = fixture();
  await old.session.start();
  const oldInput = old.state.input;
  const oldTick = old.state.tick;
  const scheduled = [];
  old.dependencies.scheduleTick = callback => {
    scheduled.push(callback);
    old.state.tick = callback;
    return () => { old.state.tick = null; };
  };
  let writes = 0;
  old.dependencies.setDisplayPower = async () => { writes++; throw Error('native unavailable'); };
  old.dependencies.stopGuard = async () => { throw Error('guard unavailable'); };
  await assert.rejects(old.session.dispose());
  const afterDisposeWrites = writes;
  assert.equal(old.state.tick, null);
  assert.equal(old.state.input, null);
  const newer = fixture();
  await newer.session.start();
  old.dependencies.setDisplayPower = async () => { writes++; newer.state.on = true; };
  for (const callback of scheduled) await callback();
  await oldTick();
  oldInput();
  await old.session.stop();
  await flush();
  assert.equal(writes, afterDisposeWrites);
  assert.equal(newer.state.on, false);
  await newer.session.stop();
});

test('an old pending heartbeat does not block or unlock a new session tick', async () => {
  const old = deferred();
  const current = deferred();
  let calls = 0;
  const { state, session } = fixture({ heartbeat: () => (++calls === 1 ? old.promise : current.promise) });
  await session.start();
  const oldTick = state.tick();
  await session.stop();
  await session.start();
  const newTick = state.tick();
  assert.equal(calls, 2);
  old.resolve(false);
  await oldTick;
  await state.tick();
  assert.equal(calls, 2, 'the old finally must not unlock the new pending tick');
  current.resolve(true);
  await newTick;
  assert.equal(state.phase, 'active');
  await session.stop();
});

test('a timed-out guard acquisition is cleaned late without affecting a fresh lease', { timeout: 300 }, async () => {
  const pending = deferred();
  const stopped = [];
  const { state, dependencies, session } = fixture({
    startGuard: () => pending.promise,
    async stopGuard(token) {
      stopped.push(token);
      if (state.guard !== token) return false;
      state.guard = null;
      state.on = true;
      return true;
    },
  });
  await assert.rejects(session.start(), /timed out/);
  assert.equal(state.phase, 'idle');
  assert.equal(state.awake, false);
  assert.equal(state.offCount, 0);
  dependencies.startGuard = async () => state.guard = 'next-lease';
  await session.start();
  pending.resolve('late-lease');
  await flush();
  assert.deepEqual(stopped, ['late-lease']);
  assert.equal(state.phase, 'active');
  assert.equal(state.on, false);
  assert.equal(state.guard, 'next-lease');
  await session.stop();
});

test('dispose completes while guard acquisition hangs and cleans its eventual token', { timeout: 300 }, async () => {
  const pending = deferred();
  const stopped = [];
  const { state, session } = fixture({ startGuard: () => pending.promise, async stopGuard(token) { stopped.push(token); return true; } });
  const starting = session.start();
  const rejected = assert.rejects(starting, /timed out|cancelled/);
  while (!state.awake) await Promise.resolve();
  await flush();
  await session.dispose();
  await rejected;
  assert.equal(state.phase, 'idle');
  assert.equal(state.awake, false);
  pending.resolve('late-disposed-lease');
  await flush();
  assert.deepEqual(stopped, ['late-disposed-lease']);
  assert.equal(state.offCount, 0);
});

test('a late acquisition rejection permits a fresh start without an orphan token', { timeout: 300 }, async () => {
  const pending = deferred();
  const { state, dependencies, session } = fixture({ startGuard: () => pending.promise });
  await assert.rejects(session.start(), /timed out/);
  pending.reject(Error('late start failure'));
  await flush();
  dependencies.startGuard = async () => state.guard = 'new-lease';
  await session.start();
  assert.equal(state.phase, 'active');
  await session.stop();
});

test('a stalled late-token cleanup does not block a fresh distinct lease', { timeout: 300 }, async () => {
  const acquisition = deferred();
  const cleanup = deferred();
  const { state, dependencies, session } = fixture({ startGuard: () => acquisition.promise, stopGuard: () => cleanup.promise });
  await assert.rejects(session.start(), /timed out/);
  acquisition.resolve('late-token');
  await flush();
  await new Promise(resolve => setTimeout(resolve, 30));
  dependencies.startGuard = async () => state.guard = 'fresh-token';
  dependencies.stopGuard = async () => true;
  await session.start();
  cleanup.resolve(false);
  await flush();
  assert.equal(state.phase, 'active');
  assert.equal(state.on, false);
  await session.stop();
});

test('coalesces repeated activation and supports another transient session after wake', async () => {
  const { state, session } = fixture();
  await Promise.all([session.start(), session.start()]);
  assert.equal(state.offCount, 1);
  await Promise.all([session.stop(), session.stop()]);
  await session.start();
  assert.equal(state.offCount, 2);
  await session.dispose();
  assert.equal(state.on, true);
});

test('leaves unsupported or already-off displays alone', async () => {
  for (const power of [
    { supported: false, isInternal: true, isOn: true },
    { supported: true, isInternal: false, isOn: true },
    { supported: true, isInternal: true, isOn: false },
  ]) {
    const { state, session } = fixture({ async getDisplayPower() { return power; } });
    await assert.rejects(session.start());
    assert.equal(state.offCount, 0);
    assert.equal(state.guard, null);
    assert.equal(state.awake, false);
  }
});

test('a failed off RPC restores the panel and all acquired resources', async () => {
  const { state, dependencies, session } = fixture();
  const setPower = dependencies.setDisplayPower;
  dependencies.setDisplayPower = async (on) => {
    await setPower(on);
    if (!on) throw Error('RPC response lost');
  };
  await assert.rejects(session.start(), /RPC response lost/);
  assert.equal(state.on, true);
  assert.equal(state.awake, false);
  assert.equal(state.guard, null);
  assert.equal(state.input, null);
});

test('does not turn off when a guard cannot start', async () => {
  const { state, session } = fixture({ async startGuard() { throw Error('guard missing'); } });
  await assert.rejects(session.start(), /guard missing/);
  assert.equal(state.offCount, 0);
  assert.equal(state.awake, false);
});

test('unload during an awaited activation prevents a late screen-off request', async () => {
  let finish;
  const { state, session } = fixture({ startGuard() { return new Promise(resolve => { finish = resolve; }); } });
  const start = session.start();
  while (!finish) await Promise.resolve();
  const dispose = session.dispose();
  state.guard = 'lease';
  finish('lease');
  await assert.rejects(start);
  await dispose;
  assert.equal(state.offCount, 0);
  assert.equal(state.on, true);
  assert.equal(state.awake, false);
});

test('a lost guard lease wakes the display rather than continuing unprotected', async () => {
  const { state, session } = fixture({ async heartbeat() { return false; } });
  await session.start();
  await state.tick();
  assert.equal(state.on, true);
  assert.equal(state.awake, false);
});

test('observes an external/native wake and releases its own keep-awake override', async () => {
  const { state, session } = fixture();
  await session.start();
  state.on = true;
  await state.tick();
  assert.equal(state.phase, 'idle');
  assert.equal(state.awake, false);
  assert.equal(state.guard, null);
});

test('retains cleanup ownership and retries if idle-override restoration fails', async () => {
  const { state, dependencies, session } = fixture();
  const setAwake = dependencies.setAwake;
  let fail = true;
  dependencies.setAwake = async (awake) => {
    if (!awake && fail) { fail = false; throw Error('settings unavailable'); }
    await setAwake(awake);
  };
  await session.start();
  await assert.rejects(session.stop(), /settings unavailable/);
  assert.equal(state.phase, 'waking');
  assert.equal(state.awake, true);
  await session.stop();
  assert.equal(state.phase, 'idle');
  assert.equal(state.awake, false);
});

test('keeps recovery available when both native and guard wake fail', async () => {
  const { state, dependencies, session } = fixture();
  await session.start();
  const setPower = dependencies.setDisplayPower;
  const stopGuard = dependencies.stopGuard;
  dependencies.setDisplayPower = async () => { throw Error('native offline'); };
  dependencies.stopGuard = async () => { throw Error('guard offline'); };
  await assert.rejects(session.stop());
  assert.equal(state.phase, 'waking');
  assert.equal(state.awake, true);
  dependencies.setDisplayPower = setPower;
  dependencies.stopGuard = stopGuard;
  await session.stop();
  assert.equal(state.on, true);
  assert.equal(state.awake, false);
});

test('ignores an old heartbeat failure after another session has started', async () => {
  let finish;
  const { state, dependencies, session } = fixture();
  await session.start();
  dependencies.heartbeat = () => new Promise(resolve => { finish = resolve; });
  const oldTick = state.tick();
  await session.stop();
  await session.start();
  finish(false);
  await oldTick;
  assert.equal(state.phase, 'active');
  assert.equal(state.on, false);
  await session.stop();
});

test('an input unsubscribe error does not prevent restoring idle settings', async () => {
  const { state, dependencies, session } = fixture();
  dependencies.subscribeWake = wake => {
    state.input = wake;
    return () => { throw Error('unsubscribe failed'); };
  };
  await session.start();
  await session.stop();
  assert.equal(state.on, true);
  assert.equal(state.awake, false);
  assert.equal(state.phase, 'idle');
});
