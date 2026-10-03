import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
function load(file, require) {
  const module = {exports: {}};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true},
  }).outputText, {module, exports: module.exports, require});
  return module.exports;
}
function fixture(persist) {
  const editing = load('../src/settingEditing.ts', () => ({}));
  const {usePluginSettings, disposePluginSettings} = load('../src/usePluginSettings.ts', id => id === './settingEditing' ? editing
    : id === './settingsClient' ? {setPluginSetting: (api,key,value) => api.setSetting(key,value), isPluginSettingSaveSuccessful: value => value === true}
    : id === 'react' ? {useRef: value => ({current: value}), createElement() {}}
    : {GiNightSleep() {}});
  const api = {setSetting: persist, toaster: {toast() {}}};
  return {mount: () => usePluginSettings(api, value => value), dispose: () => disposePluginSettings(api), api};
}
function state(initial) {
  let value = initial;
  const listeners = new Set();
  return {get: () => value, listenerCount: () => listeners.size, set(next) {if(value===next)return;value=next;listeners.forEach(listener=>listener(next));},
    binding: {publish(next){if(value===next)return;value=next;listeners.forEach(listener=>listener(next));},
      subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}}};
}
const deferred = () => {let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const tick = async () => {for(let i=0;i<10;i++)await Promise.resolve();};

test('a pending opacity failure restores shared state after its panel unsubscribes', async () => {
  const gate=deferred(), runtime=state(1), panel=fixture(()=>gate.promise).mount();
  const editor=panel.getEditor('opacity',1,undefined,runtime.binding);
  const release=editor.subscribe(()=>{}), pending=editor.edit(()=>0.8);
  assert.equal(runtime.get(),0.8);release();gate.resolve(false);await pending;
  assert.equal(runtime.get(),1);
});

test('remount reuses the existing queue and keeps the latest edit authoritative', async () => {
  const gate=deferred(), calls=[], runtime=state(true);let count=0,stored=true;
  const instance=fixture(async(_key,value)=>{calls.push(value);if(++count===1)await gate.promise;stored=value;return true;});
  const old=instance.mount().getEditor('enabled',true,undefined,runtime.binding);
  const first=old.edit(()=>false);await tick();
  const replacement=instance.mount().getEditor('enabled',runtime.get(),undefined,runtime.binding);
  assert.equal(replacement,old);
  const second=replacement.edit(()=>true);assert.deepEqual(calls,[false]);
  gate.resolve();await Promise.all([first,second]);assert.equal(runtime.get(),true);assert.equal(stored,true);
});

test('a real external close without panel subscribers supersedes a pending enable', async () => {
  const gate=deferred(), runtime=state(false);let stored=false,count=0;
  const instance=fixture(async(_key,value)=>{if(++count===1)await gate.promise;stored=value;return true;});
  const editor=instance.mount().getEditor('enabled',false,undefined,runtime.binding);
  const pending=editor.edit(()=>true);await tick();runtime.set(false);
  assert.equal(runtime.get(),false);gate.resolve();await pending;await tick();
  assert.equal(runtime.get(),false);assert.equal(stored,false);
});

test('plugin disposal releases runtime listeners and fences old queued writes and publishers', async () => {
  const gate=deferred(),runtime=state(false),calls=[];
  const instance=fixture(async(_key,value)=>{calls.push(value);await gate.promise;return true;});
  const editor=instance.mount().getEditor('enabled',false,undefined,runtime.binding);
  const first=editor.edit(()=>true);await tick();const queued=editor.edit(()=>false);
  instance.dispose();assert.equal(runtime.listenerCount(),0);
  runtime.set(true);gate.resolve();await Promise.all([first,queued]);
  assert.deepEqual(calls,[true]);assert.equal(runtime.get(),true);
});

test('real Content black toggle updates overlay after CloseSideMenus unmounts its panel', async () => {
  const source=readFileSync(new URL('../src/index.tsx',import.meta.url),'utf8');
  const ast=ts.createSourceFile('index.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let editorDeclaration,toggle;
  function visit(node){
    if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='blackBackgroundEditor')editorDeclaration=`const ${node.getText(ast)};`;
    if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(ast)==='ToggleField'){
      const label=node.attributes.properties.find(property=>property.name?.getText(ast)==='label');
      if(label?.getText(ast).includes("'Black Background'"))toggle=node.attributes.properties.find(property=>property.name?.getText(ast)==='onChange').initializer.expression.getText(ast);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);assert.ok(editorDeclaration);assert.ok(toggle);
  const {StateNumber}=load('../src/state.ts',()=>({}));
  const overlayState=new StateNumber(0),panelVisible={current:true};let persisted=false,release;
  const instance=fixture(async(_key,value)=>{persisted=value;return true;});
  const context=vm.createContext({getEditor:instance.mount().getEditor,overlayState,BLACK_BACKGROUND_ENABLED:'enabled',
    panelVisible,reportSaveFailure(){},Navigation:{CloseSideMenus(){release();panelVisible.current=false;}}});
  vm.runInContext(ts.transpileModule(`${editorDeclaration}\nthis.editor=blackBackgroundEditor;this.toggle=${toggle};`,{
    compilerOptions:{target:ts.ScriptTarget.ES2020},
  }).outputText,context);
  release=context.editor.subscribe(()=>{});
  await context.toggle(true);assert.equal(panelVisible.current,false);assert.equal(overlayState.GetState(),1);
  await context.toggle(false);assert.equal(persisted,false);assert.equal(overlayState.GetState(),0);
});
