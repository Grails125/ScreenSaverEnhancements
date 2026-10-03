import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(new URL("../src/displayPower.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const response = (body, success = true, result = 1) => ({
  BSuccess: () => success,
  GetEResult: () => result,
  Body: () => ({ toObject: () => body }),
});
const stateBody = (overrides = {}) => ({ state: {
  is_service_available: true,
  is_display_state_management_supported: true,
  active_display_info: { is_external: false, display_state: 2 },
  ...overrides,
} });
const load = (body = stateBody(), options = {}) => {
  const calls = [];
  let lookups = 0;
  const service = {
    SetDisplayPowerStateHandler: { name: "Gamescope.SetDisplayPowerState#1" },
    GetState: async () => response(body, options.getSuccess ?? true, options.result ?? 1),
    SetDisplayPowerState: async ({ estate }) => {
      calls.push(estate);
      return response({}, options.setSuccess ?? true, options.result ?? 1);
    },
    ...options.service,
  };
  const module = { exports: {} };
  const context = options.context ?? vm.createContext({});
  Object.assign(context, {
    module, exports: module.exports,
    setTimeout: options.clock?.setTimeout ?? setTimeout,
    clearTimeout: options.clock?.clearTimeout ?? clearTimeout,
    require: () => ({ findModuleExport: (predicate) => {
      lookups++;
      if (options.lookup) return options.lookup(predicate, service, lookups);
      const candidates = options.missing ? [] : [{ GetState() {}, SetDisplayPowerState() {} }, service];
      return candidates.find(predicate);
    } }),
  });
  vm.runInContext(`(function(module, exports, require) { ${compiled}\n })(module, exports, require);`, context);
  return { ...module.exports, calls, service, lookupCount: () => lookups };
};
const plain = (value) => JSON.parse(JSON.stringify(value));

test('caches only a service hit while every read and mutation still queries fresh state', async () => {
  let reads = 0;
  const api = load(undefined, { service: { GetState: async () => { reads++; return response(stateBody()); } } });
  await api.getDisplayPower();
  await api.setDisplayPower(false);
  await api.setDisplayPower(true);
  assert.equal(api.lookupCount(), 1);
  assert.equal(reads, 3);
});

test('a discovery miss is retried rather than cached', async () => {
  const api = load(undefined, { lookup: (predicate, service, count) => count === 1 ? undefined : service });
  assert.equal((await api.getDisplayPower()).supported, false);
  assert.equal((await api.getDisplayPower()).supported, true);
  await api.getDisplayPower();
  assert.equal(api.lookupCount(), 2);
});

test('unsupported state and RPC read errors invalidate a previously valid service hit', async () => {
  for (const failure of ['unsupported', 'error']) {
    let mode = 'good';
    const api = load(undefined, { service: { GetState: async () => {
      if (mode === 'error') throw Error('read failed');
      return response(stateBody({ is_service_available: mode !== 'unsupported' }));
    } } });
    await api.getDisplayPower();
    mode = failure;
    if (failure === 'error') await assert.rejects(api.getDisplayPower(), /read failed/);
    else assert.equal((await api.getDisplayPower()).supported, false);
    mode = 'good';
    await api.getDisplayPower();
    await api.getDisplayPower();
    assert.equal(api.lookupCount(), 2);
  }
});

test('cached service never substitutes for a fresh external-display check', async () => {
  let external = false;
  const api = load(undefined, { service: { GetState: async () => response(stateBody({
    active_display_info: { is_external: external, display_state: 2 },
  })) } });
  await api.getDisplayPower(); external = true;
  await assert.rejects(api.setDisplayPower(false), /Internal display/);
  assert.deepEqual(api.calls, []);
});

test('cached shape changes are rediscovered and stale errors cannot clear the replacement', async () => {
  const old = deferred();
  const replacement = {
    SetDisplayPowerStateHandler: { name: 'Gamescope.SetDisplayPowerState#1' },
    GetState: async () => response(stateBody()), SetDisplayPowerState: async () => response({}),
  };
  const api = load(undefined, { service: { GetState: () => old.promise },
    lookup: (predicate, service, count) => count === 1 ? service : replacement });
  const failed = assert.rejects(api.getDisplayPower(), /old failed/);
  api.service.SetDisplayPowerState = null;
  await api.getDisplayPower();
  old.reject(Error('old failed')); await failed;
  await api.getDisplayPower();
  assert.equal(api.lookupCount(), 2);
});

