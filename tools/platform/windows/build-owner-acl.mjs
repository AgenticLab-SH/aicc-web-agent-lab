import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if(process.platform!=='win32')throw new Error('Windows compiler required');
const output=path.resolve(process.argv[2]??'');
if(!process.argv[2]||!path.isAbsolute(process.argv[2]))throw new Error('Exact output directory required');
if(fs.existsSync(output)&&fs.lstatSync(output).isSymbolicLink())throw new Error('Linked output refused');
fs.mkdirSync(output,{recursive:true});
const executable=path.join(output,'aicc-owner-acl.exe'),receipt=path.join(output,'aicc-owner-acl.json');
if(fs.existsSync(executable)||fs.existsSync(receipt))throw new Error('Use fresh output');
const source=fileURLToPath(new URL('./OwnerOnlyAcl.cs',import.meta.url));
const compiler=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const result=spawnSync(compiler,['/nologo','/optimize+','/target:exe',`/out:${executable}`,source],{encoding:'utf8',windowsHide:true,timeout:30_000});
if(result.error||result.status!==0)throw new Error('Native ACL helper compilation failed');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.writeFileSync(receipt,JSON.stringify({schemaVersion:1,policy:'process-owner-and-system-v1',sha256:digest(executable),sourceSha256:digest(source)}),{flag:'wx'});
