// The official connected-machine listener owns GUI sessions and CSRF. It has
// no inference routes: all model traffic stays on the AICC admission boundary.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function startOfficialManagement(packageRoot:string,connectionFile:string) {
  const root=realpathSync(packageRoot);
  const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  if(pkg.name!=='@bitkyc08/opencodex' || !['2.81.0','2.96.0'].includes(pkg.version)) throw Error('management_supplier_identity_invalid');
  const saved=JSON.parse(readFileSync(connectionFile,'utf8'));
  const connection=saved.client;
  if(saved.runtimeRole!=='client' || connection?.serverUrl!=='http://localhost:10101'
    || connection.managementUrl!=='http://localhost:10102' || connection.managementTransport!=='relay'
    || connection.protocolVersion!==1 || !Array.isArray(connection.selectedClients)
    || typeof connection.apiKeyId!=='string' || typeof connection.tokenFingerprint!=='string') {
    throw Error('existing_management_connection_required');
  }
  const stock=await import(pathToFileURL(join(root,'src/client/machine-listener.ts')).href);
  // This production entry point accepts an already resolved connection. It does
  // not call connect/sync, start Native, or create a stored account/auth pool.
  const listener=stock.startMachineListener(0,{state:connection});
  return {
    port:listener.port,
    stop:()=>listener.stop(true),
    async handle(request:Request):Promise<Response> {
      const target=new URL(request.url);
      const originalHost=target.host;
      target.hostname='127.0.0.1';target.port=String(listener.port);
      const headers=new Headers(request.headers);
      // Bun uses Host for its request URL. Preserve the actual public origin so
      // the official session and CSRF checks remain bound to the browser origin.
      headers.set('host',originalHost);
      const response=await fetch(target,{method:request.method,headers,
        body:['GET','HEAD'].includes(request.method)?undefined:request.body,
        signal:request.signal,redirect:'manual'});
      if(response.status>=300 && response.status<400) {
        await response.body?.cancel();
        return Response.json({error:'management_redirect_refused'},{status:502});
      }
      return response;
    },
  };
}
