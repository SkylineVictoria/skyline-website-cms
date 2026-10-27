import http from 'node:http';
import {spawn} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {verify,anon,service} from './native-lab.mjs';
const t=await verify();await mkdir('tmp/phase2-native/empty',{recursive:true});await writeFile('tmp/phase2-native/provider.json','{"mode":"success"}');await writeFile('tmp/phase2-native/azure.json','{"mode":"success"}');await writeFile('tmp/phase2-native/postmark.json','{"mode":"success"}');
const children=[];
const funcs={'portal-document-extract':55432,'portal-document-delete':55433,'public-assistant':55434,'public-assistant-index':55435,'cms-admin-users':55436,'portal-admin-users':55437,'portal-document-extract-azure':55438,'notification-delivery':55439,'notification-delivery-disabled':55440};
const gateway=http.createServer(async(req,res)=>{
 const origin=req.headers.origin; if(origin && /^http:\/\/(?:127\.0\.0\.1|[a-z0-9-]+\.localhost):55430$/.test(origin)) res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Headers','authorization,apikey,content-type,x-client-info,x-upsert,x-worker-secret,prefer,range,x-supabase-api-version,x-tenant-domain');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');res.setHeader('Access-Control-Expose-Headers','content-range');
 if(req.method==='OPTIONS'){res.writeHead(200);return res.end();}
 const match=req.url.match(/^\/(auth|rest|storage|functions)\/v1(\/.*)?$/);if(!match){res.writeHead(404);return res.end();}
 const parts=[];for await(const chunk of req){parts.push(chunk);if(parts.reduce((n,b)=>n+b.length,0)>10*1024*1024){res.writeHead(413);return res.end();}}
 const body=Buffer.concat(parts);
 if(match[1]==='functions'){
  const fn=match[2]?.split('/')[1],port=funcs[fn];if(!port){res.writeHead(404);return res.end();}const rest=match[2].split('/').slice(2).join('/');
  try{const response=await fetch(`http://127.0.0.1:${port}/${rest}`,{method:req.method,headers:{...req.headers,host:`127.0.0.1:${port}`},body:['GET','HEAD'].includes(req.method)?undefined:body});res.writeHead(response.status,{'Content-Type':'application/json'});return res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(502);return res.end('{"error":"Native handler unavailable"}');}
 }
 const port={auth:9999,rest:3000,storage:5000}[match[1]];
 const args=['--context','desktop-linux','exec','-i',t.container_id,'curl','-sS','--max-time','30','--include','--request',req.method];
 for(const [key,value]of Object.entries(req.headers))if(!['host','connection','content-length','accept-encoding'].includes(key))args.push('--header',`${key}: ${value}`);
 if(body.length)args.push('--data-binary','@-');args.push(`http://127.0.0.1:${port}${match[2]||'/'}`);
 const proc=spawn('docker',args,{windowsHide:true,env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,USERPROFILE:process.env.USERPROFILE}});const output=[];proc.stdout.on('data',c=>output.push(c));proc.stderr.resume();proc.stdin.on('error',()=>{});proc.stdin.end(body);
 proc.on('close',code=>{if(code){res.writeHead(502);return res.end('{"error":"Fixture transport failed"}');}let buf=Buffer.concat(output);while(buf.subarray(0,25).toString().startsWith('HTTP/1.1 100'))buf=buf.subarray(buf.indexOf('\r\n\r\n')+4);const boundary=buf.indexOf('\r\n\r\n');const lines=buf.subarray(0,boundary).toString().split('\r\n');const status=Number(lines.shift()?.split(' ')[1])||502;for(const line of lines){const i=line.indexOf(':');const k=line.slice(0,i).toLowerCase();if(['content-type','content-range','location'].includes(k))res.setHeader(k,line.slice(i+1).trim());}res.writeHead(status);res.end(buf.subarray(boundary+4));});
});
await new Promise(r=>gateway.listen(55431,'127.0.0.1',r));
for(const [fn,port]of Object.entries(funcs)){
 const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,USERPROFILE:process.env.USERPROFILE,LOCALAPPDATA:process.env.LOCALAPPDATA,SUPABASE_URL:'http://127.0.0.1:55431',SUPABASE_ANON_KEY:anon,SUPABASE_SERVICE_ROLE_KEY:service,OPENAI_API_KEY:'local-test-openai-key',OPENAI_DOCUMENT_MODEL:'synthetic-model',DOCUMENT_EXTRACTION_WORKER_SECRET:'native-worker-only',PUBLIC_ASSISTANT_WORKER_SECRET:'native-index-only',PUBLIC_ASSISTANT_ENABLE_GENERATION:'false',...(fn==='notification-delivery'?{EF_NOTIFICATION_EMAIL_ENABLED:'true',EF_POSTMARK_SERVER_TOKEN:'native-postmark-token'}:{}),...(fn==='notification-delivery-disabled'?{EF_POSTMARK_SERVER_TOKEN:'native-postmark-token'}:{}),...(fn.endsWith('-azure')?{EF_DOCUMENT_EXTRACTION_PROVIDER:'azure',EF_AZURE_DOCUMENT_ENDPOINT:'https://skyline-lab.cognitiveservices.azure.com',EF_AZURE_DOCUMENT_API_KEY:'native-azure-fixture-key',EF_AZURE_DOCUMENT_MODEL:'prebuilt-idDocument'}:{})};
 const child=spawn('deno',['run','--cached-only','--lock=scripts/lab/native-edge.lock','--frozen','--node-modules-dir=none','--allow-net=127.0.0.1:55431,127.0.0.1:'+port,'--allow-env','--allow-read=tmp/phase2-native,supabase/functions','--allow-write=tmp/phase2-native','scripts/lab/native-edge-entry.ts',fn,String(port),fn.replace(/-(azure|disabled)$/,'')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.on('data',b=>process.stdout.write(`${fn}: ${b}`));child.stderr.on('data',b=>process.stderr.write(`${fn}: ${b}`));
}
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_PUBLIC_SUPABASE_URL='http://127.0.0.1:55431';process.env.VITE_PUBLIC_SUPABASE_ANON_KEY=anon;
const vite=await createServer({envDir:'tmp/phase2-native/empty',server:{host:'127.0.0.1',port:55430,strictPort:true}});await vite.listen();console.log('Native fixture gateway :55431 and actual Vite app :55430 listening on loopback only.');
async function close(){for(const child of children)child.kill();await vite.close();gateway.close();process.exit(0)}process.on('SIGINT',close);process.on('SIGTERM',close);


