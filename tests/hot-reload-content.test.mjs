import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function load() {
  let state, unsubscribe;
  const react={
    Fragment:'fragment',
    createElement:(type,props,...children)=>({type,props:{...props,children:children.length===1?children[0]:children}}),
    useState:initial=>{if(!state)state=initial();return[state,value=>{state=value;}];},
    useEffect:effect=>{if(!unsubscribe)unsubscribe=effect();},
  };
  const module={exports:{}};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/hotReloadContent.tsx',import.meta.url),'utf8'),{
    fileName:'hotReloadContent.tsx',compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React},
  }).outputText,{module,exports:module.exports,require:()=>({...react,default:react})});
  return {...module.exports,unmount:()=>{unsubscribe?.();unsubscribe=null;}};
}
test('an old mounted wrapper renders replacement content across bundle instances with a new key',()=>{
  const host={}, oldModule=load(), nextModule=load();
  const oldProps={onDisplayOff:()=> 'old session'}, nextProps={onDisplayOff:()=> 'new session'};
  const oldElement={props:oldProps}, nextElement={props:nextProps};
  const old=oldModule.createHotReloadContent(host,oldElement);
  const first=old.content.type();
  assert.equal(first.props.children,oldElement);
  old.retire();
  assert.equal(old.content.type().props.children,null);
  nextModule.createHotReloadContent(host,nextElement);
  const replaced=old.content.type();
  assert.equal(replaced.props.children,nextElement);
  assert.notEqual(replaced.props.key,first.props.key);
  assert.equal(replaced.props.children.props.onDisplayOff(),'new session');
});
test('an old owner cannot clear content registered by the replacement',()=>{
  const host={}, api=load(), old=api.createHotReloadContent(host,'old');
  const next=load().createHotReloadContent(host,'next');
  old.retire();
  assert.equal(api.createHotReloadContentRegistry(host).getSnapshot().content,'next');
  next.retire();
  assert.equal(api.createHotReloadContentRegistry(host).getSnapshot().content,null);
});
test('subscription cleanup stops updates and offscreen wrapper unmount releases its listener',()=>{
  const host={}, api=load(), registry=api.createHotReloadContentRegistry(host), values=[];
  const release=registry.subscribe(value=>values.push(value.content));
  registry.register('first');release();registry.register('second');
  assert.deepEqual(values,[null,'first']);
  const wrapper=api.createHotReloadContent(host,'mounted');wrapper.content.type();
  assert.equal(host[Symbol.for('ScreenSaverEnhancements.hotReloadContent')].listeners.size,1);
  api.unmount();
  assert.equal(host[Symbol.for('ScreenSaverEnhancements.hotReloadContent')].listeners.size,0);
  registry.register('after unmount');
  assert.equal(host[Symbol.for('ScreenSaverEnhancements.hotReloadContent')].listeners.size,0);
});