test('mutation RPC errors invalidate the cached service', async () => {
  const api = load(undefined, { setSuccess: false });
  await api.getDisplayPower();
  await assert.rejects(api.setDisplayPower(true));
  await api.getDisplayPower();
  assert.equal(api.lookupCount(), 2);
});

test('an old late recovery failure cannot evict a newly discovered service', async () => {
  const time = clock();
  const off = deferred();
  const replacement = {
    SetDisplayPowerStateHandler: { name: 'Gamescope.SetDisplayPowerState#1' },
    GetState: async () => response(stateBody()), SetDisplayPowerState: async () => response({}),
  };
  const api = load(undefined, { clock: time,
    service: { SetDisplayPowerState: ({ estate }) => estate === 1 ? off.promise : Promise.reject(Error('old recovery failed')) },
    lookup: (predicate, service, count) => count === 1 ? service : replacement,
  });
  const failed = assert.rejects(api.setDisplayPower(false), /timed out/);
  await flush(); time.expire(); await failed;
  await api.setDisplayPower(true);
  off.resolve(response({})); await flush();
  await api.getDisplayPower();
  assert.equal(api.lookupCount(), 2);
  assert.equal(time.count(), 0);
});

test("reads the nested Gamescope state and reports the active internal panel", async () => {
  assert.deepEqual(plain(await load().getDisplayPower()), { supported: true, isOn: true, isInternal: true });
});

test("maps explicit off and on requests to the documented display enum", async () => {
  const api = load();
  await api.setDisplayPower(false);
  await api.setDisplayPower(true);
  assert.deepEqual(api.calls, [1, 2]);
});

test("fails closed when discovery or the nested capability contract changes", async () => {
  for (const api of [load(undefined, { missing: true }), load({ is_display_state_management_supported: true }),
    load(stateBody({ is_display_state_management_supported: false })),
    load(stateBody({ active_display_info: { is_external: false, display_state: 7 } }))]) {
    assert.equal((await api.getDisplayPower()).supported, false);
    await assert.rejects(api.setDisplayPower(false));
    assert.deepEqual(api.calls, []);
  }
});

test("never switches an external or unidentified display", async () => {
  for (const display of [{ is_external: true, display_state: 2 }, { display_state: 2 }]) {
    const api = load(stateBody({ active_display_info: display }));
    assert.equal((await api.getDisplayPower()).isInternal, false);
    await assert.rejects(api.setDisplayPower(false));
    assert.deepEqual(api.calls, []);
  }
});

test("rejects RPC failures rather than reporting that the screen changed", async () => {
  await assert.rejects(load(undefined, { getSuccess: false, result: 2 }).getDisplayPower(), /2/);
  await assert.rejects(load(undefined, { setSuccess: false, result: 15 }).setDisplayPower(false), /15/);
});

test("rejects malformed RPC responses", async () => {
  await assert.rejects(load(undefined, { service: { GetState: async () => ({}) } }).getDisplayPower());
});


const clock = () => {
  const timers = new Map();
  let serial = 0;
  return {
    setTimeout(fn, delay) { assert.equal(delay, 5000); timers.set(++serial, fn); return serial; },
    clearTimeout(id) { timers.delete(id); },
    expire() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    count: () => timers.size,
  };
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };

test("bounds read RPCs without issuing a display mutation", async () => {
  const time = clock();
  const pending = deferred();
  const api = load(undefined, { clock: time, service: { GetState: () => pending.promise } });
  const result = assert.rejects(api.getDisplayPower(), /timed out/);
  time.expire();
  await result;
  pending.resolve(response(stateBody()));
  await flush();
  assert.deepEqual(api.calls, []);
  assert.equal(time.count(), 0);
});

test("restores On after a timed-out Off completes late without rereading capability", async () => {
  const time = clock();
  const pending = deferred();
  const powers = [];
  let reads = 0;
  const api = load(undefined, { clock: time, service: {
    GetState: async () => { reads++; return response(stateBody()); },
    SetDisplayPowerState: ({ estate }) => { powers.push(estate); return estate === 1 ? pending.promise : Promise.resolve(response({})); },
  } });
  const result = assert.rejects(api.setDisplayPower(false), /timed out/);
  await flush();
  time.expire();
  await result;
  assert.deepEqual(powers, [1]);
  pending.resolve(response({}));
  await flush();
  assert.deepEqual(powers, [1, 2]);
  assert.equal(reads, 1);
  assert.equal(time.count(), 0);
});

