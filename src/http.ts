import type {Http,HttpResponse} from './couch-client';
export class PendingRequestFailure extends Error {}
/** requestUrl has no portable cancellation API. Late writes remain safe through
 * revision preconditions; a retry cannot overwrite a later accepted change. */
export function withTimeout(http:Http,milliseconds=15000):Http {
  const pending=new Set<string>();
  let chunks=0,controls=0,bytesHeld=0;
  const assertChunkAvailable=()=>{if(chunks>=1)throw new PendingRequestFailure('Previous attachment request is still pending');};
  const wrapped:Http=async(url,method,headers,body,responseType)=>{
    let key='';
    if(url.includes('/_all_docs')&&typeof body==='string'&&body.length<16384) {
      try {key=JSON.stringify(JSON.parse(body).keys??[]);}catch{/* Normal transport validation handles malformed JSON. */}
    }
    const chunk=/\/c5%3[aA]/.test(url)||key.includes('"c5:');
    if(chunk)assertChunkAvailable();else if(controls>=2)throw new PendingRequestFailure('Previous control requests are still pending');
    const held=typeof body==='string'?body.length*2:body?.byteLength??0;
    if(held>1024*1024)throw new Error('Request exceeds the bounded transport budget');
    const identity=method+' '+url+' '+key;
    // Timeout does not cancel native HTTP. Do not accumulate duplicate native
    // requests/bodies while a timed-out request is still alive.
    if(pending.has(identity))throw new PendingRequestFailure('Previous request is still pending');
    pending.add(identity);
    if(chunk)chunks++;else controls++;bytesHeld+=held;
    const request=Promise.resolve().then(()=>http(url,method,headers,body,responseType))
      .finally(()=>{pending.delete(identity);if(chunk)chunks--;else controls--;bytesHeld-=held;});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      return await Promise.race([
        request,
        new Promise<HttpResponse>((_resolve,reject)=>{timer=setTimeout(()=>reject(new PendingRequestFailure('Request timed out')),milliseconds);})
      ]);
    }finally{if(timer!==undefined)clearTimeout(timer);}
  };
  return Object.assign(wrapped,{assertChunkAvailable,usage:()=>({chunks,controls,bytesHeld})});
}
