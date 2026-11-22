import {initializeRemoteAuth} from './src/aicc-local-auth';
if(process.env.AICC_OCX_LOCAL_AUTH!=='1')throw Error('local_auth_owner_required');
await initializeRemoteAuth();
await import('./src/cli/index');
