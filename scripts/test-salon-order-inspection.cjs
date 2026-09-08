const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startServer}=require('./salon-local-integration.cjs');
(async()=>{let app,browser;try{
 app=await startServer();browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:844}}),writes=[],errors=[];let failRead=false;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
  await page.route('**/api/salon',async route=>{
   const body=route.request().postDataJSON();
   if(['customer_create','order_create','order_lines'].includes(body.operation))writes.push(body);
   if(failRead&&body.operation==='order_detail'){failRead=false;await route.abort('failed');}else await route.continue();
  });
  const connect=async()=>{await page.locator('#connect').click();await page.getByText('已连接临时数据库；所有操作只影响本次合成数据。',{exact:true}).waitFor();};
  const inspect=async id=>{await page.locator('#inspectOrderId').fill(String(id));await page.locator('#inspectOrder').click();await page.getByText('原单已只读查询；未修改订单或当前编辑对象。',{exact:true}).waitFor();};
  await page.goto(app.url);await connect();await page.locator('#name').fill(`合成查询-${width}`);await page.locator('#createCustomer').click();
  await page.getByText('顾客已建档并读取确认。',{exact:true}).waitFor();await page.locator('#createOrder').click();await page.getByText('订单已创建并读取确认。',{exact:true}).waitFor();
  const id=Number(app.sql('select max(id) from public.salon_orders'));
  await page.locator('#item').selectOption('1');if(await page.locator('#draftRows article').count()===0)await page.locator('#addItem').click();await page.locator('#saveLines').click();await page.getByText(/明细已保存并读取验证/).waitFor();
  // Synthetic text snapshot is deliberately HTML-like; only text may be rendered.
  app.sql(`update public.salon_order_lines set item_name='<img src=x onerror=alert(1)>' where order_id=${id}`);
  const snapshot=()=>app.sql(`select jsonb_build_object('orders',(select jsonb_agg(o) from public.salon_orders o),'lines',(select jsonb_agg(l) from public.salon_order_lines l))`);
  const before=snapshot(),count=writes.length;
  await page.reload();await connect();await inspect(id);
  assert.match(await page.locator('#orderInspection').textContent(),/应收 ¥12.34/);
  assert.match(await page.locator('#orderInspection').textContent(),/<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('#orderInspection img').count(),0);
  assert.equal(await page.locator('#order').textContent(),'尚未创建订单');assert.equal(await page.locator('#saveLines').isDisabled(),true);
  if(width===390)await page.screenshot({path:'/private/tmp/salon-order-inspection-mobile.png',fullPage:true});
  failRead=true;await page.locator('#inspectOrder').click();await page.getByText(/未收到有效结果/).waitFor();
  assert.equal(await page.locator('#orderInspection').textContent(),'');await inspect(id);
  await page.locator('#inspectOrderId').fill('999999');assert.equal(await page.locator('#orderInspection').textContent(),'');
  await page.locator('#inspectOrder').click();await page.getByText(/订单不存在或不属于当前门店/).waitFor();
  assert.equal(await page.locator('#orderInspection').textContent(),'');
  await page.locator('#store').selectOption('2');await page.getByText('已切换门店，旧选择已清除。',{exact:true}).waitFor();
  await page.locator('#inspectOrderId').fill(String(id));await page.locator('#inspectOrder').click();await page.getByText(/订单不存在或不属于当前门店/).waitFor();
  assert.equal(await page.locator('#orderInspection').textContent(),'');
  await page.locator('#store').selectOption('1');await page.getByText('已切换门店，旧选择已清除。',{exact:true}).waitFor();await inspect(id);
  assert.equal(snapshot(),before);assert.equal(writes.length,count,'inspection cannot write');
  await page.locator('#logout').click();await page.getByText('已退出本次测试会话；旧请求不能继续提交。',{exact:true}).waitFor();
  assert.equal(await page.locator('#orderInspection').textContent(),'');assert.equal(await page.locator('#inspectOrderId').inputValue(),'');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Order inspection browser passed: 1280/390, reload, read-only snapshots, failed/missing/cross-store queries, text safety, no editor binding and logout clear');
}finally{if(browser)await browser.close();if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
