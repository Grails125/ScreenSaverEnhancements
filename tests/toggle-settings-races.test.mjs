import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/index.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('index.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declarations={},handlers={};
function visit(node){
  if(ts.isVariableDeclaration(node))declarations[node.name.getText(ast)]=`const ${node.getText(ast)};`;
  if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(ast)==='ToggleField'){
    const label=node.attributes.properties.find(p=>p.name?.getText(ast)==='label');
    for(const name of ['Show Notify','Close On Any Key'])if(label?.getText(ast).includes(`'${name}'`))handlers[name]=node.attributes.properties.find(p=>p.name?.getText(ast)==='onChange').initializer.expression.getText(ast);
  }
  ts.forEachChild(node,visit);
}visit(ast);
function load(file,require){const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,{module,exports:module.exports,require});return module.exports;}
const editing=load('../src/settingEditing.ts',()=>({}));
const client=load('../src/settingsClient.ts',()=>({}));
const {StateNumber}=load('../src/state.ts',()=>({}));
const hooks=load('../src/usePluginSettings.ts',id=>id==='./settingEditing'?editing:id==='./settingsClient'?client:id==='react'?{createElement(){}}:{});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const tick=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function fixture(name,persist,existing){
  const api=existing?.api??{setSetting:persist,toaster:{toast(){}}};
  const settings=hooks.usePluginSettings(api,k=>k);
  const context=vm.createContext({console:{warn(){}},notify:existing?.context.showNotify??false,showNotify:existing?.context.showNotify??false,closeOnAnyKey:false,
    showNotifyState:existing?.context.showNotifyState??new StateNumber(0),
    SHOW_NOTIFY:'notify',BLACK_BACKGROUND_CLOSE_ON_ANY_KEY:'any',...settings,panelVisible:{current:true}});
  context.setNotify=v=>context.notify=v;context.setCloseOnAnyKey=v=>context.closeOnAnyKey=v;
  const editorName=name==='Show Notify'?'notifyEditor':'closeOnAnyKeyEditor';
  const text=declarations[editorName]??'';
  vm.runInContext(ts.transpileModule(`${text}\nthis.editor=typeof ${editorName}==='undefined'?undefined:${editorName};\nthis.toggle=${handlers[name]};`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,context);
  const release=context.editor?.subscribe(name==='Show Notify'?context.setNotify:context.setCloseOnAnyKey);
  return{api,context,release,dispose:()=>hooks.disposePluginSettings(api),value:()=>name==='Show Notify'?context.notify:context.closeOnAnyKey};
}
for(const name of Object.keys(handlers))test(`${name} restores confirmed false when both rapid reverse saves fail`,async()=>{
  const gates=[deferred(),deferred()];let count=0;
  const state=fixture(name,()=>gates[count++].promise);
  const first=state.context.toggle(true);await tick();const second=state.context.toggle(false);
  gates[0].resolve(false);await first;await tick();gates[1].resolve(false);await second;
  assert.equal(state.value(),false);if(name==='Show Notify')assert.equal(state.context.showNotify,false);
});
test('notification rollback updates shared runtime after panel unsubscribes',async()=>{
  const gate=deferred(),state=fixture('Show Notify',()=>gate.promise);
  const pending=state.context.toggle(true);await tick();state.release?.();state.context.panelVisible.current=false;
  gate.resolve(false);await pending;assert.equal(state.context.showNotify,false);
});
test('notification remount shares pending queue and preserves latest saved intent',async()=>{
  const gate=deferred();let count=0,stored=false;
  const state=fixture('Show Notify',async(_key,value)=>{if(++count===1)await gate.promise;stored=value;return true;});
  const first=state.context.toggle(true);await tick();state.release?.();
  const replacement=fixture('Show Notify',undefined,state);const second=replacement.context.toggle(false);
  gate.resolve(true);await Promise.all([first,second]);assert.equal(stored,false);assert.equal(replacement.value(),false);assert.equal(replacement.context.showNotify,false);
});
test('disposed notification editor cannot publish a failed save into replacement runtime',async()=>{
  const gate=deferred(),state=fixture('Show Notify',()=>gate.promise);
  const pending=state.context.toggle(true);await tick();state.dispose();state.context.showNotify=true;
  gate.resolve(false);await pending;assert.equal(state.context.showNotify,true);
});
test('any-key reload failure retains previously confirmed setting',async()=>{
  const state=fixture('Close On Any Key',async()=>true);
  await state.context.toggle(true);
  Object.assign(state.context,{blackBackgroundEditor:editing.createSettingEditor(false,async()=>true),opacityEditor:editing.createSettingEditor(1,async()=>true),
    serverApi:{getSetting:async()=>{throw Error('offline');}},getPluginBooleanSetting:client.getPluginBooleanSetting,getPluginNumberSetting:client.getPluginNumberSetting,
    BLACK_BACKGROUND_ENABLED:'enabled',BLACK_BACKGROUND_OPACITY:'opacity',clampOpacity:client.clampOpacity,parseBooleanSetting:client.parseBooleanSetting,isCurrentRequest:()=>true,token:1,setCloseOnAnyKeyLoaded(){}});
  vm.runInContext(ts.transpileModule(`${declarations.loadBlackBackgroundSettings}\nthis.load=loadBlackBackgroundSettings;`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,state.context);
  await state.context.load();assert.equal(state.value(),true);
});

test('any-key edit during initialization stays authoritative over the old read',async()=>{
  const gate=deferred(),state=fixture('Close On Any Key',async()=>true);
  Object.assign(state.context,{blackBackgroundEditor:editing.createSettingEditor(false,async()=>true),opacityEditor:editing.createSettingEditor(1,async()=>true),
    serverApi:{getSetting:()=>gate.promise},getPluginBooleanSetting:async()=>false,getPluginNumberSetting:async()=>1,
    BLACK_BACKGROUND_ENABLED:'enabled',BLACK_BACKGROUND_OPACITY:'opacity',clampOpacity:client.clampOpacity,parseBooleanSetting:client.parseBooleanSetting,isCurrentRequest:()=>true,token:1,setCloseOnAnyKeyLoaded(){}});
  vm.runInContext(ts.transpileModule(`${declarations.loadBlackBackgroundSettings}\nthis.load=loadBlackBackgroundSettings;`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,state.context);
  const loading=state.context.load();await tick();const edit=state.context.toggle(true);gate.resolve(false);
  await Promise.all([loading,edit]);assert.equal(state.value(),true);
});
test('failed any-key reread cannot confirm an unsaved optimistic reverse edit',async()=>{
  let rejectRead,count=0;
  const read=new Promise((_,reject)=>rejectRead=reject);
  const state=fixture('Close On Any Key',async()=>++count===1);
  await state.context.toggle(true);
  Object.assign(state.context,{blackBackgroundEditor:editing.createSettingEditor(false,async()=>true),opacityEditor:editing.createSettingEditor(1,async()=>true),
    serverApi:{getSetting:()=>read},getPluginBooleanSetting:async()=>false,getPluginNumberSetting:async()=>1,
    BLACK_BACKGROUND_ENABLED:'enabled',BLACK_BACKGROUND_OPACITY:'opacity',clampOpacity:client.clampOpacity,parseBooleanSetting:client.parseBooleanSetting,isCurrentRequest:()=>true,token:1,setCloseOnAnyKeyLoaded(){}});
  vm.runInContext(ts.transpileModule(`${declarations.loadBlackBackgroundSettings}\nthis.load=loadBlackBackgroundSettings;`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,state.context);
  const loading=state.context.load();await tick();const edit=state.context.toggle(false);rejectRead(Error('offline'));
  await Promise.all([loading,edit]);assert.equal(state.value(),true);
});
function loadNotify(state,read){
  assert.ok(declarations.loadNotifySettings,'Content must load its notification editor baseline');
  Object.assign(state.context,{serverApi:{getSetting:read},parseBooleanSetting:client.parseBooleanSetting});
  vm.runInContext(ts.transpileModule(`{${declarations.loadNotifySettings}\nthis.loadNotify=loadNotifySettings;}`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,state.context);
  return state.context.loadNotify();
}
test('saved notification true becomes the rollback baseline for an early mounted panel',async()=>{
  const state=fixture('Show Notify',async()=>false);
  await loadNotify(state,async()=>true);assert.equal(state.value(),true);
  await state.context.toggle(false);assert.equal(state.value(),true);assert.equal(state.context.showNotify,true);
});
test('notification edit during a baseline read stays authoritative',async()=>{
  const gate=deferred(),state=fixture('Show Notify',async()=>true);
  const loading=loadNotify(state,()=>gate.promise);await tick();const edit=state.context.toggle(true);
  gate.resolve(false);await Promise.all([loading,edit]);assert.equal(state.value(),true);assert.equal(state.context.showNotify,true);
});
test('failed notification reread retains its confirmed true rollback baseline',async()=>{
  const state=fixture('Show Notify',async()=>false);
  await loadNotify(state,async()=>true);await loadNotify(state,async()=>{throw Error('offline');});
  await state.context.toggle(false);assert.equal(state.value(),true);assert.equal(state.context.showNotify,true);
});
test('factory notification baseline broadcasts into an editor whose own read failed',async()=>{
  const state=fixture('Show Notify',async()=>false);
  await loadNotify(state,async()=>{throw Error('offline');});
  state.context.showNotify=true;state.context.showNotifyState.SetState(1);
  assert.equal(state.value(),true);await state.context.toggle(false);
  assert.equal(state.value(),true);assert.equal(state.context.showNotify,true);
});
test('a same-value notification intent advances the factory baseline revision fence',async()=>{
  const state=fixture('Show Notify',async()=>true);
  const initialRevision=state.context.showNotifyState.GetRevision();
  const pending=state.context.toggle(false);
  assert.ok(state.context.showNotifyState.GetRevision()>initialRevision);await pending;
});
