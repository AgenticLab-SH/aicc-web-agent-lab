import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Exercise the real PowerShell websocket function against a loopback-only CDP fixture.
const source=fileURLToPath(new URL('../tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1',import.meta.url));
const ps=process.env.AICC_TEST_PWSH || 'pwsh.exe';
function frame(value,{fin=true,opcode=1}={}) {
  const bytes=Buffer.from(value),header=Buffer.alloc(bytes.length<126?2:4);
  header[0]=(fin?128:0)|opcode;
  if(bytes.length<126)header[1]=bytes.length;else{header[1]=126;header.writeUInt16BE(bytes.length,2);}
  return Buffer.concat([header,bytes]);
}
test('CDP reply deadlines accept slow identity replies and bound event streams without retry', {skip:process.platform!=='win32',timeout:30000},async()=>{
  const sockets=new Set(),timers=new Set();let connections=0;
  const schedule=(fn,ms)=>{const id=setTimeout(()=>{timers.delete(id);fn();},ms);timers.add(id);};
  const server=http.createServer();
  server.on('upgrade',(req,socket)=>{
    connections++;sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    let buffer=Buffer.alloc(0),handled=false;
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);if(handled||buffer.length<6)return;
      let length=buffer[1]&127,offset=2;if(length===126){if(buffer.length<8)return;length=buffer.readUInt16BE(2);offset=4;}
      if(length===127||buffer.length<offset+4+length)return;
      handled=true;const mask=buffer.subarray(offset,offset+4),body=Buffer.from(buffer.subarray(offset+4,offset+4+length));
      for(let i=0;i<body.length;i++)body[i]^=mask[i%4];
      const command=JSON.parse(body),reply=JSON.stringify({id:command.id,result:{verified:true}});
      const write=bytes=>{if(!socket.destroyed)socket.write(bytes);};
      if(req.url==='/slow')schedule(()=>{write(frame(reply.slice(0,12),{fin:false}));write(frame(reply.slice(12),{opcode:0}));},6000);
      else if(req.url==='/events')for(let i=0;i<20;i++)schedule(()=>write(frame(JSON.stringify({method:'fixture.event'}))),i*150);
      else if(req.url==='/error')write(frame(JSON.stringify({id:command.id,error:{code:-1,message:'fixture rejected'}})));
      else write(frame(reply));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-cdp-deadline-')),script=path.join(dir,'probe.ps1');
  fs.writeFileSync(script,`param($Source,$SocketUrl,[int]$Seconds)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Parse failed'}
$fn=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-CdpBrowserCommand'},$true))
if($fn.Count -ne 1){throw 'Exact command function required'}
Invoke-Expression $fn[0].Extent.Text
$argsMap=@{Endpoint='unused';TargetWebSocket=$SocketUrl;Method='Runtime.evaluate';Params=@{expression='fixture'}}
if($Seconds){$argsMap.ResponseTimeoutSec=$Seconds}
Invoke-CdpBrowserCommand @argsMap|ConvertTo-Json -Compress
`);
  const probe=(route,seconds)=>new Promise((resolve,reject)=>{
    const start=Date.now(),child=spawn(ps,['-NoProfile','-File',script,'-Source',source,'-SocketUrl',`ws://127.0.0.1:${server.address().port}/${route}`,'-Seconds',String(seconds)],{windowsHide:true});
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);
    child.on('close',code=>resolve({code,stdout,stderr,elapsed:Date.now()-start}));
  });
  try {
    const fast=await probe('fast',0);assert.equal(fast.code,0,fast.stderr);assert.equal(JSON.parse(fast.stdout).verified,true);
    const slow=await probe('slow',8);assert.equal(slow.code,0,slow.stderr);assert.equal(JSON.parse(slow.stdout).verified,true);
    const events=await probe('events',1);assert.notEqual(events.code,0);assert.ok(events.elapsed<6000,'events must not renew the deadline');
    const error=await probe('error',2);assert.notEqual(error.code,0);assert.match(error.stderr,/fixture rejected/);
    assert.equal(connections,4,'each command connects once; no replay');
  } finally {
    for(const timer of timers)clearTimeout(timer);for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>server.close(resolve));fs.rmSync(script);fs.rmdirSync(dir);
  }
});
