const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startServer}=require('./salon-local-integration.cjs');
(async()=>{let app,browser;try{
 app=await startServer();let serial=0;
 const call=q=>JSON.parse(app.sql(`set role service_role;select ${q}`));
 const quote=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'::jsonb";
 app.sql("insert into public.salon_role_permissions(role_id,resource,action) values(1,'orders','checkout'),(1,'orders','refund_request'),(1,'orders','refund_read'),(1,'orders','refund_approve');insert into public.salon_staff(organization_id,store_id,role_id,staff_no,display_name) values(1,1,1,'REQUESTER','合成申请人');insert into public.salon_staff_store_roles(organization_id,staff_id,store_id,role_id,reason) values(1,2,1,1,'合成测试');update public.salon_catalog_store_settings set stock_tracked=true where store_id=1;insert into public.salon_inventory_balances(organization_id,store_id,catalog_item_id,quantity) values(1,1,1,100)");
 const make=(actor=2)=>{
  const n=++serial,id=Number(app.sql(`insert into public.salon_orders(organization_id,store_id,order_no) values(1,1,'REFUND-TEST-${n}') returning id`));
  call(`public.salon_replace_order_lines_versioned(1,1,1,${id},'refund-lines-key-${n}','[{"catalogItemId":1,"quantity":1,"unitPrice":12.34}]'::jsonb,'',0)`);
  app.sql(`update public.salon_orders set status='awaiting_payment' where id=${id}`);
  const version=Number(app.sql(`select edit_version from public.salon_orders where id=${id}`));
  call(`public.salon_checkout_cash(1,1,1,${id},'refund-cash-key-${n}',${version},'12.34','20.00')`);
  return call(`public.salon_submit_refund_request(${actor},1,1,${id},'refund-request-key-${n}','full','合成原因 <img src=x>')`).refundRequestId;
 };
 const detail=id=>call(`public.salon_get_refund_review(1,1,1,${id})`);
 const review=(id,key,snapshot,decision='approved',actor=1)=>`public.salon_review_refund_checked(${actor},1,1,${id},'${key}','${decision}','合成核对',${quote(snapshot)})`;
 const lookup=key=>call(`public.salon_lookup_staff_request(1,1,1,'${key}','refund_review')`);
 const balances=()=>app.sql("select jsonb_build_object('payments',(select jsonb_agg(p order by id) from public.salon_payments p),'orders',(select jsonb_agg(o order by id) from public.salon_orders o),'stock',(select jsonb_agg(s order by catalog_item_id) from public.salon_inventory_balances s),'stockLedger',(select jsonb_agg(l order by id) from public.salon_inventory_ledger l),'members',(select jsonb_agg(m order by id) from public.salon_account_ledger m),'performance',(select jsonb_agg(p order by id) from public.salon_performance_ledger p))");
 const id=make(),snapshot=detail(id),before=balances();
 assert.deepEqual(Object.keys(snapshot).sort(),['lines','order','payments','refund']);assert.equal(JSON.stringify(snapshot).includes('external_reference'),false);assert.equal(JSON.stringify(snapshot).includes('member_account_id'),false);
 const result=call(review(id,'refund-review-ok-0001',snapshot));assert.equal(result.status,'approved');assert.equal(balances(),before);
 assert.deepEqual(call(review(id,'refund-review-ok-0001',snapshot)),result);assert.equal(lookup('refund-review-ok-0001').resourceId,id);
 assert.throws(()=>call(review(id,'refund-review-ok-0001',snapshot,'rejected')));assert.throws(()=>call(review(id,'refund-review-new-0001',snapshot)));
 assert.equal(call("public.salon_lookup_staff_request(1,1,2,'refund-review-ok-0001','refund_review')").status,'unconfirmed');
 assert.equal(call("public.salon_lookup_staff_request(2,1,1,'refund-review-ok-0001','refund_review')").status,'unconfirmed');
 assert.throws(()=>call(`public.salon_get_refund_review(1,1,2,${id})`),/当前门店/);
 const own=make(1);assert.throws(()=>call(review(own,'refund-self-test-0001',detail(own))),/同一人/);
 const stale=make(),old=detail(stale);app.sql(`update public.salon_orders set notes='合成更新' where id=${old.order.id}`);
 assert.throws(()=>call(review(stale,'refund-stale-test-001',old)),/内容已变化/);
 assert.equal(detail(stale).refund.status,'submitted');
 const fresh=detail(stale);const raced=await Promise.allSettled(['approved','rejected'].map((decision,i)=>app.asyncSql(`set role service_role;select ${review(stale,'refund-race-key-000'+i,fresh,decision)}`)));
 assert.equal(raced.filter(x=>x.status==='fulfilled').length,1);
 app.sql("delete from public.salon_role_permissions where resource='orders' and action='refund_approve'");
 assert.throws(()=>lookup('refund-review-ok-0001'),/权限/);assert.throws(()=>call(review(id,'refund-review-ok-0001',snapshot)),/权限/);
 app.sql("insert into public.salon_role_permissions(role_id,resource,action) values(1,'orders','refund_approve')");
 assert.equal(app.sql(`begin read only;set role service_role;select public.salon_get_refund_review(1,1,1,${id})->'refund'->>'status';commit`),'approved');
 for(const role of ['anon','authenticated'])assert.equal(app.sql(`select has_function_privilege('${role}','public.salon_get_refund_review(bigint,bigint,bigint,bigint)','execute')`),'f');
 const rollback=make(),rollbackBefore=detail(rollback);
 app.sql("create function public.synthetic_refund_failure() returns trigger language plpgsql as $$begin if new.action='review' then raise exception 'synthetic audit failure';end if;return new;end $$;create trigger synthetic_refund_failure before insert on public.salon_audit_events for each row execute function public.synthetic_refund_failure()");
 assert.throws(()=>call(review(rollback,'refund-rollback-0001',rollbackBefore)),/synthetic audit failure/);assert.deepEqual(detail(rollback),rollbackBefore);assert.equal(lookup('refund-rollback-0001').status,'unconfirmed');
 app.sql("drop trigger synthetic_refund_failure on public.salon_audit_events;drop function public.synthetic_refund_failure()");
 // Synthetic legacy allocations: money is within bounds, but combined card units exceed original.
 const over=make(),overData=detail(over),payment=overData.payments[0].paymentId;
 app.sql(`update public.salon_payments set payment_method='member_units',member_units=10 where id=${payment};update public.salon_refund_requests set refund_type='partial',requested_amount=1 where id=${over};update public.salon_refund_request_lines set refund_amount=1 where refund_request_id=${over};update public.salon_refund_request_payments set refund_amount=1,refund_units=6,payment_method='member_units' where refund_request_id=${over}`);
 const other=Number(app.sql(`insert into public.salon_refund_requests(organization_id,store_id,order_id,refund_type,requested_amount,reason,created_by_staff_id) values(1,1,${overData.order.id},'partial',1,'合成旧次卡分配',2) returning id`));
 app.sql(`insert into public.salon_refund_request_payments(organization_id,refund_request_id,original_payment_id,refund_amount,refund_units,payment_method) values(1,${other},${payment},1,6,'member_units')`);
 const overBefore=balances();
 assert.throws(()=>call(review(over,'refund-over-units-001',detail(over))),/累计退款/);assert.equal(balances(),overBefore);
 assert.equal(call(review(over,'refund-reject-units-1',detail(over),'rejected')).status,'rejected');assert.equal(balances(),overBefore);
 // Queue keyset boundary, minimal fields, filter and scope.
 app.sql(`insert into public.salon_refund_requests(organization_id,store_id,order_id,refund_type,status,requested_amount,reason,created_by_staff_id) select 1,1,${snapshot.order.id},'partial','rejected',1,'synthetic pagination',2 from generate_series(1,55)`);
 const page1=call("public.salon_list_refund_review_queue(1,1,1,'rejected')"),page2=call(`public.salon_list_refund_review_queue(1,1,1,'rejected',${page1.nextBeforeId})`);
 assert.equal(page1.rows.length,50);assert.ok(page2.rows.length>=5);assert.ok(page2.rows.every(r=>r.id<page1.nextBeforeId));assert.deepEqual(Object.keys(page1.rows[0]).sort(),['amount','id','orderId','status']);assert.deepEqual(call("public.salon_list_refund_review_queue(1,1,2,'')").rows,[]);
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [1280,390]){
  const target=make(),page=await browser.newPage({viewport:{width,height:844}}),writes=[],errors=[];let mode='normal';
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
  await page.route('**/api/salon',async route=>{
   const body=route.request().postDataJSON();
   if(body.operation==='refund_review'){writes.push(body);if(mode==='drop'){mode='normal';await route.fetch();return route.abort('failed');}}
   if(body.operation==='refund_detail'&&mode==='bad-readback'){mode='normal';const response=await route.fetch(),json=await response.json();json.data.refund.decisionReason='wrong';return route.fulfill({response,json});}
   return route.continue();
  });
  const connect=async()=>{await page.locator('#connect').click();await page.getByText('已连接临时数据库；所有操作只影响本次合成数据。',{exact:true}).waitFor();};
  const load=async n=>{await page.locator('#listRefunds').click();await page.locator('#refundSelection').selectOption(String(n));await page.locator('#loadRefund').click();await page.getByText('退款申请与原支付已读取；尚未审批或退款。',{exact:true}).waitFor();};
  const journal=()=>page.evaluate(()=>sessionStorage.getItem('salon.pending.v1:1:1:1'));
  await page.goto(app.url);await connect();await load(target);
  assert.equal(await page.locator('#refundDetail img').count(),0);assert.match(await page.locator('#refundDetail').textContent(),/原支付/);
  await page.locator('#refundReason').fill('合成核对');const financialBefore=balances();mode='drop';await page.locator('#approveRefund').click();await page.getByText(/未收到有效结果/).waitFor();assert.ok(await journal());assert.equal(await page.locator('#createOrder').isDisabled(),true);
  if(width===1280){await page.locator('#retry').click();await page.getByText('退款审批已保存并读取确认；未执行退款或返库。',{exact:true}).waitFor();assert.deepEqual(writes[0],writes[1]);}
  else{app.sql(`update public.salon_refund_requests set status='cancelled' where id=${target}`);await page.reload();await connect();await page.locator('#lookupRequest').click();await page.getByText(/原审批决定已核对/).waitFor();assert.equal(writes.length,1);assert.match(await page.locator('#status').textContent(),/当前申请：已取消/);}
  assert.equal(await journal(),null);assert.equal(balances(),financialBefore);assert.equal(await page.locator('#approveRefund').isDisabled(),true);
  if(width===390)await page.screenshot({path:'/private/tmp/salon-refund-review-mobile.png',fullPage:true});
  const bad=make();await load(bad);await page.locator('#refundReason').fill('合成核对');mode='bad-readback';await page.locator('#rejectRefund').click();await page.getByText(/后续回读失败/).waitFor();assert.ok(await journal());assert.equal(await page.locator('#retry').isDisabled(),true);
  await page.locator('#lookupRequest').click();await page.getByText(/原审批决定已核对/).waitFor();assert.equal(await journal(),null);
  const changed=make();await load(changed);await page.locator('#refundReason').fill('合成核对');app.sql(`update public.salon_orders set notes='changed' where id=${detail(changed).order.id}`);
  await page.locator('#approveRefund').click();await page.getByText(/内容已变化/).waitFor();assert.equal(await journal(),null);assert.equal(await page.locator('#approveRefund').isDisabled(),true);
  await load(own);assert.equal(await page.locator('#approveRefund').isDisabled(),true);assert.equal(await page.locator('#rejectRefund').isDisabled(),true);
  await page.locator('#store').selectOption('2');await page.getByText('已切换门店，旧选择已清除。',{exact:true}).waitFor();assert.equal(await page.locator('#refundDetail').textContent(),'');assert.equal(await page.locator('#refundSelection option').count(),1);
  assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.close();
 }
 console.log('Refund review PG/browser passed: maker-checker, scope, stale snapshot, concurrent review, audit rollback, minimal pagination, loss/retry/reload/readback, desktop/mobile and zero financial changes');
}finally{if(browser)await browser.close();if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
