const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startServer}=require('./salon-local-integration.cjs');
(async()=>{let app,browser;try{
 app=await startServer();
 const create=()=>Number(app.sql("insert into public.salon_orders(organization_id,store_id,order_no) values(1,1,'CAS-'||nextval('public.salon_order_number_seq')) returning id"));
 const version=id=>Number(app.sql(`select edit_version from public.salon_orders where id=${id}`));
 const lines='[{"catalogItemId":1,"quantity":1,"unitPrice":12.34,"discountAmount":0}]';
 const query=(id,key,v,payload=lines,store=1,actor=1)=>`public.salon_replace_order_lines_versioned(${actor},1,${store},${id},'${key}','${payload}'::jsonb,'',${v})`;
 const call=q=>JSON.parse(app.sql(`set role service_role;select ${q}`));
 const fails=(q,re)=>assert.throws(()=>call(q),e=>re.test(String(e.stderr)));
 const snapshot=id=>app.sql(`select jsonb_build_object('order',(select to_jsonb(o) from public.salon_orders o where id=${id}),'lines',(select jsonb_agg(l order by id) from public.salon_order_lines l where order_id=${id}))`);
 const id=create(),v=version(id),key='version-success-0001',first=call(query(id,key,v));
 assert.ok(version(id)>v);const after=snapshot(id);
 assert.deepEqual(call(query(id,key,v)),first);assert.equal(snapshot(id),after,'replay cannot bump version or replace lines');
 fails(query(id,key,version(id)),/幂等键/);
 fails(query(id,'version-stale-00001',v),/订单版本已变化/);assert.equal(snapshot(id),after);
 assert.equal(app.sql("select count(*) from public.salon_operation_requests where request_key='version-stale-00001'"),'0');
 fails(query(id,'version-cross-00001',version(id),lines,2),/当前门店/);
 const beforeBad=snapshot(id);fails(query(id,'version-invalid-001',version(id),'[{"catalogItemId":9999,"quantity":1}]'),/项目商品不存在/);assert.equal(snapshot(id),beforeBad,'failed replacement rolls back deletion and all version increments');
 // Direct line writes and status ABA both invalidate a previously read version.
 const old=version(id);app.sql(`update public.salon_order_lines set quantity=2 where order_id=${id}`);assert.ok(version(id)>old);
 fails(query(id,'version-line-edit01',old),/订单版本已变化/);
 const aba=version(id);app.sql(`update public.salon_orders set status='opened' where id=${id};update public.salon_orders set status='draft',edit_version=0 where id=${id}`);assert.ok(version(id)>aba);
 fails(query(id,'version-aba-edit-01',aba),/订单版本已变化/);
 // Two actual PostgreSQL connections use one version: exactly one can win.
 const shared=create(),sv=version(shared);
 const results=await Promise.allSettled(['version-race-key01','version-race-key02'].map(k=>app.asyncSql(`set role service_role;select ${query(shared,k,sv)}`)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(String(results.find(r=>r.status==='rejected').reason.stderr),/订单版本已变化/);
 const repeat=create(),q=query(repeat,'version-same-key01',version(repeat));
 const both=await Promise.all([app.asyncSql(`set role service_role;select ${q}`),app.asyncSql(`set role service_role;select ${q}`)]);assert.equal(both[0],both[1]);
 assert.equal(app.sql(`select count(*) from public.salon_order_lines where order_id=${repeat}`),'1');
 app.sql("delete from public.salon_role_permissions where role_id=1 and resource='orders' and action='write'");
 fails(query(id,key,v),/权限/);app.sql("insert into public.salon_role_permissions(role_id,resource,action) values(1,'orders','write')");
 assert.equal(app.sql("select has_function_privilege('authenticated','public.salon_replace_order_lines_versioned(bigint,bigint,bigint,bigint,text,jsonb,text,integer)','execute')"),'f');
 assert.equal(app.sql("select has_table_privilege('authenticated','public.salon_orders','update')"),'f');
 // UI sends the version it originally read, not a pre-submit refresh that would hide conflicts.
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:844}}),writes=[];
  await page.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
  page.on('request',r=>{if(r.url().endsWith('/api/salon')&&r.postDataJSON().operation==='order_lines')writes.push(r.postDataJSON());});
  await page.goto(app.url);await page.locator('#connect').click();await page.getByText('已连接临时数据库；所有操作只影响本次合成数据。',{exact:true}).waitFor();
  await page.locator('#name').fill(`合成并发-${width}`);await page.locator('#createCustomer').click();await page.getByText('顾客已建档并读取确认。',{exact:true}).waitFor();
  await page.locator('#createOrder').click();await page.getByText('订单已创建并读取确认。',{exact:true}).waitFor();
  const current=Number(app.sql('select max(id) from public.salon_orders')),seen=version(current);
  call(query(current,`version-other-${width}-01`,seen));const saved=snapshot(current);
  await page.locator('#item').selectOption('1');await page.locator('#saveLines').click();await page.getByText(/订单版本已变化/).waitFor();
  assert.equal(writes.length,1);assert.equal(writes[0].expectedVersion,seen);assert.equal(snapshot(current),saved);
  assert.equal(await page.locator('#saveLines').isDisabled(),true);assert.equal(await page.locator('#retry').isDisabled(),true);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('salon.pending.v1:1:1:1')),null);await page.close();
 }
 console.log('Order version passed: SQL concurrent writers/same-key replay, stale and ABA guards, rollback, permissions and 1280/390 UI conflict without overwrite');
}finally{if(browser)await browser.close();if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
