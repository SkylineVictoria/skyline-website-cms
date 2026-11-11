/** Provider responses never enter logs or browser responses. Only read-only health probes. */
export async function testProvider(connector: string, secret: string, timeout: number, retries: number, request: typeof fetch = fetch, docusignProduction=false): Promise<{ ok: boolean; code: string; attempts: number }> {
  const urls: Record<string,string> = { stripe: 'https://api.stripe.com/v1/account', calendly: 'https://api.calendly.com/users/me', xero:'https://api.xero.com/connections', microsoft365:'https://graph.microsoft.com/v1.0/me?$select=id', docusign:`https://${docusignProduction?'account.docusign.com':'account-d.docusign.com'}/oauth/userinfo` };
  if (!urls[connector]) return { ok:false,code:'adapter_not_available',attempts:1 };
  if (!secret) return { ok:false,code:'credentials_missing',attempts:1 };
  for(let attempt=1;attempt<=retries+1;attempt++) {
    try {
      const response=await request(urls[connector],{headers:{Authorization:`Bearer ${secret}`,Accept:'application/json'},signal:AbortSignal.timeout(timeout*1000),redirect:'error'});
      await response.body?.cancel();
      if(response.ok) return {ok:true,code:'connection_verified',attempts:attempt};
      if(response.status===401||response.status===403) return {ok:false,code:'credentials_rejected',attempts:attempt};
      if(attempt>retries || (response.status!==429 && response.status<500)) return {ok:false,code:'provider_unavailable',attempts:attempt};
    } catch { if(attempt>retries) return {ok:false,code:'provider_unreachable',attempts:attempt}; }
    await new Promise(resolve=>setTimeout(resolve,250*2**(attempt-1)));
  }
  return {ok:false,code:'provider_unavailable',attempts:retries+1};
}
