import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';
const markerRelative='components/workspace-mcp/runtime-marker.mjs';
const originalOwnerGuard=`function markerOwnerGuard(marker, options) {
  const pid = marker.process?.pid;
  if (!Number.isInteger(pid) || pid < 1) return { allowed: false, reason: 'runtime_owner_unknown' };
  try {
    (options.signalProcess ?? process.kill)(pid, 0);
    return { allowed: false, reason: 'runtime_owner_active' };
  } catch (error) {
    return error.code === 'ESRCH'
      ? { allowed: true, reason: 'runtime_owner_stopped' }
      : { allowed: false, reason: 'runtime_owner_unknown' };
  }
}`;
function functionRange(text,name){
  const tree=parse(text,{ecmaVersion:'latest',sourceType:'module'});
  const matches=tree.body.map(node=>node.type==='ExportNamedDeclaration'?node.declaration:node).filter(node=>node?.type==='FunctionDeclaration'&&node.id?.name===name);
  if(matches.length!==1)throw Error('Exact marker function required: '+name);
  return matches[0];
}
function functionText(text,name){const node=functionRange(text,name);return text.slice(node.start,node.end).replaceAll('\r\n','\n');}
function stable(value){return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);}
export function verifyRecordedManifestReconciliation(release,previous,record,actual){
  if(!record||record.changedInventoryOnly!==true||record.path!=='tools/platform/windows/Invoke-AiccWorkspaceSandbox.ps1'||actual.sha256!==record.sha256)throw Error('Unsupported manifest reconciliation');
  const expected=structuredClone(previous),rows=expected.files.filter(row=>row.path===record.path);
  if(rows.length!==1)throw Error('Original manifest reconciliation row differs');
  rows[0].sha256=actual.sha256;rows[0].size=actual.size;
  expected.fileCount=expected.files.length;expected.totalBytes=expected.files.reduce((sum,row)=>sum+row.size,0);expected.appContainerReconciliation=record;
  if(stable(expected)!==stable(release))throw Error('Manifest reconciliation changes unrelated inventory');
}
// Promote only the reviewed owner guard. Its existing token implementation must
// be identical, so unrelated canonical runtime changes never enter a candidate.
export function overlayPidReuseGuard(baseline,canonical){
  for(const name of ['sha256','processStartTokenForTimezone','processStartTokens','processStartToken','legacyLocalProcessStartToken']){
    if(functionText(baseline,name)!==functionText(canonical,name))throw Error('Marker identity dependency differs: '+name);
  }
  const replacement=functionText(canonical,'markerOwnerGuard');
  if(!replacement.includes("reason: 'runtime_owner_pid_reused'"))throw Error('Canonical PID reuse guard is missing');
  const previous=functionText(baseline,'markerOwnerGuard');
  if(previous===replacement)return baseline;
  if(previous!==originalOwnerGuard)throw Error('Installed marker owner guard differs from the supported baseline');
  const range=functionRange(baseline,'markerOwnerGuard');
  return baseline.slice(0,range.start)+replacement.replaceAll('\n',baseline.includes('\r\n')?'\r\n':'\n')+baseline.slice(range.end);
}
function regularTree(root){
  const output=new Map();
  function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name),stat=fs.lstatSync(file);
    if(stat.isSymbolicLink())throw Error('Linked code tree preserved; no clone');
    if(stat.isDirectory())visit(file);else if(stat.isFile())output.set(path.relative(root,file),file);else throw Error('Non-regular code tree');
  }}
  if(fs.lstatSync(root).isSymbolicLink())throw Error('Linked code tree preserved; no clone');
  visit(root);return output;
}
function stageWorkspaceHome(){
const home=path.resolve(process.env.AICC_STATE_ROOT||path.join(os.homedir(),'.ai-control-center'));
const source=fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const helperOnly=process.argv.slice(2).length===1&&process.argv[2]==='--helper-only';
const pidGuard=process.argv.slice(2).length===1&&process.argv[2]==='--pid-reuse-guard';
const repair=helperOnly||pidGuard;
if(process.argv.length>2&&!repair)throw Error('Only --helper-only or --pid-reuse-guard is supported');
const registryFile=path.join(home,'runtime/components.json');
const registryBytes=repair?fs.readFileSync(registryFile):null;
const registered=repair?JSON.parse(registryBytes):null;
const profile=path.join(home,'workspace-mcp/tunnel/profiles/aicc-workspace.yaml');
const profileBytes=fs.readFileSync(profile),profileText=profileBytes.toString('utf8');
const match=profileText.match(/command:\s*("(?:[^"\\]|\\.)*")/);
if(!match)throw Error('Exact JSON-quoted gateway command required');
const command=JSON.parse(match[1]),argumentsQuoted=[...command.matchAll(/"([^"]+)"/g)].map(row=>path.resolve(row[1]));
if(argumentsQuoted.length!==3||path.basename(argumentsQuoted[1])!=='gateway.cjs'||path.basename(argumentsQuoted[2])!=='config.json')throw Error('Registered unified gateway required');
const oldGateway=path.dirname(argumentsQuoted[1]),configBytes=fs.readFileSync(argumentsQuoted[2]),config=JSON.parse(configBytes);
if(config.schemaVersion!==1||!Array.isArray(config.providers)||config.providers.length!==2)throw Error('Exact unified provider graph required');
const workspace=config.providers.find(p=>p.id==='workspace'),native=config.providers.find(p=>p.id==='native');
if(!workspace||!native)throw Error('Registered Workspace and Native providers required');
for(const provider of config.providers)for(const item of provider.files){if(hash(fs.readFileSync(item.path))!==item.sha256)throw Error('Original provider fingerprint changed');}
const oldBackend=path.resolve(path.dirname(workspace.entrypoint),'../..');
const backendParent=repair?path.join(home,'releases/workspace'):path.join(os.homedir(),'.codex/releases/open-aicc');
if(!oldBackend.startsWith(backendParent+path.sep)||fs.lstatSync(oldBackend).isSymbolicLink()||(repair&&registered.components?.workspace?.releaseRoot!==oldBackend))throw Error('Registered immutable Workspace code required');
let backend=repair?oldBackend:path.join(home,'releases/workspace',path.basename(oldBackend));
let markerOverlay;
if(pidGuard){
  const canonical=fs.readFileSync(path.join(source,markerRelative),'utf8');
  const before=fs.readFileSync(path.join(oldBackend,markerRelative)),after=Buffer.from(overlayPidReuseGuard(before.toString('utf8'),canonical));
  const releaseBytes=fs.readFileSync(path.join(oldBackend,'.aicc-release.json')),release=JSON.parse(releaseBytes);
  const rows=release.files.filter(row=>row.path===markerRelative);
  if(rows.length!==1||rows[0].sha256!==hash(before)||rows[0].size!==before.length)throw Error('Backend marker manifest differs');
  const drive=JSON.parse(fs.readFileSync(path.join(oldBackend,'workspace-drive-manifest.json')));
  if(drive.files[markerRelative]!==hash(before))throw Error('Backend drive marker pin differs');
  if(drive.files['.aicc-release.json']!==hash(releaseBytes)){
    const record=release.appContainerReconciliation,previousRoot=registered.components.workspace.previousRelease;
    if(!previousRoot?.startsWith(backendParent+path.sep)||fs.lstatSync(previousRoot).isSymbolicLink()||record?.originalManifestSha256!==drive.files['.aicc-release.json'])throw Error('Backend drive manifest differs without exact history');
    const previousBytes=fs.readFileSync(path.join(previousRoot,'.aicc-release.json'));
    if(hash(previousBytes)!==record.originalManifestSha256)throw Error('Original reconciliation manifest differs');
    const actualPath=path.join(oldBackend,record.path),actual={sha256:hash(fs.readFileSync(actualPath)),size:fs.statSync(actualPath).size};
    if(!workspace.files.some(item=>item.path===actualPath&&item.sha256===actual.sha256))throw Error('Reconciled file lacks current provider pin');
    verifyRecordedManifestReconciliation(release,JSON.parse(previousBytes),record,actual);
  }
  markerOverlay={baseline:oldBackend,beforeSha256:hash(before),afterSha256:hash(after),canonicalGuardSha256:hash(functionText(canonical,'markerOwnerGuard'))};
  backend=path.join(home,'releases/workspace','workspace-pid-reuse-'+hash(JSON.stringify(markerOverlay)).slice(0,16));
  rows[0].sha256=hash(after);rows[0].size=after.length;
  release.fileCount=release.files.length;release.totalBytes=release.files.reduce((sum,row)=>sum+row.size,0);release.pidReuseGuardOverlay=markerOverlay;
  const nextRelease=Buffer.from(JSON.stringify(release,null,2)+'\n');
  drive.baseline=oldBackend;drive.release=backend;drive.files[markerRelative]=hash(after);drive.files['.aicc-release.json']=hash(nextRelease);
  const overlays=new Map([[markerRelative,after],['.aicc-release.json',nextRelease],['workspace-drive-manifest.json',Buffer.from(JSON.stringify(drive,null,2)+'\n')]]);
  const tree=regularTree(oldBackend);
  if(!fs.existsSync(backend)){
    fs.cpSync(oldBackend,backend,{recursive:true,dereference:false,errorOnExist:true,force:false});
    for(const [relative,bytes] of overlays)fs.writeFileSync(path.join(backend,relative),bytes);
  }
  const candidateTree=regularTree(backend);
  if(candidateTree.size!==tree.size)throw Error('Backend candidate file set differs');
  for(const [relative,file] of tree){const expected=overlays.get(relative.replaceAll('\\','/'))??fs.readFileSync(file);if(!candidateTree.has(relative)||hash(fs.readFileSync(candidateTree.get(relative)))!==hash(expected))throw Error('Backend candidate changes unrelated bytes: '+relative);}
}
if(!fs.existsSync(backend))fs.cpSync(oldBackend,backend,{recursive:true,dereference:false,errorOnExist:true,force:false});
for(const item of workspace.files)if(item.path.startsWith(oldBackend+path.sep)){
  const replacement=path.join(backend,path.relative(oldBackend,item.path));
  if(!pidGuard&&hash(fs.readFileSync(replacement))!==item.sha256)throw Error('Workspace copy changed');
  item.path=replacement;
  if(pidGuard)item.sha256=hash(fs.readFileSync(replacement));
}
if(pidGuard&&!workspace.files.some(item=>item.path===path.join(backend,markerRelative)))workspace.files.push({path:path.join(backend,markerRelative),sha256:markerOverlay.afterSha256});
workspace.entrypoint=path.join(backend,path.relative(oldBackend,workspace.entrypoint));
workspace.args=workspace.args.map(value=>typeof value==='string'&&value.startsWith(oldBackend+path.sep)?path.join(backend,path.relative(oldBackend,value)):value);
const helperRelative='tools/platform/workspace-mcp/windows-tunnel-secret.mjs',closure=new Map(),pending=[helperRelative];
const originalHost=repair?registered.components?.['workspace-host']:null;
if(repair&&(!originalHost?.releaseRoot?.startsWith(path.join(home,'releases/workspace-host')+path.sep)||fs.lstatSync(originalHost.releaseRoot).isSymbolicLink()||originalHost.entry!==path.join(originalHost.releaseRoot,helperRelative)||hash(fs.readFileSync(originalHost.entry))!==originalHost.entryHash))throw Error('Exact registered helper host required');
// A repair changes the requested helper only. Reuse the installed, pinned
// dependency closure instead of accidentally promoting unrelated source edits.
if(repair)for(const [relative,expected] of Object.entries(originalHost.sourceHashes)){
  const file=path.resolve(originalHost.releaseRoot,relative);
  if(!file.startsWith(originalHost.releaseRoot+path.sep)||fs.lstatSync(file).isSymbolicLink()||hash(fs.readFileSync(file))!==expected)throw Error('Registered helper dependency changed');
}
function walk(value,visitor){if(!value||typeof value!=='object')return;visitor(value);for(const item of Object.values(value)){if(Array.isArray(item))item.forEach(v=>walk(v,visitor));else if(item&&typeof item==='object')walk(item,visitor);}}
while(pending.length){
  const relative=pending.pop();if(closure.has(relative))continue;
  const sourceRoot=repair&&(pidGuard||relative.replaceAll('\\','/')!==helperRelative)?originalHost.releaseRoot:source;
  const file=path.resolve(sourceRoot,relative);if(!file.startsWith(sourceRoot+path.sep)||fs.lstatSync(file).isSymbolicLink())throw Error('Helper source escaped owner repository');
  if(repair&&(pidGuard||relative.replaceAll('\\','/')!==helperRelative)&&!Object.hasOwn(originalHost.sourceHashes,relative)&&!Object.hasOwn(originalHost.sourceHashes,relative.replaceAll('\\','/')))throw Error('Helper repair added an unpinned dependency');
  let bytes=fs.readFileSync(file);
  if(pidGuard&&relative.replaceAll('\\','/')===markerRelative)bytes=Buffer.from(overlayPidReuseGuard(bytes.toString('utf8'),fs.readFileSync(path.join(source,markerRelative),'utf8')));
  closure.set(relative,bytes);
  if(!/\.(mjs|cjs|js)$/.test(relative))continue;
  const tree=parse(bytes.toString('utf8'),{ecmaVersion:'latest',sourceType:'module'});
  walk(tree,node=>{
    let specifier;
    if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type))specifier=node.source?.value;
    if(node.type==='ImportExpression'){if(typeof node.source?.value!=='string')throw Error('Unreviewed dynamic helper import');specifier=node.source.value;}
    if(node.type==='NewExpression'&&node.callee?.name==='URL'&&node.arguments?.[1]?.object?.type==='MetaProperty')specifier=node.arguments?.[0]?.value;
    // The CLI status module resolves the already-sealed SDK in command.cwd; it
    // does not execute a require target. Keep this exception specific to that file.
    if(node.type==='CallExpression'&&node.callee?.name==='createRequire'&&relative.replaceAll('\\','/')!=='src/workspace-mcp.mjs')throw Error('Unreviewed helper loader: '+relative);
    if(typeof specifier==='string'&&specifier.startsWith('.')){
      const target=path.resolve(path.dirname(file),specifier);if(!target.startsWith(sourceRoot+path.sep))throw Error('Helper import escaped owner repository');
      pending.push(path.relative(sourceRoot,target));
    }
  });
}
const helperHashes=Object.fromEntries([...closure.entries()].sort().map(([relative,bytes])=>[relative,hash(bytes)]));
const helperIdentity=hash(JSON.stringify(helperHashes));const host=path.join(home,'releases/workspace-host',helperIdentity.slice(0,16));
const hostReceipt=path.join(home,'runtime/workspace-host-'+helperIdentity+'.json');
if(!fs.existsSync(hostReceipt)){
  if(fs.existsSync(host))throw Error('Incomplete host candidate preserved');
  regularTree(repair?originalHost.releaseRoot:oldBackend);
  fs.cpSync(repair?originalHost.releaseRoot:oldBackend,host,{recursive:true,dereference:false,errorOnExist:true,force:false});
  for(const [relative,bytes] of closure){const target=path.join(host,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);}
  fs.writeFileSync(hostReceipt,JSON.stringify({schemaVersion:1,sourceHashes:helperHashes,host})+'\n',{flag:'wx',mode:0o600});
}
for(const [relative,expected] of Object.entries(helperHashes))if(hash(fs.readFileSync(path.join(host,relative)))!==expected)throw Error('Immutable helper host changed');
if(helperOnly){
  if(hash(fs.readFileSync(registryFile))!==hash(registryBytes))throw Error('Registry changed while staging helper');
  console.log(JSON.stringify({terminal:'PASS_STAGED_HELPER',host,hostReceipt,helperEntry:path.join(host,helperRelative),helperHashes,originalHost:originalHost.releaseRoot,registryBeforeSha256:hash(registryBytes),onlyChangedSource:helperRelative,runtimeChanged:false}));
  process.exit(0);
}
const gatewayBytes=fs.readFileSync(path.join(oldGateway,'gateway.cjs')),newConfig=Buffer.from(JSON.stringify(config,null,2)+'\n');
const gatewayFiles={'config.json':hash(newConfig),'gateway.cjs':hash(gatewayBytes)};
const gatewayIdentity=hash(JSON.stringify(gatewayFiles));const gateway=path.join(home,'releases/unified-mcp',gatewayIdentity);
fs.mkdirSync(gateway,{recursive:true});
for(const [name,bytes] of [['gateway.cjs',gatewayBytes],['config.json',newConfig],['manifest.json',Buffer.from(JSON.stringify({schemaVersion:1,releaseHash:gatewayIdentity,files:gatewayFiles})+'\n')]]){
  const target=path.join(gateway,name);if(fs.existsSync(target)){if(hash(fs.readFileSync(target))!==hash(bytes))throw Error('Immutable gateway changed');}else fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
}
const newCommand=command.replaceAll(argumentsQuoted[1].replaceAll('\\','/'),path.join(gateway,'gateway.cjs').replaceAll('\\','/')).replaceAll(argumentsQuoted[2].replaceAll('\\','/'),path.join(gateway,'config.json').replaceAll('\\','/'));
if(newCommand===command)throw Error('Gateway command path spelling changed');
const newProfile=profileText.replace(match[1],JSON.stringify(newCommand));
const stagedProfile=path.join(home,'runtime/workspace-home-profile-'+gatewayIdentity+'.yaml');
if(fs.existsSync(stagedProfile)){if(hash(fs.readFileSync(stagedProfile))!==hash(newProfile))throw Error('Staged profile changed');}else fs.writeFileSync(stagedProfile,newProfile,{flag:'wx',mode:0o600});
const planFile=path.join(home,'runtime/workspace-home-plan-'+gatewayIdentity+'.json');
const plan={schemaVersion:1,profile,profileBeforeHash:hash(profileBytes),stagedProfile,profileAfterHash:hash(newProfile),oldGateway,gateway,backend,host,helperEntry:path.join(host,helperRelative),helperHashes,nativeProviderUnchanged:true,workspaceConfigUnchanged:true};
if(pidGuard){
  if(hash(fs.readFileSync(registryFile))!==hash(registryBytes)||hash(fs.readFileSync(profile))!==hash(profileBytes))throw Error('Runtime pins changed while staging');
  Object.assign(plan,{kind:'workspace-pid-reuse-guard',originalBackend:oldBackend,originalHost:originalHost.releaseRoot,registryBeforeSha256:hash(registryBytes),markerOverlay,hostMarkerBeforeSha256:hash(fs.readFileSync(path.join(originalHost.releaseRoot,markerRelative))),hostMarkerAfterSha256:hash(fs.readFileSync(path.join(host,markerRelative))),runtimeChanged:false});
}
if(!fs.existsSync(planFile))fs.writeFileSync(planFile,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
else if(hash(fs.readFileSync(planFile))!==hash(JSON.stringify(plan,null,2)+'\n'))throw Error('Existing stage plan differs; preserve it');
console.log(JSON.stringify({terminal:'PASS_STAGED',planFile,helperFiles:closure.size,backend,gateway,host,nativeProviderUnchanged:true}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))stageWorkspaceHome();
