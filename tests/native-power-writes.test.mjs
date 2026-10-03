import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';
const module={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/powerLifecycle.ts',import.meta.url),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS},
}).outputText,{module,exports:module.exports,setTimeout,clearTimeout});
const {createNativePowerWriter}=module.exports;
const normal={batteryDim:60,acDim:300,batterySuspend:300,acSuspend:0};
const zero={batteryDim:0,acDim:0,batterySuspend:0,acSuspend:0};
const copy=x=>JSON.parse(JSON.stringify(x));
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture(host={},blockStage='idle') {
  const late=deferred(),calls=[];let first=true,native=copy(normal);
  const writer=createNativePowerWriter(host,{timeoutMs:5,onError(){}});
  const idle=async profile=>{calls.push(['idle',copy(profile)]);if(first&&blockStage==='idle'){first=false;await late.promise;}native.batteryDim=profile.batteryDim;native.acDim=profile.acDim;};
  const suspend=async profile=>{calls.push(['suspend',copy(profile)]);if(first&&blockStage==='suspend'){first=false;await late.promise;}native.batterySuspend=profile.batterySuspend;native.acSuspend=profile.acSuspend;};
  return{late,calls,writer,write:profile=>writer.write(profile,idle,suspend),native:()=>copy(native)};
}
test('a lost native idle response rejects within its deadline and does not send obsolete suspend',async()=>{
  const f=fixture();await assert.rejects(f.write(zero),/timed out/);
  assert.deepEqual(f.calls,[['idle',zero]]);
  await f.write(normal);assert.deepEqual(f.native(),normal);
});
test('late idle application is repaired to the latest profile instead of overwriting it',async()=>{
  const f=fixture();await assert.rejects(f.write(zero),/timed out/);
  const desired={...normal,acDim:600};await f.write(desired);
  f.late.resolve();await flush();assert.deepEqual(f.native(),desired);
  assert.equal(f.calls.filter(([kind,p])=>kind==='suspend'&&p.acDim===0).length,0);
});
test('late suspend application is repaired after a newer profile succeeds',async()=>{
  const f=fixture({},'suspend');await assert.rejects(f.write(zero),/timed out/);
  const desired={...normal,batterySuspend:900};await f.write(desired);
  f.late.resolve();await flush();assert.deepEqual(f.native(),desired);
});
test('an unloaded writer repairs using the replacement bundle native intent',async()=>{
  const host={},old=fixture(host);await assert.rejects(old.write(zero),/timed out/);
  const replacement=fixture(host,'none'),desired={...normal,acDim:900};await replacement.write(desired);
  old.late.resolve();await flush();
  assert.deepEqual(replacement.calls.at(-1),['suspend',desired]);
});
test('a failed compensation cannot leave a permanently pending repair queue',async()=>{
  const host={},old=fixture(host);await assert.rejects(old.write(zero),/timed out/);
  const failure=deferred();let count=0;
  const writer=createNativePowerWriter(host,{timeoutMs:5,onError:failure.resolve});
  await writer.write(normal,async()=>{if(++count>1)await new Promise(()=>{});},async()=>{});
  old.late.resolve();
  const error=await failure.promise;assert.match(error.message,/timed out/);
  await writer.write({...normal,acDim:600},async()=>{},async()=>{});
});

test('a late acknowledgement without a newer transaction completes the whole original intent',async()=>{
  const f=fixture();await assert.rejects(f.write(zero),/timed out/);
  f.late.resolve();await flush();assert.deepEqual(f.native(),zero);
  assert.deepEqual(f.calls.at(-1),['suspend',zero]);
});

test('a late transport rejection still repairs the latest complete native intent',async()=>{
  const f=fixture();await assert.rejects(f.write(zero),/timed out/);
  const desired={...normal,acDim:600};await f.write(desired);
  f.late.reject(new Error('response lost after application'));
  await flush();assert.deepEqual(f.calls.at(-1),['suspend',desired]);
  assert.equal(f.calls.filter(([kind])=>kind==='idle').length,3);
});

test('late replies from an already timed out repair never regenerate the same repair indefinitely',async()=>{
  let calls=0,errors=0;
  const writer=createNativePowerWriter({}, {timeoutMs:5,onError:()=>{errors++;}});
  const slow=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,12));};
  await assert.rejects(writer.write(normal,slow,slow),/timed out/);
  await new Promise(resolve=>setTimeout(resolve,75));
  assert.equal(calls,2);assert.equal(errors,1);
});

test('an obsolete repair still compensates a truly newer user intent',async()=>{
  const host={},old=fixture(host),blocked=deferred();let count=0,native=copy(normal);
  await assert.rejects(old.write(zero),/timed out/);
  const writer=createNativePowerWriter(host,{timeoutMs:50,onError(){}});
  const idle=async profile=>{if(++count===2)await blocked.promise;native.batteryDim=profile.batteryDim;native.acDim=profile.acDim;};
  const suspend=async profile=>{native.batterySuspend=profile.batterySuspend;native.acSuspend=profile.acSuspend;};
  await writer.write(normal,idle,suspend);
  old.late.resolve();await flush();assert.equal(count,2);
  const desired={...normal,acDim:900,batterySuspend:600};await writer.write(desired,idle,suspend);
  blocked.resolve();await flush();assert.deepEqual(native,desired);assert.equal(count,4);
});

test('replacement startup takes over repair errors even before its first native write',async()=>{
  const host={},first=fixture(host),observed=deferred();let oldErrors=0,count=0;
  await assert.rejects(first.write(zero),/timed out/);
  const old=createNativePowerWriter(host,{timeoutMs:5,onError:()=>{oldErrors++;}});
  await old.write(normal,async()=>{if(++count>1)await new Promise(()=>{});},async()=>{});
  createNativePowerWriter(host,{timeoutMs:5,onError:observed.resolve});
  first.late.resolve();const error=await observed.promise;
  assert.match(error.message,/timed out/);assert.equal(oldErrors,0);
});
