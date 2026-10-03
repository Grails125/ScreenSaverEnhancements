import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function load(path, imports = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, { module, exports: module.exports, require: name => imports[name] });
  return module.exports;
}
const power = load('../src/powerSettings.ts');
const { createPowerEditor } = load('../src/powerEditing.ts', { './powerSettings': power });
const normal = { batteryDim:300, acDim:300, batterySuspend:600, acSuspend:600 };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const copy = value => JSON.parse(JSON.stringify(value));
function fixture(options = {}) {
  let ui = copy(normal), persisted = copy(normal), native = copy(normal);
  const writes = [];
  const editor = createPowerEditor(normal, {
    persist: async value => { writes.push(['persist', copy(value)]); if (options.persist) await options.persist(value); persisted = copy(value); return true; },
    apply: async value => { writes.push(['apply', copy(value)]); if (options.apply) await options.apply(value); native = copy(value); },
    onChange: value => {ui = copy(value);},
  });
  return {editor, writes, state:()=>({ui,persisted,native})};
}
test('rapid edits save and apply in submission order using the confirmed predecessor', async () => {
  const blocked = deferred(); let count = 0;
  const f = fixture({persist:async () => {if (++count === 1) await blocked.promise;}});
  const a = f.editor.edit('batteryDim',120), b = f.editor.edit('acDim',180);
  await Promise.resolve();
  assert.equal(f.writes.length,1);
  assert.equal(f.state().ui.acDim,180);
  assert.equal(f.editor.replaceConfirmed(normal),false);
  blocked.resolve(); await Promise.all([a,b]);
  assert.deepEqual(f.state(), {ui:{...normal,batteryDim:120,acDim:180},persisted:{...normal,batteryDim:120,acDim:180},native:{...normal,batteryDim:120,acDim:180}});
});
test('a failed older native edit restores itself while preserving a newer edit', async () => {
  const blocked = deferred(); let count = 0;
  const f = fixture({apply:async () => {if (++count === 1) {await blocked.promise; throw Error('suspend failed');}}});
  const a = f.editor.edit('batteryDim',120); const rejected = assert.rejects(a,/suspend failed/);
  const b = f.editor.edit('acDim',180);
  blocked.resolve(); await rejected; await b;
  const expected = {...normal,acDim:180};
  assert.deepEqual(f.state(),{ui:expected,persisted:expected,native:expected});
});
test('failed persistence does not discard a later edit of the same field', async () => {
  let count = 0;
  const f = fixture({persist:async () => {if (++count === 1) throw Error('save failed');}});
  const a = f.editor.edit('batteryDim',120); const rejected = assert.rejects(a,/save failed/);
  const b = f.editor.edit('batteryDim',180);
  await rejected; await b;
  assert.deepEqual(f.state().ui,{...normal,batteryDim:180});
  assert.deepEqual(f.state().persisted,f.state().native);
});
test('rollback failure is retried before the next edit can be applied', async () => {
  let count = 0;
  const f = fixture({apply:async () => {if (++count <= 2) throw Error('native failed');}});
  await assert.rejects(f.editor.edit('batteryDim',120),/rollback/i);
  await f.editor.edit('acDim',180);
  const expected = {...normal,acDim:180};
  assert.deepEqual(f.state(),{ui:expected,persisted:expected,native:expected});
});
test('idle external settings replace the baseline used by the next edit', async () => {
  const f = fixture(); const changed = {...normal,batterySuspend:900};
  assert.equal(f.editor.replaceConfirmed(changed),true);
  await f.editor.edit('acDim',180);
  assert.deepEqual(f.state().native,{...changed,acDim:180});
});
test('a user edit arriving during passive system read discards the stale read', async () => {
  const f = fixture(), read = deferred();
  const sync = f.editor.synchronize(() => read.promise);
  await Promise.resolve();
  const edit = f.editor.edit('acDim',180);
  read.resolve({...normal,batteryDim:900});
  assert.equal(await sync,false);
  await edit;
  assert.deepEqual(f.state().persisted,{...normal,acDim:180});
});
test('passive persistence finishes before a new user edit and retains its baseline', async () => {
  const block = deferred(), started = deferred(); let count = 0;
  const f = fixture({persist:async () => {if (++count === 1) {started.resolve(); await block.promise;}}});
  const sync = f.editor.synchronize(async () => ({...normal,batteryDim:900}));
  await started.promise;
  assert.equal(f.editor.replaceConfirmed(normal),false);
  const edit = f.editor.edit('acDim',180);
  block.resolve(); await sync; await edit;
  assert.deepEqual(f.state().native,{...normal,batteryDim:900,acDim:180});
});
test('dispose drains a started write and prevents queued edits writing after disposal', async () => {
  const block = deferred(); let count = 0;
  const f = fixture({persist:async () => {if (++count === 1) await block.promise;}});
  const a = f.editor.edit('batteryDim',120);
  const b = f.editor.edit('acDim',180); const rejection = assert.rejects(b,/inactive/);
  await Promise.resolve();
  let drained = false; const disposal = f.editor.dispose().then(()=>{drained=true;});
  await Promise.resolve(); assert.equal(drained,false);
  block.resolve(); await a; await rejection; await disposal;
  assert.equal(count,1);
  assert.equal(f.state().native.acDim,300);
});
test('an explicit false save response rejects the edit and restores the previous profile', async () => {
  let count = 0, ui, native;
  const editor = createPowerEditor(normal, {
    persist:async () => ++count !== 1,
    apply:async value => {native=copy(value);},
    onChange:value => {ui=copy(value);},
  });
  await assert.rejects(editor.edit('acDim',180),/save failed/i);
  assert.deepEqual(ui,normal); assert.deepEqual(native,normal);
});
test('a subsequent edit cannot write a new candidate while recovery is still failing', async () => {
  const f = fixture({apply:async () => {throw Error('native unavailable');}});
  await assert.rejects(f.editor.edit('batteryDim',120),/rollback/i);
  const before = f.writes.length;
  await assert.rejects(f.editor.edit('acDim',180),/rollback/i);
  assert.deepEqual(f.writes.slice(before).map(([,value])=>value),[normal,normal]);
  assert.deepEqual(f.state().ui,normal);
});
test('confirmed callbacks exclude optimistic edits and failures', async () => {
  const block = deferred(), confirmed = [];
  let count = 0;
  const editor = createPowerEditor(normal, {
    persist:async () => {if (++count===1) {await block.promise; return false;} return true;},
    apply:async () => {}, onChange:()=>{}, onConfirmed:value=>confirmed.push(copy(value)),
  });
  editor.replaceConfirmed(normal);
  const a = editor.edit('batteryDim',120), rejection=assert.rejects(a,/save failed/i);
  const b = editor.edit('acDim',180);
  assert.deepEqual(confirmed,[normal]);
  block.resolve(); await rejection; await b;
  assert.deepEqual(confirmed,[normal,{...normal,acDim:180}]);
  await editor.synchronize(async()=>({...normal,acDim:180,batterySuspend:900}));
  assert.deepEqual(confirmed.at(-1),{...normal,acDim:180,batterySuspend:900});
});
test('subscriptions receive current projection immediately and stop after cleanup', async () => {
  const block=deferred(), f=fixture({persist:async()=>block.promise}), received=[];
  const release=f.editor.subscribe(value=>received.push(copy(value)));
  assert.deepEqual(received,[normal]);
  const operation=f.editor.edit('batteryDim',120);
  assert.equal(received.at(-1).batteryDim,120);
  release(); const count=received.length;
  block.resolve(); await operation;
  f.editor.replaceConfirmed({...normal,acDim:180});
  assert.equal(received.length,count);
  const remounted=[]; f.editor.subscribe(value=>remounted.push(copy(value)));
  assert.deepEqual(remounted,[{...normal,acDim:180}]);
  await f.editor.dispose();
  assert.equal(f.editor.replaceConfirmed(normal),false);
  assert.equal(remounted.length,1);
});
test('getSettings and each subscription receive independent copies of the projection', async () => {
  const f=fixture(); const first=f.editor.getSettings(); first.acDim=999;
  assert.equal(f.editor.getSettings().acDim,300);
  f.editor.subscribe(value=>{value.acDim=888;});
  const values=[]; f.editor.subscribe(value=>values.push(copy(value)));
  await f.editor.edit('batteryDim',120);
  assert.deepEqual(copy(f.editor.getSettings()),{...normal,batteryDim:120});
  assert.equal(values.at(-1).acDim,300);
});
test('edits queued before readiness use the loaded profile and keep pending projection', async () => {
  const ready=deferred(), writes=[], published=[];
  const editor=createPowerEditor(normal,{
    ready:ready.promise,persist:async value=>{writes.push(copy(value)); return true;},
    apply:async()=>{},onChange:value=>published.push(copy(value)),
  });
  assert.equal(editor.isReady,false);
  const operation=editor.edit('acDim',180);
  await Promise.resolve(); assert.equal(writes.length,0);
  ready.resolve({...normal,batterySuspend:900});
  await operation;
  assert.equal(editor.isReady,true);
  assert.deepEqual(writes,[{...normal,batterySuspend:900,acDim:180}]);
  assert.ok(published.some(value=>value.batterySuspend===900 && value.acDim===180));
});
test('unknown initial profile rejects edits without writes and can recover through synchronization', async () => {
  const writes=[];
  const editor=createPowerEditor(normal,{
    ready:Promise.resolve(null),persist:async value=>{writes.push(copy(value));return true;},
    apply:async()=>{},
  });
  await assert.rejects(editor.edit('acDim',180),/not been loaded/i);
  assert.equal(writes.length,0); assert.equal(editor.isReady,false);
  await editor.synchronize(async()=>({...normal,batterySuspend:900}));
  assert.equal(editor.isReady,true);
  await editor.edit('acDim',180);
  assert.deepEqual(writes.at(-1),{...normal,batterySuspend:900,acDim:180});
});
test('passive reads wait for initial readiness instead of publishing a premature baseline', async () => {
  const ready=deferred(); let readCount=0;
  const editor=createPowerEditor(normal,{ready:ready.promise,persist:async()=>true,apply:async()=>{}});
  const sync=editor.synchronize(async()=>{readCount++;return {...normal,batteryDim:900};});
  await Promise.resolve();assert.equal(readCount,0);
  ready.resolve(null);await sync;
  assert.equal(readCount,1);assert.equal(editor.isReady,true);
});

