import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
const module={exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/settingEditing.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports});
const {createSettingEditor}=module.exports;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const tick=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
test('list saves serialize and rebase later edits on the last successful list',async()=>{
 const gate=deferred(),calls=[];let ui,stored=['Music','Downloader'];
 const editor=createSettingEditor(stored,async value=>{calls.push(Array.from(value));if(calls.length===1){await gate.promise;return false;}stored=Array.from(value);return true;});
 editor.subscribe(v=>ui=Array.from(v));
 const first=editor.edit(list=>list.filter(v=>v!=='Music'));
 const second=editor.edit(list=>list.filter(v=>v!=='Downloader'));
 await tick();assert.equal(calls.length,1);gate.resolve();assert.equal(await first,false);assert.equal(await second,true);
 assert.deepEqual(ui,['Music']);assert.deepEqual(stored,['Music']);assert.deepEqual(calls,[['Downloader'],['Music']]);
});
test('initial list read rebases edits made while the read is pending',async()=>{
 const gate=deferred();let ui,stored;
 const editor=createSettingEditor([],async value=>{stored=Array.from(value);return true;});editor.subscribe(v=>ui=Array.from(v));
 const read=editor.synchronize(()=>gate.promise);const edit=editor.edit(list=>[...list,'New']);await tick();gate.resolve(['Existing']);await Promise.all([read,edit]);
 assert.deepEqual(ui,['Existing','New']);assert.deepEqual(stored,['Existing','New']);
});
test('pending opacity remains visible when an earlier save fails',async()=>{
 const gate=deferred();let count=0,ui,stored=1;const editor=createSettingEditor(1,async value=>{if(++count===1){await gate.promise;return false;}stored=value;return true;});editor.subscribe(v=>ui=v);
 const first=editor.edit(()=>0.5),second=editor.edit(()=>0.8);assert.equal(ui,0.8);await tick();gate.resolve();assert.equal(await first,false);assert.equal(ui,0.8);await second;assert.equal(stored,0.8);assert.equal(ui,0.8);
});
test('initial black setting read cannot hide an edit made while loading',async()=>{
 const gate=deferred();let ui,stored;const editor=createSettingEditor(false,async value=>{stored=value;return true;});editor.subscribe(v=>ui=v);
 const read=editor.synchronize(()=>gate.promise),edit=editor.edit(()=>true);assert.equal(ui,true);gate.resolve(false);await Promise.all([read,edit]);assert.equal(ui,true);assert.equal(stored,true);
});
test('external overlay changes invalidate an older initialization read',async()=>{
 const gate=deferred();let ui;const editor=createSettingEditor(false,async()=>true);editor.subscribe(v=>ui=v);
 const read=editor.synchronize(()=>gate.promise);editor.acceptExternal(true);gate.resolve(false);await read;assert.equal(ui,true);
});
test('unsubscribing releases panel notifications while pending writes still finish',async()=>{
 const gate=deferred(),values=[];const editor=createSettingEditor(1,()=>gate.promise);const release=editor.subscribe(v=>values.push(v));const edit=editor.edit(()=>0.8);release();gate.resolve(true);await edit;assert.deepEqual(values,[1,0.8]);assert.equal(editor.getValue(),0.8);
});
test('external close supersedes a pending enable and repairs its late persistence',async()=>{
 const gate=deferred();let stored=false,ui,count=0;
 const editor=createSettingEditor(false,async value=>{if(++count===1)await gate.promise;stored=value;return true;});
 editor.subscribe(value=>ui=value);
 const enable=editor.edit(()=>true);await tick();
 editor.acceptExternal(false);assert.equal(ui,false);
 gate.resolve();await enable;await tick();
 assert.equal(ui,false);assert.equal(stored,false);
});
test('a new user edit survives cleanup of an externally superseded edit',async()=>{
 const gate=deferred();let stored=false,count=0;
 const editor=createSettingEditor(false,async value=>{if(++count===1)await gate.promise;stored=value;return true;});
 const old=editor.edit(()=>true);await tick();editor.acceptExternal(false);
 const next=editor.edit(()=>true);gate.resolve();await Promise.all([old,next]);
 assert.equal(editor.getValue(),true);assert.equal(stored,true);
});
