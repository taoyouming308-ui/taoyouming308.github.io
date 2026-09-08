// Successful writes followed by failed reads: only read-only recovery may unlock.
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startServer}=require('./salon-local-integration.cjs');
(async()=>{let app,browser;try{
 app=await startServer();browser=await chromium.launch({channel:'chrome',headless:true});
 const key='salon.pending.v1:1:1:1',connected='已连接临时数据库；所有操作只影响本次合成数据。';
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:844}}),writes=[],errors=[];let failedRead=null;
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
  await page.route('**/api/salon',async route=>{
   const body=route.request().postDataJSON();
   if(['customer_create','order_create','order_lines'].includes(body.operation))writes.push(body);
   if(failedRead===body.operation){
    failedRead=null;
    if(width===1280){await route.abort('failed');return;}
    const response=await route.fetch(),payload=await response.json();
    assert.equal(response.status(),200);
    // A syntactically valid read of the wrong/missing resource is not confirmation.
    if(body.operation==='customers')payload.data=[];
    else payload.data.order.id=999999;
    await route.fulfill({response,json:payload});
   }else await route.continue();
  });
  const connect=async()=>{await page.locator('#connect').click();await page.getByText(connected,{exact:true}).waitFor();};
  await page.goto(app.url);await connect();
  const verify=async(operation,button,read)=>{
   failedRead=read;await page.locator(button).click();
   await page.getByText(/写入已经成功，请勿重复创建。后续回读失败/).waitFor();
   assert.equal(await page.locator('#retry').isDisabled(),true,'successful writes must not offer write retries');
   assert.equal(await page.locator('#createCustomer').isDisabled(),true);
   assert.equal(await page.locator('#lookupRequest').isDisabled(),false);
   const pending=await page.evaluate(k=>sessionStorage.getItem(k),key),count=writes.length;
   assert.equal(JSON.parse(pending).requests[0].operation,operation);
   assert.deepEqual(Object.keys(JSON.parse(pending).requests[0]).sort(),['operation','requestKey']);
   // Repeated failure during read-only lookup must preserve the exact record.
   failedRead=read;await page.locator('#lookupRequest').click();
   await page.waitForFunction(()=>!document.getElementById('recoveryPanel').disabled);
   assert.equal(await page.evaluate(k=>sessionStorage.getItem(k),key),pending);
   assert.equal(await page.locator('#createOrder').isDisabled(),true);
   if(operation==='order_lines'){
    await page.reload();await connect();
    assert.equal(await page.evaluate(k=>sessionStorage.getItem(k),key),pending);
    assert.equal(await page.locator('#saveLines').isDisabled(),true);
   }
   await page.locator('#lookupRequest').click();
   await page.getByText('已核对原请求并读取当前记录，没有重新提交业务。',{exact:true}).waitFor();
   assert.equal(writes.length,count,'recovery cannot issue any business writes');
   assert.equal(await page.evaluate(k=>sessionStorage.getItem(k),key),null);
   assert.equal(await page.locator('#createCustomer').isDisabled(),false);
  };
  await page.locator('#name').fill(`合成回读失败-${width}`);
  await verify('customer_create','#createCustomer','customers');
  assert.equal(await page.locator('#customer option:checked').textContent(),`合成回读失败-${width}`);
  await verify('order_create','#createOrder','order_detail');
  await page.locator('#item').selectOption('1');
  await verify('order_lines','#saveLines','order_detail');
  assert.equal(writes.length,3);assert.equal(await page.locator('#saveLines').isDisabled(),false);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);await page.close();
 }
 // Another operator may advance the order after a write commits, before readback.
 for(const operation of ['order_create','order_lines']){
  const page=await browser.newPage({viewport:{width:390,height:844}});let advanced=false;
  await page.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
  await page.route('**/api/salon',async route=>{
   if(!advanced&&route.request().postDataJSON().operation===operation){
    const response=await route.fetch();assert.equal(response.status(),200);
    const payload=await response.json(),id=Number(payload.data.orderId);assert.ok(Number.isSafeInteger(id)&&id>0);
    app.sql(`update public.salon_orders set status='opened' where id=${id}`);advanced=true;
    await route.fulfill({response});
   }else await route.continue();
  });
  await page.goto(app.url);await page.locator('#connect').click();await page.getByText(connected,{exact:true}).waitFor();
  await page.locator('#customer').selectOption('1');await page.locator('#createOrder').click();
  await page.getByText('订单已创建并读取确认。',{exact:true}).waitFor();
  if(operation==='order_lines'){
   await page.locator('#item').selectOption('1');await page.locator('#saveLines').click();
   await page.getByText(/明细已保存并读取验证/).waitFor();
  }else assert.match(await page.locator('#order').textContent(),/opened/);
  await page.locator('#panel:not([disabled])').waitFor();
  assert.equal(advanced,true);assert.equal(await page.locator('#saveLines').isDisabled(),true);
  assert.equal(await page.evaluate(k=>sessionStorage.getItem(k),key),null);await page.close();
 }
 assert.equal(app.sql('select count(*) from public.salon_customers'),'2');
 assert.equal(app.sql('select count(*) from public.salon_orders'),'4');
 assert.equal(app.sql('select count(*) from public.salon_order_lines'),'3');
 console.log('Readback recovery passed: 1280/390, 3 successful writes followed by unavailable/mismatched reads, repeated lookup failure, refresh, no duplicate writes and current-status editing guards');
}finally{if(browser)await browser.close();if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
