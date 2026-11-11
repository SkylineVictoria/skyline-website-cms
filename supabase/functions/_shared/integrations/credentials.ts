import { oauthConfig,refreshToken,type OAuthToken } from './oauth.ts';
type Rpc = (name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:unknown}>;
/** Internal server-only accessor. Serialized refresh and version fencing prevent stale writes after revoke/disable. */
export async function accessToken(connection:{id:string;connector_id:string;updated_at:string},rpc:Rpc,env:(key:string)=>string|undefined,request:typeof fetch=fetch):Promise<{token:string;version:string}> {
 const saved=await rpc('integration_credential_read',{p_connection:connection.id,p_kind:'api_key'});
 if(saved.error)throw Error('credential_store_unavailable');
 if(!saved.data)return {token:'',version:connection.updated_at};
 if(!['xero','microsoft365','docusign'].includes(connection.connector_id))return {token:String(saved.data),version:connection.updated_at};
 let token:OAuthToken;try{token=JSON.parse(String(saved.data));}catch{throw Error('oauth_reconnect_required');}
 if(typeof token.access_token!=='string'||!Number.isFinite(token.expires_at))throw Error('oauth_reconnect_required');
 if(token.expires_at>Date.now()+60000)return {token:token.access_token,version:connection.updated_at};
 const config=oauthConfig(connection.connector_id,env);
 const claim=await rpc('integration_refresh_claim',{p_connection:connection.id,p_version:connection.updated_at});
 if(claim.error||typeof claim.data!=='string')throw Error('oauth_refresh_busy');
 try{
  const next=await refreshToken(config,token,request);
  const finished=await rpc('integration_refresh_finish',{p_connection:connection.id,p_lease:claim.data,p_secret:JSON.stringify(next)});
  if(finished.error||typeof finished.data!=='string')throw Error('connection_changed');
  return {token:next.access_token,version:finished.data};
 }catch(error){await rpc('integration_refresh_finish',{p_connection:connection.id,p_lease:claim.data,p_secret:null});throw error;}
}
