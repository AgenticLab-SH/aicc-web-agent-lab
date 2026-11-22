import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {resolvePrivateHome} from './private-home.mjs';

// AICC owns this layout. Supplier auth/session homes keep their native owners.
export function resolveRuntimeLayout(options={}) {
  const {root,home}=resolvePrivateHome(options);
  return {root,home,bin:path.join(root,'bin'),releases:path.join(root,'releases'),
    registry:path.join(root,'runtime','components.json'),
    legacyReleaseRoot:path.join(home,'.codex','releases','open-aicc')};
}
export function insideDirectory(root,target) {
  const relative=path.relative(path.resolve(root),path.resolve(target));
  return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);
}
function realDirectory(directory){fs.mkdirSync(directory,{recursive:true,mode:0o700});if(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink())throw Error('AICC runtime directory must be real');}
export function runtimeHomeStatus(options={}) {
  const layout=resolveRuntimeLayout(options);let registry={schemaVersion:1,components:{}};
  if(fs.existsSync(layout.registry)){
    if(fs.lstatSync(layout.registry).isSymbolicLink())throw Error('Linked component registry refused');
    registry=JSON.parse(fs.readFileSync(layout.registry,'utf8'));
    if(registry.schemaVersion!==1||registry.root!==layout.root||!registry.components)throw Error('Invalid component registry');
  }
  return {...layout,components:registry.components,policy:'one-home-immutable-component-releases-native-owner-secrets',
    externalOwners:['Codex','Web GPT','OCX','browser supplier'],legacyMovesRequire:'idle owner rebind; no junctions or live moves'};
}
export function initializeRuntimeLayout(options={}) {
  const layout=resolveRuntimeLayout(options);
  for(const directory of [layout.root,layout.bin,layout.releases,path.dirname(layout.registry)])realDirectory(directory);
  if(!fs.existsSync(layout.registry))fs.writeFileSync(layout.registry,JSON.stringify({schemaVersion:1,root:layout.root,components:{}},null,2)+'\n',{flag:'wx',mode:0o600});
  return {root:layout.root,bin:layout.bin,releases:layout.releases,registry:layout.registry,initialized:true};
}
export function managedReleaseRoot(component,options={}) {
  if(!/^[a-z][a-z0-9-]{0,47}$/.test(component))throw Error('Invalid AICC component');
  return path.join(resolveRuntimeLayout(options).releases,component);
}
export function registerRuntimeComponent(name,component,options={}) {
  const layout=resolveRuntimeLayout(options);initializeRuntimeLayout(options);
  if(!/^[a-z][a-z0-9-]{0,47}$/.test(name)||!component||typeof component.entry!=='string')throw Error('Invalid component registration');
  const managed=insideDirectory(layout.releases,component.entry);
  const legacy=insideDirectory(layout.legacyReleaseRoot,component.entry);
  if(!path.isAbsolute(component.entry)||(!managed&&!legacy))throw Error('Component entry outside managed release roots');
  const before=fs.readFileSync(layout.registry);const registry=JSON.parse(before);
  registry.components[name]={...component,location:managed?'managed':'legacy-frozen',registeredAt:new Date().toISOString()};
  const temporary=layout.registry+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(registry,null,2)+'\n',{flag:'wx',mode:0o600});
  if(!fs.readFileSync(layout.registry).equals(before)){fs.unlinkSync(temporary);throw Error('Component registry changed concurrently');}
  fs.renameSync(temporary,layout.registry);
  return {registered:name,entry:component.entry,location:registry.components[name].location};
}
