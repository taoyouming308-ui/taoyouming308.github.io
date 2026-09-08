// Local synthetic DB only. No cloud credentials, published DB ports or production adapters.
const {execFileSync,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..');
async function startServer(){
 const container=`salon-workbench-${process.pid}-${Date.now()}`,tokens=new Set(),customerTokens=new Set();
 let created=false,server;
 const docker=(args,input)=>execFileSync('docker',args,{input,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,stdio:['pipe','pipe','pipe']});
 const sql=input=>docker(['exec','-i',container,'psql','-U','postgres','-v','ON_ERROR_STOP=1','-qAt'],input).trim();
 const close=async()=>{if(server)await new Promise(r=>server.close(r));if(created){docker(['rm','-f',container]);created=false;}};
 try{
  docker(['run','--name',container,'-e','POSTGRES_PASSWORD=synthetic-only','-d','postgres:15']);created=true;
  let ready=false;
  for(let i=0;i<90;i++){try{docker(['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres']);ready=true;break}catch{await new Promise(r=>setTimeout(r,200));}}
  if(!ready)throw Error('Synthetic PostgreSQL startup timed out');
  sql('create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;');
  for(const file of fs.readdirSync(path.join(root,'supabase/migrations')).filter(f=>/_salon_.*\.sql$/.test(f)).sort())sql(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8'));
  sql(`insert into public.salon_organizations(name) values('本机合成机构');
   insert into public.salon_stores(organization_id,code,name) values(1,'TEST-A','合成甲店'),(1,'TEST-B','合成乙店'),(1,'TEST-C','未授权合成店');
   insert into public.salon_roles(organization_id,name,data_scope) values(1,'本机测试店员','store');
   insert into public.salon_role_permissions(role_id,resource,action) values(1,'customers','read'),(1,'customers','write'),(1,'catalog','read'),(1,'orders','write'),(1,'orders','read'),(1,'customer_portal','manage'),(1,'scheduling','write');
   insert into public.salon_staff(organization_id,store_id,role_id,staff_no,display_name) values(1,1,1,'LOCAL','合成店员');
   insert into public.salon_staff_store_roles(organization_id,staff_id,store_id,role_id,reason) values(1,1,1,1,'合成测试'),(1,1,2,1,'合成测试');
   insert into public.salon_catalog_items(organization_id,item_type,code,name,list_price) values(1,'product','TEST-P','合成商品',12.34);
   insert into public.salon_catalog_store_settings(organization_id,store_id,catalog_item_id,stock_tracked) values(1,1,1,false),(1,2,1,false);`);
  const functions=JSON.parse(sql("select jsonb_object_agg(proname,proretset) from pg_proc join pg_namespace n on n.oid=pronamespace where n.nspname='public' and proname like 'salon_%';"));
  const literal=value=>value==null?'null':"'"+String(typeof value==='object'?JSON.stringify(value):value).replaceAll("'","''")+"'";
  const rpc=(name,args)=>{
   if(!Object.hasOwn(functions,name)||!/^salon_[a-z_]+$/.test(name))throw Error('Local RPC not allowed');
   const params=Object.entries(args).map(([key,value])=>{
    if(!/^p_[a-z_]+$/.test(key))throw Error('Invalid local RPC argument');
    return `${key}=>${key==='p_tags'?'ARRAY['+value.map(literal).join(',')+']::text[]':literal(value)}`;
   }).join(',');
   const expr=`public.${name}(${params})`;
   try{return JSON.parse(sql(`set role service_role;select ${functions[name]?`coalesce(jsonb_agg(to_jsonb(r)),'[]') from ${expr} r`:expr};`));}
   catch(error){
    // Expose only the database's first business error, never SQL/CONTEXT/request body.
    const message=String(error.stderr||'').match(/ERROR:\s*([^\n]+)/)?.[1];
    throw Error(message||'数据库请求失败');
   }
  };
  const {createSalonHandler}=await import('../supabase/functions/_shared/salon-api-core.mjs');
  const handler=createSalonHandler({
   verifyUser:async supplied=>tokens.has(supplied)?{id:'11111111-1111-4111-8111-111111111111'}:null,
   findStaff:async()=>JSON.parse(sql('select to_jsonb(s) from public.salon_staff s where id=1;')),
   resolveStore:async s=>rpc('salon_resolve_staff_store',{p_actor_staff_id:s.actorStaffId,p_organization_id:s.organizationId,p_requested_store_id:s.requestedStoreId}),
   invoke:async(name,args)=>rpc(name,args),
   read:async(resource,s)=>{
    const common={p_actor_staff_id:s.actorStaffId,p_organization_id:s.organizationId,p_store_id:s.storeId};
    if(resource==='customers')return rpc('salon_list_customers',{...common,p_query:s.query,p_status:s.status,p_limit:s.limit});
    if(resource==='catalog')return rpc('salon_list_catalog_inventory',{...common,p_item_type:s.itemType,p_status:s.status,p_query:s.query,p_limit:s.limit});
    if(resource==='order_detail')return rpc('salon_get_order',{...common,p_order_id:s.orderId});
    throw Error('本机工作台未开放该读取');
   }
  });
  const {createSalonCustomerHandler}=await import('../supabase/functions/_shared/salon-customer-api-core.mjs');
  const customerHandler=createSalonCustomerHandler({verifyUser:async token=>customerTokens.has(token)?{id:'22222222-2222-4222-8222-222222222222'}:null,invoke:async(name,args)=>rpc(name,args)});
  const files={'/customer':'salon-customer-workbench.html','/packages/salon-core/customer-workbench.mjs':'packages/salon-core/customer-workbench.mjs','/':'salon-api-workbench.html','/packages/salon-core/api-client.mjs':'packages/salon-core/api-client.mjs','/packages/salon-core/session-controller.mjs':'packages/salon-core/session-controller.mjs','/packages/salon-core/workbench.mjs':'packages/salon-core/workbench.mjs'};
  files['/packages/salon-core/store-time.mjs']='packages/salon-core/store-time.mjs';
  files['/packages/salon-core/request-deadline.mjs']='packages/salon-core/request-deadline.mjs';
  files['/packages/salon-core/recovery-journal.mjs']='packages/salon-core/recovery-journal.mjs';
  files['/packages/salon-core/order-inspection.mjs']='packages/salon-core/order-inspection.mjs';
  files['/packages/salon-core/order-readback.mjs']='packages/salon-core/order-readback.mjs';
  files['/packages/salon-core/draft-editor.mjs']='packages/salon-core/draft-editor.mjs';
  const allowed=new Set(['context','stores','customers','catalog','customer_create','order_create','order_lines','order_detail','booking_requests','booking_cancel_review','booking_reschedule','reschedule_requests','reschedule_review']);
  const customerAllowed=new Set(['context','bookings','reschedule_requests','reschedule_request']);
  allowed.add('store_time');customerAllowed.add('store_time');
  allowed.add('request_lookup');
  allowed.add('orders');
  allowed.add('order_status');
  allowed.add('cash_checkout');
  files['/packages/salon-core/cash-receipt.mjs']='packages/salon-core/cash-receipt.mjs';
  files['/packages/salon-core/order-flow.mjs']='packages/salon-core/order-flow.mjs';
  files['/packages/salon-core/cash-preview.mjs']='packages/salon-core/cash-preview.mjs';
  files['/packages/salon-core/order-list.mjs']='packages/salon-core/order-list.mjs';
  server=http.createServer(async(req,res)=>{
   const origin=`http://127.0.0.1:${server.address().port}`;
   const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
   if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site')return reply(403,{error:'本机同源访问限定'});
   const route=req.url;
   if(req.method==='GET'&&Object.hasOwn(files,route)){
    res.writeHead(200,{'Content-Type':files[route].endsWith('.html')?'text/html; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
    return res.end(fs.readFileSync(path.join(root,files[route])));
   }
   if(req.method!=='POST')return reply(405,{error:'POST required'});
   if(route==='/__salon_test_customer_session'){
    const token=randomUUID();customerTokens.add(token);
    return reply(200,{environment:'synthetic-local-only',token});
   }
   if(route==='/__salon_test_customer_logout'){
    const token=(req.headers.authorization||'').replace(/^Bearer /,'');
    customerTokens.delete(token);return reply(200,{data:{}});
   }
   if(route==='/__salon_test_session'){
    const token=randomUUID();tokens.add(token);
    return reply(200,{environment:'synthetic-local-only',token,user:{id:'11111111-1111-4111-8111-111111111111'},expires_at:Math.floor(Date.now()/1000)+3600});
   }
   if(route==='/__salon_test_user'||route==='/__salon_test_logout'){
    const token=(req.headers.authorization||'').replace(/^Bearer /,'');
    // A lost successful logout response must be retryable without resurrecting a session.
    if(route==='/__salon_test_logout'&&/^[0-9a-f-]{36}$/.test(token)){tokens.delete(token);return reply(200,{data:{}});}
    if(!tokens.has(token))return reply(403,{error:'合成会话失效'});
    return reply(200,{data:{user:{id:'11111111-1111-4111-8111-111111111111'}}});
   }
   if(route!=='/api/salon'&&route!=='/api/salon-customer')return reply(404,{error:'Not found'});
   try{
    let body='',bytes=0;
    for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)return reply(413,{error:'Payload too large'});body+=chunk;}
    const payload=JSON.parse(body);
    const customer=route==='/api/salon-customer';
    if(!(customer?customerAllowed:allowed).has(payload?.operation))return reply(403,{error:'本机工作台未开放该操作'});
    const result=await (customer?customerHandler:handler)(new Request(origin+route,{method:'POST',headers:{Authorization:req.headers.authorization||'','Content-Type':'application/json'},body}));
    reply(result.status,result.body);
   }catch{return reply(400,{error:'本机请求失败'});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const asyncSql=async input=>(await promisify(execFile)('docker',['exec',container,'psql','-U','postgres','-v','ON_ERROR_STOP=1','-qAt','-c',input],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024})).stdout.trim();
  return {url:`http://127.0.0.1:${server.address().port}`,close,sql,asyncSql};
 }catch(error){await close();throw error;}
}
module.exports={startServer};
if(require.main===module)startServer().then(app=>{
 console.log(`仅合成数据，本机临时数据库：${app.url}\nCtrl+C 删除本次测试数据库；不连接生产。`);
 let stopping=false;
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;await app.close();process.exit(0);});
}).catch(error=>{console.error(error.message);process.exitCode=1;});
