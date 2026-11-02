import type {Http,HttpResponse} from './couch-client';
/** requestUrl has no portable cancellation API. Late writes remain safe through
 * revision preconditions; a retry cannot overwrite a later accepted change. */
export function withTimeout(http:Http,milliseconds=15000):Http {
  return async(url,method,headers,body,responseType)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      return await Promise.race([
        http(url,method,headers,body,responseType),
        new Promise<HttpResponse>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Request timed out')),milliseconds);})
      ]);
    }finally{if(timer!==undefined)clearTimeout(timer);}
  };
}
