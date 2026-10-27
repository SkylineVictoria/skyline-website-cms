// Test-only runtime adapter: import production handlers unchanged in native Deno.
// Network permission independently restricts all I/O to the fixture gateway.
const [name, port] = Deno.args;
// A second instance of the extraction handler runs with the Azure provider selected (see server.mjs).
const handler = Deno.args[2] ?? name;
if (!['portal-document-extract','portal-document-delete','public-assistant','public-assistant-index','cms-admin-users','portal-admin-users','notification-delivery'].includes(handler)) throw Error('Unknown handler');
const realFetch = globalThis.fetch;
// Fake Azure Document Intelligence (lab only, never a network call): 202 + Operation-Location, a running poll,
// then success; modes come from tmp/phase2-native/azure.json and every request is logged for the test to inspect.
const AZURE_ORIGIN = 'https://skyline-lab.cognitiveservices.azure.com', AZURE_KEY = 'native-azure-fixture-key';
const azurePolls = new Map<string, number>();
const azureField = (type: string, key: string, value: string) => ({ type, [key]: value, content: value, confidence: 0.98, boundingRegions: [{ pageNumber: 1, polygon: [] }] });
// Fake Postmark (lab only): modes come from tmp/phase2-native/postmark.json; every request is logged for the test.
const PM_TOKEN = 'native-postmark-token';
async function fakePostmark(target: URL, init?: RequestInit): Promise<Response> {
 if (target.pathname !== '/email' || (init?.method ?? 'GET') !== 'POST') return new Response('{}', { status: 404 });
 const control = JSON.parse(await Deno.readTextFile('tmp/phase2-native/postmark.json'));
 const body = JSON.parse(String(init?.body ?? '{}'));
 await Deno.writeTextFile('tmp/phase2-native/postmark-calls.log', JSON.stringify({ token: new Headers(init?.headers).get('x-postmark-server-token') === PM_TOKEN, deliveryId: body.Metadata?.deliveryId, textOnly: body.HtmlBody === undefined, attachments: (body.Attachments ?? []).map((a: { Name: string; ContentType: string; Content: string }) => ({ name: a.Name, type: a.ContentType, pdf: atob(a.Content).startsWith('%PDF-1.4'), bytes: atob(a.Content).length })), link: String(body.TextBody ?? '').includes('/agency/applications/') }) + '\n', { append: true });
 if (new Headers(init?.headers).get('x-postmark-server-token') !== PM_TOKEN) return Response.json({ ErrorCode: 10, Message: 'Bad token' }, { status: 401 });
 if (control.mode === 'rate_limit') return new Response('{}', { status: 429 });
 if (control.mode === 'drop') throw new Error('socket closed');
 if (control.mode === 'inactive') return Response.json({ ErrorCode: 406, Message: 'Inactive recipient' }, { status: 422 });
 return Response.json({ ErrorCode: 0, Message: 'OK', MessageID: crypto.randomUUID(), To: body.To, SubmittedAt: new Date().toISOString() });
}
async function fakeAzure(target: URL, init?: RequestInit): Promise<Response> {
 const method = init?.method ?? 'GET';
 if (new Headers(init?.headers).get('ocp-apim-subscription-key') !== AZURE_KEY) return Response.json({ error: { code: 'Unauthorized' } }, { status: 401 });
 let control = JSON.parse(await Deno.readTextFile('tmp/phase2-native/azure.json'));
 const log = (line: string) => Deno.writeTextFile('tmp/phase2-native/azure-calls.log', line + '\n', { append: true });
 if (method === 'POST') {
  await log('POST');
  if (control.mode === 'rate_limit') return new Response('{}', { status: 429 });
  const id = crypto.randomUUID();
  azurePolls.set(id, 0);
  await log('ACCEPTED ' + id);
  return new Response(null, { status: 202, headers: { 'Operation-Location': `${AZURE_ORIGIN}${target.pathname.split(':')[0]}/analyzeResults/${id}?api-version=2024-11-30`, 'Retry-After': '2' } });
 }
 const id = target.pathname.split('/').pop()!;
 await log('GET ' + id);
 while (control.mode === 'hold') { await new Promise((r) => setTimeout(r, 100)); control = JSON.parse(await Deno.readTextFile('tmp/phase2-native/azure.json')); }
 if (control.mode === 'failed') return Response.json({ status: 'failed', error: { code: 'InternalServerError', message: 'Synthetic analysis failure' } });
 const polls = (azurePolls.get(id) ?? 0) + 1; azurePolls.set(id, polls);
 if (polls < 2) return Response.json({ status: 'running' }, { headers: { 'Retry-After': '2' } });
 return Response.json({ status: 'succeeded', analyzeResult: { apiVersion: '2024-11-30', modelId: 'prebuilt-idDocument', pages: [{ pageNumber: 1 }], documents: [{ docType: 'idDocument.passport', fields: {
  FirstName: azureField('string', 'valueString', 'Azure'), LastName: azureField('string', 'valueString', 'Fixture'), DateOfBirth: azureField('date', 'valueDate', '1999-04-05'),
  DocumentNumber: azureField('string', 'valueString', 'N1234567'), DateOfExpiration: azureField('date', 'valueDate', '2031-08-09') } }] } });
}
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
 const target = new URL(input instanceof Request ? input.url : String(input));
 if (target.origin === 'http://127.0.0.1:55431') return realFetch(input, init);
 if (target.origin === AZURE_ORIGIN) return fakeAzure(target, init);
 if (target.origin === 'https://api.postmarkapp.com') return fakePostmark(target, init);
 if (target.origin !== 'https://api.openai.com' || !['/v1/responses','/v1/embeddings'].includes(target.pathname)) throw Error('External network forbidden by fixture');
 let control = JSON.parse(await Deno.readTextFile('tmp/phase2-native/provider.json'));
 await Deno.writeTextFile('tmp/phase2-native/provider-entered.json',JSON.stringify({handler:name,path:target.pathname}));
 while(control.mode==='hold'){await new Promise(r=>setTimeout(r,100));control=JSON.parse(await Deno.readTextFile('tmp/phase2-native/provider.json'));}
 if(control.mode==='failure')return Response.json({error:{message:'Synthetic temporary failure'}},{status:503});
 if(target.pathname.endsWith('/embeddings'))return Response.json({data:[{embedding:Array.from({length:1536},(_,i)=>i===0?1:0)}],usage:{total_tokens:1}});
 const body=JSON.parse(String(init?.body||'{}'));
 if(body.input?.[0]?.content?.[0]?.text?.startsWith('Extract this public PDF'))return Response.json({id:'synthetic-public-document',output_text:JSON.stringify({pages:[{page:1,text:'Published synthetic public document with a fixture scholarship policy and clear eligibility information.',warnings:[]}]}),usage:{input_tokens:1,output_tokens:1}});
 const fields=body.text?.format?.schema?.properties?.fields?.properties;
 if(fields)return Response.json({id:'synthetic-response',output_text:JSON.stringify({document_type:'Passport',category_mismatch:false,fields:{...Object.fromEntries(Object.keys(fields).map(k=>[k,null])),first_name:'Native',last_name:'Fixture'},evidence:[]}),usage:{input_tokens:1,output_tokens:1}});
 return Response.json({id:'synthetic-rag',output_text:'Published fixture answer.',usage:{input_tokens:1,output_tokens:1}});
};
// Native Deno keeps serving while background promises run; hosted waitUntil lifecycle
// is not represented by this adapter and must not be claimed as a hosted runtime test.
Object.assign(globalThis,{EdgeRuntime:{waitUntil:(promise:Promise<unknown>)=>{promise.catch(()=>{});}}});
const serve=Deno.serve;
Deno.serve=((handler: Deno.ServeHandler)=>serve({hostname:'127.0.0.1',port:Number(port)},handler)) as typeof Deno.serve;
await import(`../../supabase/functions/${handler}/index.ts`);
