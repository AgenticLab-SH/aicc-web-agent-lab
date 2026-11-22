import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const script=fs.readFileSync(path.join(root,'tools/platform/opencodex/Open-AiccOcxDashboard.ps1'),'utf8');

test('OCX account dashboard opens the registered A1 hub, not local inference GUI',()=>{
  assert.match(script,/\$target='http:\/\/localhost:10102'/);
  assert.match(script,/runtimeRole -cne 'client'/);
  assert.match(script,/managementTransport -cne 'relay'/);
  assert.match(script,/client\.managementUrl -cne \$target/);
  assert.match(script,/Get-NetTCPConnection.*10102 -State Listen/);
  assert.match(script,/HostKeyAlias=aicc-oracle-a1/);
  assert.match(script,/opencodex-runtime-role.*content="hub"/);
  assert.match(script,/Start-Process -FilePath \$browser -ArgumentList '--new-tab',\$target/);
  assert.doesNotMatch(script,/Start-Process.*10100/);
});

test('dashboard preflight never opens a browser or triggers an OCX repair',()=>{
  assert.match(script,/param\(\[switch\]\$CheckOnly\)/);
  assert.match(script,/if\(\$CheckOnly\)\s*\{/);
  assert.match(script,/opensBrowser=\$false/);
  assert.doesNotMatch(script,/Invoke-AiccLocalOcx\.ps1/);
  assert.doesNotMatch(script,/requestBoundGuiPairingGrant|pair --origin/);
  assert.match(script,/throw 'Port 10102 is not owned by the registered A1 management tunnel\.'/);
});