test('failed persistence of a real native profile cannot make a later edit restore stale fields', async () => {
  let native={...normal,acDim:600},fail=true;
  const editor=createPowerEditor(normal,{
    persist:async()=>{if(fail){fail=false;return false;}return true;},
    apply:async value=>{native=copy(value);},
  });
  await assert.rejects(editor.synchronize(async()=>copy(native)),/save failed/i);
  assert.deepEqual(copy(editor.getSettings()),{...normal,acDim:600});
  await editor.edit('batteryDim',120);
  assert.deepEqual(native,{...normal,acDim:600,batteryDim:120});
});

test('failed passive persistence is retried without applying a stale profile', async () => {
  const writes=[];let fail=true;
  const editor=createPowerEditor(normal,{
    persist:async value=>{writes.push(['persist',copy(value)]);return !fail;},
    apply:async value=>{writes.push(['apply',copy(value)]);},
  });
  const actual={...normal,acDim:600};
  await assert.rejects(editor.synchronize(async()=>actual),/save failed/i);
  await assert.rejects(editor.edit('batteryDim',120),/save failed|rollback/i);
  assert.equal(writes.some(([kind])=>kind==='apply'),false);
  fail=false;await editor.edit('batteryDim',120);
  assert.deepEqual(writes.at(-1),['apply',{...actual,batteryDim:120}]);
});