test("handles late Off rejection and recovery errors without leaving timers", async () => {
  const time = clock();
  const pending = deferred();
  const powers = [];
  const api = load(undefined, { clock: time, service: {
    SetDisplayPowerState: ({ estate }) => {
      powers.push(estate);
      return estate === 1 ? pending.promise : Promise.reject(new Error("recovery unavailable"));
    },
  } });
  const result = assert.rejects(api.setDisplayPower(false), /timed out/);
  await flush();
  time.expire();
  await result;
  pending.reject(new Error("late transport error"));
  await flush();
  assert.deepEqual(powers, [1, 2]);
  assert.equal(time.count(), 0);
});

test("bounds On without starting another restoration request", async () => {
  const time = clock();
  const pending = deferred();
  const api = load(undefined, { clock: time, service: { SetDisplayPowerState: () => pending.promise } });
  const result = assert.rejects(api.setDisplayPower(true), /timed out/);
  await flush();
  time.expire();
  await result;
  pending.resolve(response({}));
  await flush();
  assert.equal(time.count(), 0);
});

test("clears RPC timers after immediate success and failure", async () => {
  const time = clock();
  await load(undefined, { clock: time }).setDisplayPower(false);
  assert.equal(time.count(), 0);
  await assert.rejects(load(undefined, { clock: time, service: { GetState: () => Promise.reject(new Error("disconnected")) } }).getDisplayPower(), /disconnected/);
  assert.equal(time.count(), 0);
});
test("bounds a stalled late restoration and consumes its eventual rejection", async () => {
  const time = clock();
  const off = deferred();
  const on = deferred();
  const powers = [];
  const api = load(undefined, { clock: time, service: {
    SetDisplayPowerState: ({ estate }) => { powers.push(estate); return estate === 1 ? off.promise : on.promise; },
  } });
  const result = assert.rejects(api.setDisplayPower(false), /timed out/);
  await flush();
  time.expire();
  await result;
  off.resolve(response({}));
  await flush();
  assert.deepEqual(powers, [1, 2]);
  assert.equal(time.count(), 1);
  time.expire();
  on.reject(new Error("late restoration failure"));
  await flush();
  assert.equal(time.count(), 0);
});

for (const reload of [false, true]) {
  test(`an old timed-out Off cannot wake a successful newer Off${reload ? ' across module reload' : ''}`, async () => {
    const time = clock();
    const old = deferred();
    const powers = [];
    const context = vm.createContext({});
    let count = 0;
    const service = { SetDisplayPowerState: ({ estate }) => {
      powers.push(estate);
      return estate === 1 && ++count === 1 ? old.promise : Promise.resolve(response({}));
    } };
    const first = load(undefined, { clock: time, context, service });
    const failed = assert.rejects(first.setDisplayPower(false), /timed out/);
    await flush(); time.expire(); await failed;
    await first.setDisplayPower(true);
    const next = reload ? load(undefined, { clock: time, context, service }) : first;
    await next.setDisplayPower(false);
    old.resolve(response({}));
    await flush();
    assert.deepEqual(powers, [1, 2, 1]);
    assert.equal(time.count(), 0);
  });
}

test('a late Off rejection respects a newer pending Off, then cleanup On still restores later Off', async () => {
  const time = clock();
  const old = deferred();
  const next = deferred();
  const powers = [];
  let count = 0;
  const api = load(undefined, { clock: time, service: { SetDisplayPowerState: ({ estate }) => {
    powers.push(estate);
    return estate === 1 ? (++count === 1 ? old.promise : next.promise) : Promise.resolve(response({}));
  } } });
  const failed = assert.rejects(api.setDisplayPower(false), /timed out/);
  await flush(); time.expire(); await failed;
  await api.setDisplayPower(true);
  const newer = assert.rejects(api.setDisplayPower(false), /timed out/);
  await flush();
  old.reject(Error('late old transport failure'));
  await flush();
  assert.deepEqual(powers, [1, 2, 1]);
  time.expire(); await newer;
  await api.setDisplayPower(true);
  next.resolve(response({})); await flush();
  assert.deepEqual(powers, [1, 2, 1, 2, 2]);
});

test('a failed newer Off does not suppress the older delayed safe wake', async () => {
  const time = clock();
  const old = deferred();
  const powers = [];
  let count = 0;
  const api = load(undefined, { clock: time, service: { SetDisplayPowerState: ({ estate }) => {
    powers.push(estate);
    return estate === 1 ? (++count === 1 ? old.promise : Promise.reject(Error('new off failed'))) : Promise.resolve(response({}));
  } } });
  const failed = assert.rejects(api.setDisplayPower(false), /timed out/);
  await flush(); time.expire(); await failed;
  await assert.rejects(api.setDisplayPower(false), /new off failed/);
  old.resolve(response({})); await flush();
  assert.deepEqual(powers, [1, 1, 2]);
});

