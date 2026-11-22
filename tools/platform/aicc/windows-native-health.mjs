import { windowsHealthDoctor, windowsHealthRepair, printWindowsHealth } from '../../../src/windows-health-repair.mjs';
const [command,...args]=process.argv.slice(2);
if(!['doctor','repair'].includes(command)||args.some(arg=>!['--json','--background','--sandbox'].includes(arg)))throw new Error('doctor|repair [--json] [--background] [--sandbox]');
if(command==='doctor'&&args.some(arg=>arg!=='--json'))throw new Error('doctor accepts only --json');
const result=command==='doctor'?await windowsHealthDoctor():await windowsHealthRepair({background:args.includes('--background'),forceSandbox:args.includes('--sandbox')});
printWindowsHealth(result,args.includes('--json'));
if(result.ok===false)process.exitCode=1;
