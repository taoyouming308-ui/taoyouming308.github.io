const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startServer}=require('./salon-local-integration.cjs');
(async()=>{let app,browser;try{
 app=await startServer();browser=await chromium.launch({channel:'chrome',headless:true});
 const call=q=>JSON.parse(app.sql(`set role service_role;select ${q}`));
 for(const width of [1280,390]){
  const id=Number(app.sql(`insert into public.salon_orders(organization_id,store_id,order_no) values(1,1,'合成现金-${width} <img src=x>') returning id`));
  call(`public.salon_replace_order_lines_versioned(1,1,1,${id},'cash-preview-${width}-lines','[{"catalogItemId":1,"quantity":1,"unitPrice":12.34}]'::jsonb,'',0)`);
  app.sql(`update public.salon_orders set status='awaiting_payment' where id=${id}`);
  const snapshot=()=>app.sql("select jsonb_build_object('orders',(select jsonb_agg(o order by id) from public.salon_orders o),'payments',(select jsonb_agg(p) from public.salon_payments p),'ledger',(select jsonb_agg(l) from public.salon_account_ledger l),'stock',(select jsonb_agg(i) from public.salon_inventory_ledger i),'requests',(select jsonb_agg(r order by id) from public.salon_operation_requests r))");
  const page=await browser.newPage({viewport:{width,height:844}}),operations=[],errors=[];let fail=false;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
  await page.route('**/api/salon',async r=>{const b=r.request().postDataJSON();operations.push(b.operation);if(fail&&b.operation==='order_detail'){fail=false;return r.abort('failed');}return r.continue();});
  await page.goto(app.url);await page.locator('#connect').click();await page.getByText('已连接临时数据库；所有操作只影响本次合成数据。',{exact:true}).waitFor();
  const load=async()=>{await page.locator('#listOrders').click();await page.locator(`#orderList article[data-order-id="${id}"]`).getByText('载入订单处理',{exact:true}).click();await page.getByText('已载入订单处理，尚未修改状态或收款。',{exact:true}).waitFor();};
  const preview=async input=>{await page.locator('#cashTendered').fill(input);await page.locator('#cashPreview').click();await page.getByText('已重新核对订单并生成现金预览；没有提交收款。',{exact:true}).waitFor();};
  await load();const before=snapshot();await preview('20');assert.match(await page.locator('#cashResult').textContent(),/应找零 ¥7.66/);assert.equal(await page.locator('#cashResult img').count(),0);
  await page.locator('#cashTendered').fill('12.33');assert.equal(await page.locator('#cashResult').textContent(),'');await page.locator('#cashPreview').click();await page.getByText(/拟收现金不足/).waitFor();assert.equal(await page.locator('#cashResult').textContent(),'');
  await preview('12.35');assert.match(await page.locator('#cashResult').textContent(),/应找零 ¥0.01/);
  if(width===390)await page.screenshot({path:'/private/tmp/salon-cash-preview-mobile.png',fullPage:true});
  fail=true;await page.locator('#cashPreview').click();await page.getByText(/未收到有效结果/).waitFor();assert.equal(await page.locator('#cashResult').textContent(),'');assert.equal(snapshot(),before);
  app.sql(`update public.salon_orders set payable_total=13 where id=${id}`);await page.locator('#cashPreview').click();await page.getByText(/订单已变化或范围不匹配/).waitFor();assert.equal(await page.locator('#cashResult').textContent(),'');
  await load();assert.equal(await page.locator('#cashTendered').inputValue(),'');await preview('20');assert.match(await page.locator('#cashResult').textContent(),/应找零 ¥7.00/);
  app.sql(`update public.salon_orders set status='paid' where id=${id}`);await page.locator('#cashPreview').click();await page.getByText(/订单已变化或范围不匹配/).waitFor();assert.equal(await page.locator('#cashResult').textContent(),'');
  await page.locator('#store').selectOption('2');await page.getByText('已切换门店，旧选择已清除。',{exact:true}).waitFor();assert.equal(await page.locator('#cashTendered').inputValue(),'');assert.equal(await page.locator('#cashPreview').isDisabled(),true);
  assert.ok(operations.every(op=>['context','stores','store_time','reschedule_requests','customers','catalog','booking_requests','orders','order_detail'].includes(op)),'cash preview must never send a mutation');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('salon.pending.v1:1:1:1')),null);
  await page.locator('#logout').click();await page.getByText('已退出本次测试会话；旧请求不能继续提交。',{exact:true}).waitFor();assert.equal(await page.locator('#cashResult').textContent(),'');assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.close();
 }
 console.log('Cash preview browser passed: 1280/390 scoped fresh reads, precise change, invalid/stale/failed clearing, store/logout reset and zero writes');
}finally{if(browser)await browser.close();if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
