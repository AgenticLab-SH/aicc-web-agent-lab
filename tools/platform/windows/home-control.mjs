import {initializeRuntimeLayout,runtimeHomeStatus} from '../../../src/runtime-layout.mjs';
const action=process.argv[2]||'status';
if(!['init','status'].includes(action))throw Error('aicc home init|status [--json]');
const result=action==='init'?initializeRuntimeLayout():runtimeHomeStatus();
console.log(process.argv.includes('--json')?JSON.stringify(result,null,2):`AICC home: ${result.root}`);
