const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startServer}=require('./salon-local-integration.cjs');
(async()=>{let app,browser;try{
 app=await startServer();browser=await chromium.launch({channel:'chrome',headless:true});
 app.sql("insert into public.salon_catalog_items(organization_id,item_type,code,name,list_price,duration_minutes) values(1,'service','MULTI','合成护理 <img src=x>',80,30);insert into public.salon_catalog_store_settings(organization_id,store_id,catalog_item_id,stock_tracked) values(1,1,2,false)");
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:844}}),writes=[],errors=[];let lose=false,rejectDialog=false;
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>rejectDialog?d.dismiss():d.accept());
  await page.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
  await page.route('**/api/salon',async route=>{
   const body=route.request().postDataJSON();if(body.operation==='order_lines')writes.push(body);
   if(lose&&body.operation==='order_lines'){lose=false;await route.fetch();await route.abort('failed');}else await route.continue();
  });
  const connect=async()=>{await page.locator('#connect').click();await page.getByText('已连接临时数据库；所有操作只影响本次合成数据。',{exact:true}).waitFor();};
  const rows=()=>page.locator('#draftRows article');
  const qty=async(index,value)=>{await rows().nth(index).locator('input').fill(value);await rows().nth(index).locator('input').press('Tab');};
  await page.goto(app.url);await connect();await page.locator('#name').fill(`多项目合成-${width}`);await page.locator('#createCustomer').click();await page.getByText('顾客已建档并读取确认。',{exact:true}).waitFor();
  await page.locator('#createOrder').click();await page.getByText('订单已创建并读取确认。',{exact:true}).waitFor();
  await page.locator('#item').selectOption('1');await page.locator('#addItem').click();await page.locator('#addItem').click();
  await page.locator('#item').selectOption('2');await page.locator('#addItem').click();assert.equal(await rows().count(),3);
  await qty(0,'2');await rows().nth(1).locator('button').click();await qty(1,'0.5');assert.equal(writes.length,0);
  assert.equal(await page.locator('#draftRows img').count(),0);
  rejectDialog=true;await page.locator('#store').selectOption('2');assert.equal(await page.locator('#store').inputValue(),'1');assert.equal(await rows().count(),2);rejectDialog=false;
  lose=true;await page.locator('#saveLines').click();await page.locator('#retry:not([disabled])').waitFor();assert.equal(await page.locator('#addItem').isDisabled(),true);
  await page.locator('#retry').click();await page.getByText(/明细已保存并读取验证/).waitFor();assert.deepEqual(writes[0],writes[1]);assert.equal(writes[0].lines.length,2);
  const id=Number(app.sql('select max(id) from public.salon_orders'));assert.equal(app.sql(`select payable_total from public.salon_orders where id=${id}`),'64.68');
  assert.match(await page.locator('#draftSummary').textContent(),/与最近读取记录一致/);
  if(width===390)await page.screenshot({path:'/private/tmp/salon-multiline-editor-mobile.png',fullPage:true});
  await qty(0,'3');lose=true;await page.locator('#saveLines').click();await page.locator('#retry:not([disabled])').waitFor();
  const count=writes.length;await page.reload();await connect();await page.locator('#lookupRequest').click();await page.getByText('已核对原请求并读取当前记录，没有重新提交业务。',{exact:true}).waitFor();
  assert.equal(writes.length,count);assert.equal(await rows().count(),2);assert.equal(await rows().nth(0).locator('input').inputValue(),'3');assert.equal(await rows().nth(1).locator('input').inputValue(),'0.5');
  await qty(1,'1');await page.locator('#saveLines').click();await page.getByText(/明细已保存并读取验证/).waitFor();
  assert.equal(app.sql(`select count(*) from public.salon_order_lines where order_id=${id}`),'2');assert.equal(app.sql(`select payable_total from public.salon_orders where id=${id}`),'117.02');
  await rows().nth(0).locator('button').click();await rows().nth(0).locator('button').click();const before=writes.length;
  await page.locator('#saveLines').click();await page.getByText(/请先添加至少一个项目/).waitFor();assert.equal(writes.length,before);
  await page.locator('#store').selectOption('2');await page.getByText('已切换门店，旧选择已清除。',{exact:true}).waitFor();assert.equal(await rows().count(),0);assert.equal(await page.locator('#addItem').isDisabled(),true);
  // A draft with service progress must not be reset through whole-order replacement.
  app.sql(`update public.salon_order_lines set service_status='completed' where order_id=${id}`);
  await page.evaluate(requestKey=>sessionStorage.setItem('salon.pending.v1:1:1:1',JSON.stringify({version:1,requests:[{operation:'order_lines',requestKey}]})),writes.at(-1).requestKey);
  await page.reload();await connect();await page.locator('#lookupRequest').click();await page.getByText('已核对原请求并读取当前记录，没有重新提交业务。',{exact:true}).waitFor();
  assert.equal(await rows().count(),2);assert.equal(await page.locator('#saveLines').isDisabled(),true);assert.equal(await rows().nth(0).locator('input').isDisabled(),true);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Multi-line editor browser passed: 1280/390 add/remove/quantity, full save, frozen retry, refresh recovery preserves all lines, continued editing, empty guard and discard confirmation');
}finally{if(browser)await browser.close();if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
