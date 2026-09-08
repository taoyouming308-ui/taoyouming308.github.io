// Exact receipt lookup against real handlers and a disposable PostgreSQL database.
const assert=require('node:assert/strict');
const {startServer}=require('./salon-local-integration.cjs');
(async()=>{let app;try{
 app=await startServer();
 const {createSalonClient}=await import('../packages/salon-core/api-client.mjs');
 const login=async()=> (await (await fetch(app.url+'/__salon_test_session',{method:'POST'})).json()).token;
 let token=await login(),lose=false;
 const client=createSalonClient({endpoint:app.url+'/api/salon',getAccessToken:()=>token,fetchImpl:async(url,options)=>{
  const result=await fetch(url,options);
  if(lose){lose=false;await result.json();throw Error('synthetic response lost after commit');}
  return result;
 }});
 const call=q=>JSON.parse(app.sql(`begin read only;set local role service_role;select ${q};commit;`));
 const lookup=(key,operation='order_create',actor=1,org=1,store=1)=>call(`public.salon_lookup_staff_request(${actor},${org},${store},'${key}','${operation}')`);
 const unknown=operation=>({operation,status:'unconfirmed'});
 const read=(key,targetOperation)=>client.read('request_lookup',{requestKey:key,targetOperation}).then(r=>r.data);
 const snapshot=()=>app.sql(`select md5(jsonb_build_array(
 (select jsonb_agg(to_jsonb(t) order by id) from public.salon_operation_requests t),
 (select jsonb_agg(to_jsonb(t) order by id) from public.salon_customers t),
 (select jsonb_agg(to_jsonb(t) order by id) from public.salon_orders t),
 (select jsonb_agg(to_jsonb(t) order by id) from public.salon_order_lines t),
 (select jsonb_agg(to_jsonb(t) order by id) from public.salon_audit_events t))::text);`);
 await client.connect();
 const customerTicket=client.prepare('customer_create',{displayName:'合成核对',phone:'13800000000'});
 const customer=(await client.submit(customerTicket)).data;
 const orderTicket=client.prepare('order_create',{customerId:customer.customerId,notes:'不应在核对结果返回'});
 lose=true;await assert.rejects(client.submit(orderTicket),{code:'OUTCOME_UNKNOWN'});
 // A new session/client scope does not require replaying the mutation.
 client.disconnect();token=await login();await client.connect();
 const orderReceipt=await read(orderTicket.requestKey,'order_create');
 assert.equal(orderReceipt.status,'committed');assert.equal(orderReceipt.resourceType,'order');
 const orderId=Number(orderReceipt.resourceId);
 const linesTicket=client.prepare('order_lines',{orderId,expectedVersion:(await client.read('order_detail',{orderId})).data.order.edit_version,lines:[{catalogItemId:1,quantity:1,unitPrice:12.34,discountAmount:0}]});
 await client.submit(linesTicket);
 const before=snapshot();
 for(const [ticket,type,id] of [[customerTicket,'customer',customer.customerId],[orderTicket,'order',orderId],[linesTicket,'order',orderId]]){
  const receipt=await read(ticket.requestKey,ticket.operation);
  assert.deepEqual(Object.keys(receipt).sort(),['completedAt','operation','resourceId','resourceType','status']);
  assert.equal(receipt.resourceId,String(id));assert.equal(receipt.resourceType,type);assert.equal(receipt.status,'committed');
  assert.ok(Number.isFinite(Date.parse(receipt.completedAt)));
 }
 assert.deepEqual(await read('not-found-key-0001','order_create'),unknown('order_create'));
 assert.deepEqual(await read(orderTicket.requestKey,'order_lines'),unknown('order_lines'));
 assert.deepEqual(lookup(orderTicket.requestKey,'order_create',1,1,2),unknown('order_create'));
 assert.equal(snapshot(),before,'lookup must not claim keys, change business rows or add business audit events');
 // Another authorized employee still cannot discover this employee's receipt.
 app.sql(`insert into public.salon_staff(organization_id,store_id,role_id,staff_no,display_name) values(1,1,1,'OTHER','合成其他员工');
 insert into public.salon_staff_store_roles(organization_id,staff_id,store_id,role_id,reason) values(1,2,1,1,'合成测试');`);
 assert.deepEqual(lookup(orderTicket.requestKey,'order_create',2),unknown('order_create'));
 assert.throws(()=>lookup(orderTicket.requestKey,'order_create',1,2,1));
 assert.throws(()=>lookup(orderTicket.requestKey,'order_create',1,1,3));
 for(const permission of ['read','write']){
  app.sql(`delete from public.salon_role_permissions where role_id=1 and resource='orders' and action='${permission}'`);
  await assert.rejects(read(orderTicket.requestKey,'order_create'));
  app.sql(`insert into public.salon_role_permissions(role_id,resource,action) values(1,'orders','${permission}')`);
  await client.connect();
 }
 app.sql("update public.salon_staff set employment_status='departed' where id=1");
 await assert.rejects(read(orderTicket.requestKey,'order_create'));
 app.sql("update public.salon_staff set employment_status='active' where id=1");await client.connect();
 // A completed legacy receipt without ownership proof must not be exposed.
 app.sql(`insert into public.salon_operation_requests(organization_id,store_id,request_key,action,entity_type,entity_id,response_json,completed_at)
 values(1,1,'legacy-lookup-0001','order_create','order_payload',1,'{"orderId":999,"secret":"not returned"}',now());`);
 assert.deepEqual(lookup('legacy-lookup-0001'),unknown('order_create'));
 // In-progress DB transaction is not visible and must never be called failed.
 const pending=app.asyncSql("set application_name='lookup-commit-barrier';begin;set local role service_role;select public.salon_create_order(1,1,1,'pending-lookup-001',null,null,'合成');select pg_sleep(2);commit;");
 let reached=false;
 for(let i=0;i<100;i++){
  if(app.sql("select count(*) from pg_stat_activity where application_name='lookup-commit-barrier' and wait_event='PgSleep'")==='1'){reached=true;break;}
  await new Promise(r=>setTimeout(r,20));
 }
 assert.equal(reached,true);
 assert.deepEqual(lookup('pending-lookup-001'),unknown('order_create'));
 await pending;assert.equal(lookup('pending-lookup-001').status,'committed');
 app.sql("begin;set local role service_role;select public.salon_create_order(1,1,1,'rollback-lookup-01',null,null,'合成');rollback;");
 assert.deepEqual(lookup('rollback-lookup-01'),unknown('order_create'));
 const signature='public.salon_lookup_staff_request(bigint,bigint,bigint,text,text)';
 for(const role of ['anon','authenticated'])assert.equal(app.sql(`select has_function_privilege('${role}','${signature}','EXECUTE') or has_table_privilege('${role}','public.salon_operation_requests','SELECT')`),'f');
 assert.equal(app.sql(`select provolatile::text||'/'||prosecdef::text from pg_proc where oid='${signature}'::regprocedure`),'s/false');
 for(const key of ['short','x'.repeat(121),' padded-request-key'])assert.throws(()=>lookup(key));
 assert.throws(()=>lookup(orderTicket.requestKey,'checkout'));
 assert.equal(app.sql('select count(*) from public.salon_customers'),'1');
 assert.equal(app.sql('select count(*) from public.salon_orders'),'2');
 console.log('Request lookup passed: 3 minimal receipts, lost-response/new-session HTTP recovery, read-only snapshot, actor/store/org isolation, revoked rights, legacy rejection, pending commit/rollback and browser privilege denial');
}finally{if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
