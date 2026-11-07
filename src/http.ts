import type {Http,HttpResponse} from './couch-client';
export class PendingRequestFailure extends Error {}
/** requestUrl has no portable cancellation API. Late writes remain safe through
 * revision preconditions; a retry cannot overwrite a later accepted change. */
export function withTimeout(http:Http,milliseconds=15000):Http {
  const pending=new Set<string>();
  return async(url,method,headers,body,responseType)=>{
    const identity=method+' '+url;
    // Timeout does not cancel native HTTP. Do not accumulate duplicate native
    // requests/bodies while a timed-out request is still alive.
    if(pending.has(identity))throw new PendingRequestFailure('Previous request is still pending');
    pending.add(identity);
    const request=Promise.resolve().then(()=>http(url,method,headers,body,responseType))
      .finally(()=>pending.delete(identity));
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      return await Promise.race([
        request,
        new Promise<HttpResponse>((_resolve,reject)=>{timer=setTimeout(()=>reject(new PendingRequestFailure('Request timed out')),milliseconds);})
      ]);
    }finally{if(timer!==undefined)clearTimeout(timer);}
  };
}
