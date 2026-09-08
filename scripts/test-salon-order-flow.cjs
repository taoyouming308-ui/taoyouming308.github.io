const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startServer}=require('./salon-local-integration.cjs');
(async()=>{let app,browser;try{
 app=await startServer();
 const call=q=>JSON.parse(app.sql(`set role service_role;select ${q}`));
 const version=id=>Number(app.sql(`select edit_version from public.salon_orders where id=${id}`));
 const create=()=>{
  const id=Number(app.sql("insert into public.salon_orders(organization_id,store_id,order_no) values(1,1,'FLOW-'||nextval('public.salon_order_number_seq')) returning id"));
  call(`public.salon_replace_order_lines_versioned(1,1,1,${id},'flow-lines-${id}-000001','[{"catalogItemId":1,"quantity":1,"unitPrice":12.34}]'::jsonb,'',0)`);return id;
 };
 const q=(id,key,v,state='opened',store=1)=>`public.salon_set_order_status_versioned(1,1,${store},${id},'${key}','${state}','合成确认',${v})`;
 const lookup=key=>call(`public.salon_lookup_staff_request(1,1,1,'${key}','order_status')`);
 const snapshot=()=>app.sql("select jsonb_build_object('payments',(select jsonb_agg(p) from public.salon_payments p),'ledger',(select jsonb_agg(l) from public.salon_account_ledger l),'inventory',(select jsonb_agg(i) from public.salon_inventory_ledger i))");
 const untouched=snapshot();
 const id=create(),v=version(id),first=call(q(id,'flow-status-once01',v));assert.equal(first.status,'opened');
 const saved=version(id);assert.deepEqual(call(q(id,'flow-status-once01',v)),first);assert.equal(version(id),saved);
 assert.throws(()=>call(q(id,'flow-status-once01',saved)));assert.throws(()=>call(q(id,'flow-stale-state01',v,'in_service')));
 assert.equal(lookup('flow-status-once01').status,'committed');assert.equal(lookup('flow-stale-state01').status,'unconfirmed');
 assert.throws(()=>call(q(id,'flow-cross-store01',saved,'in_service',2)));
 assert.throws(()=>call(q(id,'flow-invalid-pay01',saved,'paid')));
 const race=create(),rv=version(race),outcomes=await Promise.allSettled(['flow-race-first01','flow-race-second1'].map(k=>app.asyncSql(`set role service_role;select ${q(race,k,rv)}`)));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.match(String(outcomes.find(r=>r.status==='rejected').reason.stderr),/订单版本已变化/);
 const repeat=create(),rq=q(repeat,'flow-race-same001',version(repeat));const repeats=await Promise.all([app.asyncSql(`set role service_role;select ${rq}`),app.asyncSql(`set role service_role;select ${rq}`)]);assert.equal(repeats[0],repeats[1]);
 app.sql("delete from public.salon_role_permissions where resource='orders' and action='write'");assert.throws(()=>call(q(id,'flow-status-once01',v)));assert.throws(()=>lookup('flow-status-once01'));
 app.sql("insert into public.salon_role_permissions(role_id,resource,action) values(1,'orders','write')");
 assert.equal(app.sql("select has_function_privilege('authenticated','public.salon_set_order_status_versioned(bigint,bigint,bigint,bigint,text,text,text,integer)','execute') or has_function_privilege('anon','public.salon_set_order_status_versioned(bigint,bigint,bigint,bigint,text,text,text,integer)','execute')"),'f');
 assert.equal(snapshot(),untouched);
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [1280,390]){
  const id=create(),page=await browser.newPage({viewport:{width,height:844}}),writes=[],errors=[];let lose=false,readback=false,failDetail=false;
  page.on('dialog',d=>d.accept());page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
  await page.route('**/api/salon',async r=>{
   const b=r.request().postDataJSON();
   if(b.operation==='order_status'){
    writes.push(b);
    if(lose){lose=false;await r.fetch();return r.abort('failed');}
    if(readback){readback=false;failDetail=true;}
   }
   if(failDetail&&b.operation==='order_detail'){failDetail=false;return r.abort('failed');}
   return r.continue();
  });
  const connect=async()=>{await page.locator('#connect').click();await page.getByText('已连接临时数据库；所有操作只影响本次合成数据。',{exact:true}).waitFor();};
  const recover=async()=>{await page.reload();await connect();await page.locator('#lookupRequest').click();await page.getByText('已核对原请求并读取当前记录，没有重新提交业务。',{exact:true}).waitFor();};
  const button=state=>page.locator(`#orderFlow button[data-order-status="${state}"]`);
  await page.goto(app.url);await connect();await page.locator('#listOrders').click();await page.locator(`#orderList article[data-order-id="${id}"]`).getByText('载入草稿编辑',{exact:true}).click();await page.getByText(/已重新读取并载入草稿/).waitFor();
  // Dirty draft cannot be advanced until saved or explicitly discarded.
  await page.locator('#draftRows input').first().fill('2');await page.locator('#draftRows input').first().press('Tab');assert.equal(await button('opened').isDisabled(),true);
  await page.locator('#draftRows input').first().fill('1');await page.locator('#draftRows input').first().press('Tab');
  lose=true;await button('opened').click();await page.locator('#retry:not([disabled])').waitFor();assert.equal(await button('opened').isDisabled(),true);
  await page.locator('#retry').click();await page.getByText('订单状态已保存并读取确认；未收款、未扣会员或自动完成明细。',{exact:true}).waitFor();assert.deepEqual(writes[0],writes[1]);
  assert.equal(await page.locator('#saveLines').isDisabled(),true);
  lose=true;await button('in_service').click();await page.locator('#retry:not([disabled])').waitFor();const count=writes.length;await recover();assert.equal(writes.length,count);
  assert.match(await page.locator('#orderFlow').textContent(),/服务中/);
  readback=true;await button('awaiting_payment').click();await page.getByText(/写入已经成功，请勿重复创建/).waitFor();assert.equal(await page.locator('#retry').isDisabled(),true);assert.equal(await page.locator('#listOrders').isDisabled(),true);
  const done=writes.length;await recover();assert.equal(writes.length,done);assert.match(await page.locator('#orderFlow').textContent(),/当前待收银/);assert.equal(await page.locator('#orderFlow button').count(),0);
  assert.equal(app.sql(`select status from public.salon_orders where id=${id}`),'awaiting_payment');assert.equal(app.sql(`select service_status from public.salon_order_lines where order_id=${id}`),'pending');
  await page.locator('#leaveDraft').click();await page.getByText(/已离开编辑/).waitFor();await page.locator('#listOrders').click();await page.locator(`#orderList article[data-order-id="${id}"]`).getByText('载入订单处理',{exact:true}).click();await page.getByText('已载入订单处理，尚未修改状态或收款。',{exact:true}).waitFor();assert.equal(await page.locator('#orderFlow button').count(),0);
  if(width===390)await page.screenshot({path:'/private/tmp/salon-order-flow-mobile.png',fullPage:true});
  await page.locator('#logout').click();await page.getByText('已退出本次测试会话；旧请求不能继续提交。',{exact:true}).waitFor();assert.equal(await page.locator('#orderFlow button').count(),0);assert.doesNotMatch(await page.locator('#orderFlow').textContent(),new RegExp(`编号 ${id}`));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await page.close();
 }
 assert.equal(snapshot(),untouched);
 console.log('Order flow passed: CAS/replay/race/permissions, 1280/390 draft-open-service-awaiting, frozen retry, refresh and readback recovery, no payment/ledger/inventory or line-service changes');
}finally{if(browser)await browser.close();if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
