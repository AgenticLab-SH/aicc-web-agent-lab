// AICC owns turn admission/lifetime; the pinned supplier owns Responses framing.
export function createExternalResponseSocket(stock:any,boundary:any) {
  const sockets=new Set<any>();
  function error(socket:any,code:string) {
    socket.send(JSON.stringify({type:'error',error:{code},headers:{'x-should-retry':'false'}}));
  }
  return {sockets,
    closeIdle(){for(const socket of sockets)if(!socket.data.busy)socket.close(1001,'maintenance');},
    handlers:{
      maxPayloadLength:32*1024*1024,backpressureLimit:4*1024*1024,closeOnBackpressureLimit:true,
      open(socket:any){sockets.add(socket);},
      async message(socket:any,message:any){
        let payload:any;
        try{payload=JSON.parse(typeof message==='string'?message:new TextDecoder().decode(message));}
        catch{error(socket,'invalid_json');return;}
        if(!payload || typeof payload!=='object' || Array.isArray(payload)){error(socket,'invalid_frame');return;}
        if(payload.type==='response.processed')return;
        if(payload.type==='response.cancel'){socket.data.controller?.abort(Error('client_cancelled'));return;}
        if(payload.type==='response.steer' || payload.type==='response.inject'){
          // Current registered configuration has neither feature enabled. Do
          // not pretend delivery or replay a control frame as a new model turn.
          error(socket,'native_control_not_enabled');return;
        }
        if(payload.type!=='response.create' || socket.data.busy || boundary.isDraining()){
          error(socket,socket.data.busy?'request_in_progress':'unsupported_or_draining');return;
        }
        if(payload.generate===false){
          for(const frame of stock.buildWarmupCompletionFrames(payload))socket.send(frame);
          return;
        }
        const {type,...body}=payload;body.stream=true;
        const turn=++socket.data.turnId,controller=new AbortController();
        socket.data.controller=controller;socket.data.busy=true;
        const current=()=>socket.readyState===1 && socket.data.turnId===turn && !controller.signal.aborted;
        try{
          const request=new Request(socket.data.url,{method:'POST',headers:socket.data.headers,
            body:JSON.stringify(body),signal:controller.signal});
          stock.markWebsocketRequest?.(request);
          const response=await boundary.handle(request);
          await stock.sendResponseToWebSocket(socket,response,current,{untilEof:false});
        }catch{if(current())error(socket,'external_websocket_turn_not_completed');}
        finally{
          if(socket.data.turnId===turn){socket.data.busy=false;socket.data.controller=undefined;}
          if(boundary.isDraining())socket.close(1001,'maintenance');
        }
      },
      close(socket:any){sockets.delete(socket);socket.data.controller?.abort(Error('client_closed'));},
    },
  };
}
