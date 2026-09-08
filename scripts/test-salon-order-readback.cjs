const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startServer}=require('./salon-local-integration.cjs');
(async()=>{let app,browser;try{
 app=await startServer();browser=await chromium.launch({channel:'chrome',headless:true});
 const key='salon.pending.v1:1:1:1';
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:844}}),errors=[];let distort=null,writes=0;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
  await page.route('**/api/salon',async route=>{
   const body=route.request().postDataJSON();
   if(['customer_create','order_create','order_lines'].includes(body.operation))writes++;
   if(distort&&body.operation==='order_detail'){
    const response=await route.fetch(),payload=await response.json();assert.equal(response.status(),200);
    if(distort==='quantity')payload.data.lines[0].quantity=2;
    else payload.data.lines.push({...payload.data.lines[0],id:999999});
    distort=null;await route.fulfill({response,json:payload});
   }else await route.continue();
  });
  await page.goto(app.url);await page.locator('#connect').click();await page.getByText('已连接临时数据库；所有操作只影响本次合成数据。',{exact:true}).waitFor();
  await page.locator('#name').fill(`合成整单核对-${width}`);await page.locator('#createCustomer').click();await page.getByText('顾客已建档并读取确认。',{exact:true}).waitFor();
  await page.locator('#createOrder').click();await page.getByText('订单已创建并读取确认。',{exact:true}).waitFor();
  for(const mode of ['quantity','extra']){
   await page.locator('#item').selectOption('1');distort=mode;await page.locator('#saveLines').click();
   await page.getByText(/订单回读明细与本次提交不一致/).waitFor();
   assert.equal(await page.locator('#retry').isDisabled(),true);
   assert.equal(await page.locator('#createOrder').isDisabled(),true);
   assert.equal(await page.locator('#inspectOrder').isDisabled(),true,'read-only inspection cannot bypass recovery');
   assert.ok(await page.evaluate(k=>sessionStorage.getItem(k),key));const count=writes;
   await page.locator('#lookupRequest').click();await page.getByText('已核对原请求并读取当前记录，没有重新提交业务。',{exact:true}).waitFor();
   assert.equal(writes,count);assert.equal(await page.evaluate(k=>sessionStorage.getItem(k),key),null);
  }
  assert.equal(writes,4);assert.deepEqual(errors,[]);await page.close();
 }
 assert.equal(app.sql('select count(*) from public.salon_orders'),'2');
 assert.equal(app.sql('select count(*) from public.salon_order_lines'),'2');
 assert.equal(app.sql('select sum(quantity) from public.salon_order_lines'),'2.000');
 console.log('Order readback browser passed: 1280/390 quantity/extra-line mismatches block confirmation, preserve journal, and only read-only lookup unlocks without resend');
}finally{if(browser)await browser.close();if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
