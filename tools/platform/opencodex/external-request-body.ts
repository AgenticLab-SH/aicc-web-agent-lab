// AICC owns wire decoding; the pinned supplier always receives plain JSON.
import { Readable } from 'node:stream';
import { createZstdDecompress, constants } from 'node:zlib';

export class ExternalRequestBodyError extends Error {
  constructor(public code:string,public status:number) { super(code); }
}
export async function readExternalRequestJson(request:Request,limit=32*1024*1024):Promise<any> {
  if(!request.body) throw new ExternalRequestBodyError('request_body_required',400);
  const encoding=(request.headers.get('content-encoding')??'identity').trim().toLowerCase();
  if(!['identity','zstd'].includes(encoding)) throw new ExternalRequestBodyError('request_encoding_not_supported',415);
  const reader=request.body.getReader();
  let inputBytes=0,outputBytes=0;
  const chunks:Buffer[]=[];
  async function* input() {
    try {
      for(;;) {
        request.signal.throwIfAborted();
        const row=await reader.read();
        if(row.done) break;
        inputBytes+=row.value.byteLength;
        if(inputBytes>limit) throw new ExternalRequestBodyError('request_body_limit',413);
        yield row.value;
      }
    } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
  }
  const source=Readable.from(input());
  const decoder=encoding==='zstd'
    ? createZstdDecompress({chunkSize:64*1024,params:{[constants.ZSTD_d_windowLogMax]:25}}) : undefined;
  const output=decoder ? source.pipe(decoder) : source;
  const fail=(error:Error)=>output.destroy(error);
  source.on('error',fail);
  const abort=()=>output.destroy(new ExternalRequestBodyError('request_cancelled',499));
  request.signal.addEventListener('abort',abort,{once:true});
  try {
    if(request.signal.aborted) abort();
    for await(const chunk of output) {
      outputBytes+=chunk.byteLength;
      if(outputBytes>limit) throw new ExternalRequestBodyError('request_body_limit',413);
      chunks.push(Buffer.from(chunk));
    }
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,outputBytes)));
    if(!value || typeof value!=='object' || Array.isArray(value)) throw new ExternalRequestBodyError('request_body_invalid',400);
    return value;
  } catch(error) {
    if(error instanceof ExternalRequestBodyError) throw error;
    throw new ExternalRequestBodyError('request_body_invalid',400);
  } finally {
    request.signal.removeEventListener('abort',abort);
    source.destroy();decoder?.destroy();
  }
}
