import { timingSafeEqual } from 'node:crypto';
export function externalTokenMatches(request:Request,token:string,management=false):boolean {
  if(!token) return false;
  const bearer=request.headers.get('authorization');
  // An explicit invalid Bearer must never fall through to another credential.
  const actual=bearer!==null ? bearer : management ? 'Bearer '+(request.headers.get('x-opencodex-api-key')??'') : '';
  const a=Buffer.from(actual),b=Buffer.from('Bearer '+token);
  return a.length===b.length && timingSafeEqual(a,b);
}
