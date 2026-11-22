// Dedicated inherited pipe is authenticated inside the native Node-API module.
// Environment values locate installed artifacts/handles; they cannot assert trust.
import {createRequire} from 'node:module';
import {connect, type Socket} from 'node:net';
import {isAbsolute} from 'node:path';
import {consumeOriginalIssuerSharedStream} from './external-original-issuer-private-bundle';
type OwnerHost=Parameters<typeof consumeOriginalIssuerSharedStream>[0];
type NativeBootstrap={open(handle:number):unknown;poll(capability:unknown):string|null;close(capability:unknown):void};

export function startRegisteredOriginalIssuerBootstrap(host:OwnerHost, installedAddon:string, inheritedHandle:string) {
 if(process.platform!=='win32'||!isAbsolute(installedAddon)||!/^\d{1,15}$/.test(inheritedHandle))
  throw Error('original_issuer_bootstrap_registered_arguments_required');
 const handle=Number(inheritedHandle);
 if(!Number.isSafeInteger(handle)||handle<1)throw Error('original_issuer_bootstrap_handle_invalid');
 const native=createRequire(import.meta.url)(installedAddon) as NativeBootstrap;
 const capability=native.open(handle); // OS parent/server/lifetime/token check; throws before reading.
 const active=new Map<string,{socket:Socket;controller:AbortController;release?:()=>void}>();
 let stopped=false;
 const stop=()=>{
  if(stopped)return;stopped=true;clearInterval(timer);
  native.close(capability);
  // Abort retires only these exact connections. No shared process termination,
  // pending settlement, automatic reconnect or quota/UNKNOWN mutation.
  for(const value of active.values()){value.controller.abort();value.release?.();value.socket.destroy();}
  active.clear();
 };
 const timer=setInterval(()=>{
  if(stopped)return;
  try{
   const route=native.poll(capability);if(route===null)return;
   const [runtimeId,path]=route.split('\n');
   const socket=connect(path);const controller=new AbortController();
   const deadline=setTimeout(()=>socket.destroy(),5000);
   const entry={socket,controller,release:undefined as (()=>void)|undefined};active.set(runtimeId,entry);
   const failed=()=>{clearTimeout(deadline);controller.abort();entry.release?.();active.delete(runtimeId);};
   socket.on('error',failed);socket.once('close',failed);
   socket.once('connect',()=>{
    clearTimeout(deadline);
    // The OS-authenticated launcher supplied this exact original-owner route.
    // Native authenticates this shared Bun against its transferred exact HANDLE.
    void consumeOriginalIssuerSharedStream(host,socket,runtimeId,controller.signal)
     .then(carrier=>{entry.release=carrier.release;if(controller.signal.aborted)carrier.release();})
     .catch(()=>{failed();socket.destroy();});
   });
  }catch{stop();}
 },25);
 timer.unref();
 return {stop};
}