test('an earlier failed Off cannot replace the latest successful Off intent', async () => {
  const time = clock();
  const late = deferred();
  const earlier = deferred();
  const powers = [];
  let count = 0;
  const api = load(undefined, { clock: time, service: { SetDisplayPowerState: ({ estate }) => {
    powers.push(estate);
    if (estate !== 1) return Promise.resolve(response({}));
    count++;
    return count === 1 ? late.promise : count === 2 ? earlier.promise : Promise.resolve(response({}));
  } } });
  const initial = assert.rejects(api.setDisplayPower(false), /timed out/);
  await flush(); time.expire(); await initial;
  const superseded = assert.rejects(api.setDisplayPower(false), /earlier failed/);
  await flush();
  await api.setDisplayPower(false);
  earlier.reject(Error('earlier failed'));
  await superseded;
  late.resolve(response({})); await flush();
  assert.deepEqual(powers, [1, 1, 1]);
});

test('cleanup On intent survives a failed capability query and restores the delayed Off', async () => {
  const time = clock();
  const late = deferred();
  const powers = [];
  let reads = 0, offs = 0;
  const api = load(undefined, { clock: time, service: {
    GetState: async () => {
      if (++reads === 3) throw Error('query unavailable');
      return response(stateBody());
    },
    SetDisplayPowerState: ({ estate }) => {
      powers.push(estate);
      return estate === 1 && ++offs === 1 ? late.promise : Promise.resolve(response({}));
    },
  } });
  const initial = assert.rejects(api.setDisplayPower(false), /timed out/);
  await flush(); time.expire(); await initial;
  await api.setDisplayPower(false);
  await assert.rejects(api.setDisplayPower(true), /query unavailable/);
  late.resolve(response({})); await flush();
  assert.deepEqual(powers, [1, 1, 2]);
});

for (const reload of [false, true]) {
  test(`a timed-out pending wake refuses another Off until it settles${reload ? ' across reload' : ''}`, async () => {
    const time = clock(), wake = deferred(), powers = [];
    const context = vm.createContext({});
    const service = { SetDisplayPowerState: ({ estate }) => {
      powers.push(estate);
      return estate === 2 ? wake.promise : Promise.resolve(response({}));
    } };
    const first = load(undefined, { clock: time, context, service });
    const waking = assert.rejects(first.setDisplayPower(true), /timed out/);
    await flush(); time.expire(); await waking;
    const next = reload ? load(undefined, { clock: time, context, service }) : first;
    await assert.rejects(next.setDisplayPower(false), /wake request.*pending/i);
    assert.deepEqual(powers, [2]);
    wake.resolve(response({})); await flush();
    await next.setDisplayPower(false);
    assert.deepEqual(powers, [2, 1]);
    assert.equal(time.count(), 0);
  });
}

test('an Off capability reply cannot submit a mutation after a newer wake', async () => {
  const staleRead = deferred(), powers = [];
  let reads = 0;
  const api = load(undefined, { service: {
    GetState: () => ++reads === 1 ? staleRead.promise : Promise.resolve(response(stateBody())),
    SetDisplayPowerState: async ({ estate }) => { powers.push(estate); return response({}); },
  } });
  const off = assert.rejects(api.setDisplayPower(false), /superseded/i);
  await flush(); await api.setDisplayPower(true);
  staleRead.resolve(response(stateBody())); await off;
  assert.deepEqual(powers, [2]);
});

test('a pending recovery of a delayed Off also refuses a new Off until recovery settles', async () => {
  const time = clock(), off = deferred(), recovery = deferred(), powers = [];
  const api = load(undefined, { clock: time, service: { SetDisplayPowerState: ({ estate }) => {
    powers.push(estate); return estate === 1 ? off.promise : recovery.promise;
  } } });
  const initial = assert.rejects(api.setDisplayPower(false), /timed out/);
  await flush(); time.expire(); await initial;
  off.resolve(response({})); await flush();
  assert.deepEqual(powers, [1, 2]);
  time.expire(); await flush();
  await assert.rejects(api.setDisplayPower(false), /wake request.*pending/i);
  assert.deepEqual(powers, [1, 2]);
  recovery.resolve(response({})); await flush();
  await api.setDisplayPower(false);
  assert.deepEqual(powers, [1, 2, 1]);
});
