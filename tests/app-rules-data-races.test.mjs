import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture(overrides={}){
  const slots=[];let cursor=0,current=true;const react={useState(initial){const n=cursor++;if(!(n in slots))slots[n]=initial;return[slots[n],v=>slots[n]=v];},useRef(initial){const n=cursor++;if(!(n in slots))slots[n]={current:initial};return slots[n];}};
  const module={exports:{}};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/useAppRulesData.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,console:{warn(){}},require:id=>id==='react'?react:{normalizeManualApps:value=>value}});
  const api={getRunningProcesses:async()=>[],getInhibitStatus:async()=>({manual_apps:[]}),...overrides};
  return{render(){cursor=0;return module.exports.useAppRulesData(api,()=>current,()=>current,()=>1);},unmount(){current=false;}};
}
test('newer process refresh stays authoritative when an old response finishes last',async()=>{
  const gate=deferred();let count=0;const state=fixture({getRunningProcesses:()=>++count===1?gate.promise:Promise.resolve([{name:'new'}])});
  const old=state.render().refreshAppMenuData();await state.render().refreshAppMenuData();gate.resolve([{name:'old'}]);await old;
  assert.equal(state.render().runningProcesses[0].name,'new');
});
test('older process completion cannot clear a newer query loading state',async()=>{
  const gates=[deferred(),deferred()];let count=0;const state=fixture({getRunningProcesses:()=>gates[count++].promise});
  const old=state.render().refreshAppMenuData(),latest=state.render().refreshAppMenuData();gates[0].resolve([]);await old;
  assert.equal(state.render().refreshing,true);gates[1].resolve([]);await latest;assert.equal(state.render().refreshing,false);
});
test('newer inhibit refresh stays authoritative and has an independent request revision',async()=>{
  const gate=deferred();let count=0;const state=fixture({getInhibitStatus:()=>++count===1?gate.promise:Promise.resolve({manual_apps:[],manual_active:true})});
  const old=state.render().refreshInhibitStatus();await state.render().refreshAppMenuData();gate.resolve({manual_apps:[],manual_active:false});await old;
  assert.equal(state.render().inhibitStatus.manual_active,true);
});
test('pending app-rule requests cannot update an unmounted panel',async()=>{
  const gate=deferred();const state=fixture({getRunningProcesses:()=>gate.promise,getInhibitStatus:()=>gate.promise});
  const pending=state.render().refreshAppMenuData();state.unmount();gate.resolve([]);await pending;
  assert.equal(state.render().runningProcesses.length,0);assert.equal(state.render().inhibitStatus.manual_active,false);
});
