const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startServer}=require('./salon-local-integration.cjs');
(async()=>{let app,browser;try{
 app=await startServer();
 const call=q=>JSON.parse(app.sql(`set role service_role;select ${q}`));
 let serial=0;
 const makeOrder=()=>{
  const id=Number(app.sql(`insert into public.salon_orders(organization_id,store_id,order_no) values(1,1,'CASH-TEST-${++serial}') returning id`));
  call(`public.salon_replace_order_lines_versioned(1,1,1,${id},'cash-order-lines-${serial}','[{"catalogItemId":1,"quantity":1,"unitPrice":12.34}]'::jsonb,'',0)`);
  app.sql(`update public.salon_orders set status='awaiting_payment' where id=${id}`);
  return {id,version:Number(app.sql(`select edit_version from public.salon_orders where id=${id}`))};
 };
 const checkout=(o,key,amount='12.34',tendered='20.00',version=o.version)=>`public.salon_checkout_cash(1,1,1,${o.id},'${key}',${version},'${amount}','${tendered}')`;
 const lookup=key=>call(`public.salon_lookup_staff_request(1,1,1,'${key}','cash_checkout')`);
 const counts=()=>app.sql("select jsonb_build_object('payments',(select count(*) from public.salon_payments),'requests',(select count(*) from public.salon_operation_requests),'stock',(select coalesce(sum(quantity),0) from public.salon_inventory_balances),'ledger',(select count(*) from public.salon_inventory_ledger),'audit',(select count(*) from public.salon_audit_events))");
 const first=makeOrder();let before=counts();
 assert.throws(()=>call(checkout(first,'cash-permission-0001')),/权限/);assert.equal(counts(),before);
 app.sql("insert into public.salon_role_permissions(role_id,resource,action) values(1,'orders','checkout')");
 for(const [amount,tendered,version] of [['12.345','20',first.version],['12.34','12.33',first.version],['0','20',first.version],['12.33','20',first.version],['12.34','20',first.version-1]]){
  before=counts();assert.throws(()=>call(checkout(first,'cash-invalid-0001',amount,tendered,version)));assert.equal(counts(),before);
 }
 before=counts();assert.throws(()=>call(checkout(first,'cash-disabled-stock-01')),/库存/);assert.equal(counts(),before);
 app.sql("update public.salon_catalog_store_settings set stock_tracked=true where store_id=1;insert into public.salon_inventory_balances(organization_id,store_id,catalog_item_id,quantity) values(1,1,1,0)");
 before=counts();assert.throws(()=>call(checkout(first,'cash-insufficient-001')),/库存不足/);assert.equal(counts(),before);
 app.sql("update public.salon_inventory_balances set quantity=100 where store_id=1");
 const paid=call(checkout(first,'cash-success-key-0001'));before=counts();
 assert.equal(paid.change,'7.66');assert.equal(paid.paid,'12.34');
 assert.deepEqual(call(checkout(first,'cash-success-key-0001')),paid);assert.equal(counts(),before);
 assert.throws(()=>call(checkout(first,'cash-success-key-0001','12.34','30.00')));
 assert.throws(()=>call(checkout(first,'cash-second-key-0001')));assert.equal(counts(),before);
 assert.deepEqual(lookup('cash-success-key-0001').receipt,paid);
 assert.equal(call("public.salon_lookup_staff_request(1,1,2,'cash-success-key-0001','cash_checkout')").status,'unconfirmed');
 assert.equal(app.sql("begin read only;set role service_role;select public.salon_lookup_staff_request(1,1,1,'cash-success-key-0001','cash_checkout')->>'status';commit"),'committed');
 assert.equal(app.sql("select has_function_privilege('anon','public.salon_checkout_cash(bigint,bigint,bigint,bigint,text,integer,text,text)','execute')"),'f');
 assert.equal(app.sql("select has_function_privilege('authenticated','public.salon_checkout_cash(bigint,bigint,bigint,bigint,text,integer,text,text)','execute')"),'f');
 app.sql("delete from public.salon_role_permissions where role_id=1 and resource='orders' and action='checkout'");
 assert.throws(()=>lookup('cash-success-key-0001'),/权限/);assert.throws(()=>call(checkout(first,'cash-success-key-0001')),/权限/);
 app.sql("insert into public.salon_role_permissions(role_id,resource,action) values(1,'orders','checkout')");
 // Different requests racing on one order: exactly one commit.
 const race=makeOrder();
 const outcomes=await Promise.allSettled(['cash-racing-key-0001','cash-racing-key-0002'].map(key=>app.asyncSql(`set role service_role;select ${checkout(race,key)}`)));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(app.sql(`select count(*) from public.salon_payments where order_id=${race.id}`),'1');
 const same=makeOrder();
 const sameResults=await Promise.all([1,2].map(()=>app.asyncSql(`set role service_role;select ${checkout(same,'cash-same-race-0001')}`)));
 assert.equal(sameResults[0],sameResults[1]);assert.equal(app.sql(`select count(*) from public.salon_payments where order_id=${same.id}`),'1');
 app.sql("insert into public.salon_staff(organization_id,store_id,role_id,staff_no,display_name) values(1,1,1,'SECOND','合成另一店员');insert into public.salon_staff_store_roles(organization_id,staff_id,store_id,role_id,reason) values(1,2,1,1,'合成权限隔离')");
 assert.equal(call("public.salon_lookup_staff_request(2,1,1,'cash-success-key-0001','cash_checkout')").status,'unconfirmed');
 assert.throws(()=>call(checkout(first,'cash-success-key-0001').replace('(1,1,1,','(2,1,1,')));
 // Isolated synthetic post-refund state: preserve historical receipt, never infer a new charge.
 app.sql(`update public.salon_orders set status='reversed',refunded_total=payable_total where id=${first.id};update public.salon_payments set status='reversed' where id=${paid.paymentId}`);
 assert.equal(lookup('cash-success-key-0001').paymentStatus,'reversed');
 assert.deepEqual(call(checkout(first,'cash-success-key-0001')),paid);
 // A late audit failure must roll back payment, stock, order and request together.
 const rollback=makeOrder();before=counts();
 app.sql("create function public.synthetic_cash_failure() returns trigger language plpgsql as $$ begin if new.action='checkout' then raise exception 'synthetic audit failure';end if;return new;end $$;create trigger synthetic_cash_failure before insert on public.salon_audit_events for each row execute function public.synthetic_cash_failure()");
 assert.throws(()=>call(checkout(rollback,'cash-audit-rollback-01')),/synthetic audit failure/);assert.equal(counts(),before);
 assert.equal(app.sql(`select status from public.salon_orders where id=${rollback.id}`),'awaiting_payment');
 app.sql("drop trigger synthetic_cash_failure on public.salon_audit_events;drop function public.synthetic_cash_failure()");
 assert.equal(app.sql("select count(*) from public.salon_account_ledger"),'0');
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [1280,390]){
  const order=makeOrder(),page=await browser.newPage({viewport:{width,height:844}}),errors=[],writes=[];
  let mode='normal';
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
  await page.route('**/api/salon',async route=>{
   const body=route.request().postDataJSON();
   if(body.operation==='cash_checkout'){
    writes.push(body);
    if(mode==='drop'){mode='normal';await route.fetch();return route.abort('failed');}
   }
   if(body.operation==='request_lookup'&&mode==='bad-readback'){
    mode='normal';const response=await route.fetch(),body=await response.json();body.data.receipt.paymentId+=100;
    return route.fulfill({response,json:body});
   }
   return route.continue();
  });
  const connect=async()=>{await page.locator('#connect').click();await page.getByText('已连接临时数据库；所有操作只影响本次合成数据。',{exact:true}).waitFor();};
  const load=async o=>{await page.locator('#listOrders').click();await page.locator(`#orderList article[data-order-id="${o.id}"]`).getByText('载入订单处理',{exact:true}).click();await page.getByText('已载入订单处理，尚未修改状态或收款。',{exact:true}).waitFor();};
  const preview=async()=>{await page.locator('#cashTendered').fill('20');await page.locator('#cashPreview').click();await page.getByText('已重新核对订单并生成现金预览；没有提交收款。',{exact:true}).waitFor();};
  const journal=()=>page.evaluate(()=>sessionStorage.getItem('salon.pending.v1:1:1:1'));
  await page.goto(app.url);await connect();await load(order);await preview();
  assert.equal(await page.locator('#cashConfirm').isDisabled(),false);
  await page.locator('#cashTendered').fill('21');assert.equal(await page.locator('#cashConfirm').isDisabled(),true);await preview();
  mode='drop';await page.locator('#cashConfirm').click();await page.getByText(/未收到有效结果/).waitFor();
  assert.equal(app.sql(`select count(*) from public.salon_payments where order_id=${order.id}`),'1');
  const pending=JSON.parse(await journal());assert.deepEqual(Object.keys(pending.requests[0]).sort(),['operation','requestKey']);
  assert.equal(await page.locator('#panel').evaluate(el=>el.disabled),true);assert.equal(await page.locator('#createOrder').isDisabled(),true);
  if(width===1280){
   await page.locator('#retry').click();await page.getByText('现金收款已提交，并按原请求核对支付记录；未扣会员。',{exact:true}).waitFor();
   assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
  }else{
   app.sql(`update public.salon_orders set status='reversed',refunded_total=payable_total where id=${order.id};update public.salon_payments set status='reversed' where order_id=${order.id}`);
   await page.reload();await connect();await page.locator('#lookupRequest').click();await page.getByText('已核对原请求并读取当前记录，没有重新提交业务。',{exact:true}).waitFor();
   assert.equal(writes.length,1);
   assert.match(await page.locator('#cashResult').textContent(),/当前订单：reversed/);
  }
  assert.equal(await journal(),null);assert.match(await page.locator('#cashResult').textContent(),/原现金收款已核对/);assert.equal(await page.locator('#cashConfirm').isDisabled(),true);
  if(width===390)await page.screenshot({path:'/private/tmp/salon-cash-checkout-mobile.png',fullPage:true});
  const bad=makeOrder();await load(bad);await preview();mode='bad-readback';await page.locator('#cashConfirm').click();await page.getByText(/后续回读失败/).waitFor();
  assert.ok(await journal());assert.equal(await page.locator('#retry').isDisabled(),true);assert.equal(await page.locator('#panel').evaluate(el=>el.disabled),true);
  await page.locator('#lookupRequest').click();await page.getByText('已核对原请求并读取当前记录，没有重新提交业务。',{exact:true}).waitFor();assert.equal(await journal(),null);
  const stale=makeOrder();await load(stale);await preview();app.sql(`update public.salon_orders set notes='synthetic version bump' where id=${stale.id}`);
  await page.locator('#cashConfirm').click();await page.getByText(/订单版本已变化/).waitFor();assert.equal(await page.locator('#cashConfirm').isDisabled(),true);assert.equal(await journal(),null);
  assert.equal(app.sql(`select count(*) from public.salon_payments where order_id=${stale.id}`),'0');
  await page.locator('#store').selectOption('2');await page.getByText('已切换门店，旧选择已清除。',{exact:true}).waitFor();assert.equal(await page.locator('#cashResult').textContent(),'');
  assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.close();
 }
 console.log('Cash checkout PG/browser passed: atomic rollback, versions, permissions, race, replay, read-only receipt, loss/refresh, bad receipt, desktop/mobile and no member writes');
}finally{if(browser)await browser.close();if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
