import { runWorkspaceSnapshotCommand } from './command.mjs';
import fs from 'node:fs';
import path from 'node:path';

// Bundle only the public snapshot engine for the private Native runtime.
try {
  const [group,command,...args]=process.argv.slice(2);
  if(group!=='workspace' || command!=='snapshot')throw new Error('This runtime supports only workspace snapshot');
  let nativeAclHelper;
  if(process.platform==='win32') {
    const directory=path.dirname(path.resolve(process.argv[1]));
    const receipt=path.join(directory,'aicc-owner-acl.json');
    if(fs.existsSync(receipt)) {
      const stat=fs.lstatSync(receipt);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw new Error('native ACL receipt unsafe');
      const record=JSON.parse(fs.readFileSync(receipt,'utf8'));
      if(record.schemaVersion!==1||record.policy!=='process-owner-and-system-v1')throw new Error('native ACL policy mismatch');
      nativeAclHelper={executable:path.join(directory,'aicc-owner-acl.exe'),sha256:record.sha256};
    }
  }
  process.stdout.write(`${JSON.stringify(runWorkspaceSnapshotCommand(args,{nativeAclHelper}),null,2)}\n`);
}catch(error){process.stderr.write(`aicc snapshot: ${error.message}\n`);process.exitCode=1;}
