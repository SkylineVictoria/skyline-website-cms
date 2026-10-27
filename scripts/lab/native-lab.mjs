// Local-only native API fixture. Never reads .env, CLI credentials or hosted data.
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {docker,assertInspection,assertDatabaseIdentity,APPROVED_PROJECT,TEST_DATABASE} from './local-db.mjs';
const fresh=process.argv.includes('--fresh');
const sec18=process.argv.includes('--sec18');
const resume=process.argv.includes('--p02-resume');
const review=process.argv.includes('--p02-review');
const final=process.argv.includes('--p02-final');
const phase3=process.argv.includes('--p03');
const phase4=process.argv.includes('--p04');
const phase4Complete=process.argv.includes('--p04-complete');
const phase4Final=process.argv.includes('--p04-final');
const phase4Fresh=process.argv.includes('--p04-fresh')||phase4Final||phase4Complete;
const phase3Final=process.argv.includes('--p03-final');
const phase3Fresh=process.argv.includes('--p03-fresh')||phase3Final;
if([fresh,sec18,resume,review,final].filter(Boolean).length>1)throw Error('Choose exactly one disposable profile');
export const evidence='tmp/lab';
export const name=phase4Complete?'skyline-phase4-complete-20261025-db':phase4Final?'skyline-phase4-final-20261025-db':phase4Fresh?'skyline-phase4-clean-20261025-db':phase3Final?'skyline-phase3-final-20261025-db':phase3Fresh?'skyline-phase3-clean-20261025-db':final?'skyline-phase2-final-20261025-db':review?'skyline-phase2-clean-20261025-db':resume?'skyline-phase2-resume-20261025-db':sec18?'skyline-phase2-sec18-replay-db':fresh?'skyline-phase2-native-clean-db':'skyline-phase2-native-db';
if(phase3Fresh&&[fresh,sec18,resume,review,final,phase3].some(Boolean))throw Error('Choose only the Phase 3 clean profile');
export const secret='skyline-native-synthetic-jwt-secret-only-2026';
export const password='Native-fixture-only-2026!';
export function jwt(role){const b=[{alg:'HS256',typ:'JWT'},{role,iss:'supabase',exp:2000000000}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');return b+'.'+createHmac('sha256',secret).update(b).digest('base64url');}
export const anon=jwt('anon'),service=jwt('service_role');
async function inspect(){
 const c=JSON.parse(await docker(['inspect',name]))[0];
 if(c.Name!==`/${name}`)throw Error('Unexpected native database name');
 // Reuse all strict isolation checks, without broadening the original allowlist.
 assertInspection(JSON.parse(await docker(['context','inspect','desktop-linux']))[0],{...c,Name:'/skyline-phase2-db'});
 const identity=JSON.parse(await docker(['exec',c.Id,'psql','-X','-qAt','-U','postgres','-d',TEST_DATABASE,'-c',"begin read only; select json_build_object('database',current_database(),'role',current_user,'server_address',inet_server_addr(),'system_identifier',(select system_identifier::text from pg_control_system()),'vault_secret_count',(select count(*) from vault.secrets)); commit;"]));
 assertDatabaseIdentity(identity,identity.system_identifier);
 if(['7692130048193495360','7696855382484680741'].includes(identity.system_identifier))throw Error('Existing database forbidden');
 return {container_id:c.Id,system_identifier:identity.system_identifier,source_project:APPROVED_PROJECT,database:TEST_DATABASE,image:c.Config.Image,network:'none',storage:'tmpfs'};
}
export async function verify(){const expected=JSON.parse(await readFile(`${evidence}/identity.json`,'utf8'));const actual=await inspect();if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Native database identity changed');return actual;}
export async function sql(text,admin=false){const t=await verify();return docker(['exec','-i',t.container_id,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',admin?'supabase_admin':'postgres','-d',TEST_DATABASE],text);}
export async function startService(kind,image,env,tmpfs){const t=await verify();return docker(['run','-d','--name',`${name.slice(0,-3)}-${kind}`,'--network',`container:${t.container_id}`,'--label','skyline.phase2.disposable=true','--label',`skyline.source-project=${APPROVED_PROJECT}`,...(tmpfs?['--tmpfs',tmpfs]:[]),...Object.entries(env).flatMap(([k,v])=>['-e',`${k}=${v}`]),`public.ecr.aws/supabase/${image}`]);}
export async function request(path,{method='GET',body,token=anon,headers={}}={}){
 const t=await verify();const match=path.match(/^\/(auth|rest|storage)\/v1(\/.*)?$/);if(!match||path.includes('://'))throw Error('Local API path required');
 const port={auth:9999,rest:3000,storage:5000}[match[1]];
 const args=['exec','-i',t.container_id,'curl','--silent','--show-error','--max-time','15','--request',method,'--header',`Authorization: Bearer ${token}`,'--header',`apikey: ${anon}`,'--write-out','\n%{http_code}',...Object.entries({'Content-Type':'application/json',...headers}).flatMap(([k,v])=>['--header',`${k}: ${v}`])];
 if(body!==undefined)args.push('--data-binary','@-');args.push(`http://127.0.0.1:${port}${match[2]||'/'}`);
 const out=await docker(args,body===undefined?'':typeof body==='string'?body:JSON.stringify(body));const i=out.lastIndexOf('\n');const raw=out.slice(0,i);let data;try{data=JSON.parse(raw)}catch{data=raw}return {status:Number(out.slice(i+1)),data};
}
if(process.argv[1]?.endsWith('native-lab.mjs'))try{
 const cmd=process.argv.slice(2).find(a=>!['--fresh','--sec18','--p02-resume','--p02-review','--p02-final','--pre-resources','--p03','--p03-fresh','--p03-final','--p04','--p04-fresh','--p04-final','--p04-complete'].includes(a));await mkdir(evidence,{recursive:true});
 if(process.argv.includes('--pre-resources')&&!resume)throw Error('Bounded baseline replay requires the new resume profile');
 if(cmd==='create'){
  await docker(['run','-d','--name',name,'--network','none','--tmpfs','/var/lib/postgresql/data:rw,size=1073741824','--label','skyline.phase2.disposable=true','--label',`skyline.source-project=${APPROVED_PROJECT}`,'-e','POSTGRES_DB='+TEST_DATABASE,'-e','POSTGRES_PASSWORD=skyline-phase2-local-only','public.ecr.aws/supabase/postgres:17.11.0.003','postgres','-D','/var/lib/postgresql/data','-c','shared_preload_libraries=pg_cron,pg_net','-c','cron.database_name='+TEST_DATABASE]);
  for(let i=0;i<30;i++){try{await writeFile(`${evidence}/identity.json`,JSON.stringify(await inspect(),null,2)+'\n',{flag:'wx'});break;}catch(e){if(i===29)throw e;await new Promise(r=>setTimeout(r,1000));}}
  console.log('Created and pinned distinct network:none tmpfs database.');
 }else if(cmd==='services'){
  await sql("alter role supabase_auth_admin password 'native-auth-only'; alter role supabase_storage_admin password 'native-storage-only'; alter role authenticator password 'native-rest-only'; grant supabase_storage_admin to postgres; grant create on database skyline_phase2_test to postgres;",true);
  await startService('auth','gotrue:v2.197.0',{GOTRUE_API_HOST:'127.0.0.1',GOTRUE_API_PORT:'9999',API_EXTERNAL_URL:'http://127.0.0.1:55431/auth/v1',GOTRUE_DB_DRIVER:'postgres',GOTRUE_DB_DATABASE_URL:`postgres://supabase_auth_admin:native-auth-only@127.0.0.1:5432/${TEST_DATABASE}`,GOTRUE_SITE_URL:'http://127.0.0.1:55430',GOTRUE_DISABLE_SIGNUP:'true',GOTRUE_JWT_ADMIN_ROLES:'service_role',GOTRUE_JWT_AUD:'authenticated',GOTRUE_JWT_DEFAULT_GROUP_NAME:'authenticated',GOTRUE_JWT_SECRET:secret,GOTRUE_EXTERNAL_EMAIL_ENABLED:'true',GOTRUE_MAILER_AUTOCONFIRM:'true',GOTRUE_SMTP_HOST:'127.0.0.1',GOTRUE_SMTP_PORT:'1',GOTRUE_EXTERNAL_PHONE_ENABLED:'false'});
  await startService('rest','postgrest:v14.18',{PGRST_DB_URI:`postgres://authenticator:native-rest-only@127.0.0.1:5432/${TEST_DATABASE}`,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon',PGRST_JWT_SECRET:secret,PGRST_SERVER_PORT:'3000'});
  await startService('storage','storage-api:v1.80.2',{ANON_KEY:anon,SERVICE_KEY:service,POSTGREST_URL:'http://127.0.0.1:3000',AUTH_JWT_SECRET:secret,DATABASE_URL:`postgres://supabase_storage_admin:native-storage-only@127.0.0.1:5432/${TEST_DATABASE}`,FILE_SIZE_LIMIT:'52428800',STORAGE_BACKEND:'file',FILE_STORAGE_BACKEND_PATH:'/var/lib/storage',TENANT_ID:'native-fixture',REGION:'local',GLOBAL_S3_BUCKET:'native-fixture',ENABLE_IMAGE_TRANSFORMATION:'false'},'/var/lib/storage:rw,size=67108864');
  console.log('Started native Auth, REST and Storage sharing the network:none namespace.');
 }else if(cmd==='replay'){
  if((await sql("select count(*) from pg_tables where schemaname='public';")).trim()!=='0')throw Error('Requires empty public schema; no reset allowed');
  if((await request('/auth/v1/health')).status!==200||(await request('/storage/v1/status')).status!==200)throw Error('Native services not healthy');
  const bootstrap=(await readFile('scripts/lab/bootstrap.sql','utf8')).split('set role postgres;')[0];
  await sql(bootstrap,true); // Extensions/helpers only. Storage owns its REAL schema.
  await sql('alter default privileges for role postgres in schema public grant select,insert,update,delete on tables to anon,authenticated,service_role; alter default privileges for role postgres in schema public grant usage,select on sequences to anon,authenticated,service_role;');
  const files=(await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')&&(!process.argv.includes('--pre-resources')||f<'20261024180429_tenant_resource_policies_and_worker_boundaries.sql')).sort();let log='';
  for(const file of files){log+=file+'\n'+await sql('begin;'+await readFile('supabase/migrations/'+file,'utf8')+'commit;');console.log(file);}
  await sql("select cron.unschedule(jobid) from cron.job; notify pgrst,'reload schema';");
  await writeFile(`${evidence}/replay.txt`,log);console.log(`PASS ${files.length} migrations against native Auth/Storage schemas; fixture schedulers removed.`);
 }else if(cmd==='resume-initial-storage-failure'){
  // Only for the captured first replay: 0002 stopped at its first Storage policy.
  if((await sql("select count(*) from pg_policies where schemaname='storage' and policyname like 'cms_media%';")).trim()!=='0'||(await sql("select to_regclass('public.agencies') is null;")).trim()!=='t')throw Error('Unexpected partial replay state');
  let log='Initial replay stopped in 0002: must be owner of table objects. Native fixture missing postgres membership in supabase_storage_admin. Membership corrected; resume at first unexecuted statement.\n';
  const source=await readFile('supabase/migrations/0002_cms_rls_policies.sql','utf8');
  log+=await sql(source.slice(source.indexOf('create policy cms_media_public_read')));
  for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')&&f>'0002_cms_rls_policies.sql').sort()){log+=file+'\n'+await sql(await readFile('supabase/migrations/'+file,'utf8'));console.log(file);}
  await sql("select cron.unschedule(jobid) from cron.job; notify pgrst,'reload schema';");await writeFile(`${evidence}/replay.txt`,log);console.log('PASS resumed all 33 migrations; cron disabled.');
 }else if(cmd==='verify')console.log(await verify());else throw Error('Usage: native-lab.mjs create|services|replay|verify');
}catch(e){console.error(e.message,e.sqlOutput||'');process.exitCode=1;}
