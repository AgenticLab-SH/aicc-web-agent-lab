import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {resolveWindowsPwsh} from '../src/lib/windows-pwsh.mjs';
import {validateSharedProxySocket} from '../src/adapters/codex-app-server-proxy.mjs';
import {protectWindowsOwnerOnlyPath} from '../src/lib/windows-owner-only-acl.mjs';
test('Windows proxy rejects regular files even under a protected owner directory', {skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-proxy-win-'));
 protectWindowsOwnerOnlyPath(root,{directory:true});
 const file=path.join(root,'control.sock');fs.writeFileSync(file,'not a socket');
 try {assert.throws(()=>validateSharedProxySocket(file),/socket_type_or_owner_unproven/);}
 finally {fs.unlinkSync(file);fs.rmdirSync(root);}
});
test('Windows proxy rejects parent ACL without changing it', {skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-proxy-acl-'));
 const file=path.join(root,'control.sock');fs.writeFileSync(file,'not a socket');
 try {assert.throws(()=>validateSharedProxySocket(file),e=>e.code==='windows_owner_only_acl_required');}
 finally {fs.unlinkSync(file);fs.rmdirSync(root);}
});
test('Windows proxy accepts a real AF_UNIX endpoint with protected owner ACL', {skip:process.platform!=='win32'},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-proxy-socket-'));
 protectWindowsOwnerOnlyPath(root,{directory:true});
 const file=path.join(root,'control.sock');
 const child=spawn(resolveWindowsPwsh(),['-NoProfile','-NonInteractive','-Command',String.raw`
$ErrorActionPreference='Stop'
$s=[Net.Sockets.Socket]::new([Net.Sockets.AddressFamily]::Unix,[Net.Sockets.SocketType]::Stream,[Net.Sockets.ProtocolType]::Unspecified)
try {$s.Bind([Net.Sockets.UnixDomainSocketEndPoint]::new($env:AICC_TEST_SOCKET));$s.Listen(1);[Console]::Out.WriteLine('READY');$null=[Console]::In.ReadLine()} finally {$s.Dispose()}
`],{windowsHide:true,env:{...process.env,AICC_TEST_SOCKET:file},stdio:['pipe','pipe','pipe']});
 let output='',errors='';child.stderr.on('data',b=>errors+=b);
 try {
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('socket_fixture_timeout:'+errors)),10000);
   child.once('exit',code=>{clearTimeout(timer);reject(Error('socket_fixture_exit:'+code+':'+errors));});
   child.stdout.on('data',b=>{output+=b;if(output.includes('READY')){clearTimeout(timer);resolve();}});
  });
  assert.equal(validateSharedProxySocket(file),file);
 }finally{
  const exited=once(child,'exit');child.stdin.end('\n');await exited;
  // PowerShell removes only this exact fixture endpoint in its own shell.
  const cleanup=spawn(resolveWindowsPwsh(),['-NoProfile','-NonInteractive','-Command',"if(Test-Path -LiteralPath $env:AICC_TEST_SOCKET){Remove-Item -LiteralPath $env:AICC_TEST_SOCKET}; Remove-Item -LiteralPath $env:AICC_TEST_SOCKET_ROOT"],{windowsHide:true,env:{...process.env,AICC_TEST_SOCKET:file,AICC_TEST_SOCKET_ROOT:root}});
  await once(cleanup,'exit');
 }
});
