const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startServer}=require('./salon-local-integration.cjs');
(async()=>{let app,browser;try{
 app=await startServer();browser=await chromium.launch({channel:'chrome',headless:true});
 const key='salon.pending.v1:1:1:1',connected='已连接临时数据库；所有操作只影响本次合成数据。';
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:844}}),errors=[],writes=[];let drop=null;
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
  await page.route('**/api/salon',async route=>{
   const body=route.request().postDataJSON();
   if(['customer_create','order_create','order_lines'].includes(body.operation))writes.push(body.operation);
   if(drop===body.operation){drop=null;await route.fetch();await route.abort('failed');}else await route.continue();
  });
  const connect=async()=>{await page.locator('#connect').click();await page.getByText(connected,{exact:true}).waitFor();};
  await page.goto(app.url);await connect();
  const recover=async(operation,button)=>{
   drop=operation;await page.locator(button).click();await page.locator('#retry:not([disabled])').waitFor();
   const raw=await page.evaluate(k=>sessionStorage.getItem(k),key),parsed=JSON.parse(raw);
   assert.deepEqual(Object.keys(parsed).sort(),['requests','version']);assert.equal(parsed.requests.length,1);
   assert.deepEqual(Object.keys(parsed.requests[0]).sort(),['operation','requestKey']);assert.equal(parsed.requests[0].operation,operation);
   if(width===390&&operation==='order_lines')app.sql("update public.salon_orders set status='opened' where id=(select max(id) from public.salon_orders)");
   const count=writes.length;await page.reload();assert.equal(await page.locator('#recoveryRequest option').count(),0);
   await connect();assert.equal(await page.locator('#createOrder').isDisabled(),true);assert.equal(await page.locator('#lookupRequest').isDisabled(),false);
   assert.equal(writes.length,count,'reload/connect must never replay a mutation');
   await page.locator('#lookupRequest').click();await page.getByText('已核对原请求并读取当前记录，没有重新提交业务。',{exact:true}).waitFor();
   assert.equal(writes.length,count);assert.equal(await page.evaluate(k=>sessionStorage.getItem(k),key),null);
  };
  await page.locator('#name').fill(`合成恢复顾客-${width}`);await recover('customer_create','#createCustomer');
  assert.equal(await page.locator('#customer option:checked').textContent(),`合成恢复顾客-${width}`);
  await recover('order_create','#createOrder');assert.match(await page.locator('#order').textContent(),/已恢复订单.*draft/);
  await page.locator('#item').selectOption('1');await recover('order_lines','#saveLines');
  assert.equal(writes.length,3);assert.equal(await page.locator('#saveLines').isDisabled(),width===390);
  if(width===390){assert.match(await page.locator('#order').textContent(),/opened/);await page.screenshot({path:'/private/tmp/salon-recovery-mobile.png',fullPage:true});}
  // Unknown receipt remains blocked across refresh; malformed receipts cannot dismiss it.
  await page.evaluate(k=>sessionStorage.setItem(k,JSON.stringify({version:1,requests:[{operation:'order_create',requestKey:'unknown-request-001'}]})),key);
  await page.reload();await connect();await page.locator('#lookupRequest').click();await page.getByText(/尚未确认结果，原请求保留/).waitFor();
  assert.equal(await page.locator('#createOrder').isDisabled(),true);assert.ok(await page.evaluate(k=>sessionStorage.getItem(k),key));
  await page.route('**/api/salon',async route=>{
   if(route.request().postDataJSON().operation==='request_lookup')await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:{operation:'order_create',status:'committed',resourceType:'order',resourceId:'wrong-id',completedAt:'2026-09-07T00:00:00Z'}})});
   else await route.fallback();
  });
  await page.locator('#lookupRequest').click();await page.getByText(/必须使用接口返回的安全整数 ID/).waitFor();
  assert.ok(await page.evaluate(k=>sessionStorage.getItem(k),key));assert.equal(writes.length,3);
  // Corruption is not erased or echoed; no reset-to-empty escape hatch.
  await page.evaluate(k=>sessionStorage.setItem(k,'broken-private-content'),key);await page.reload();await connect();
  await page.getByText(/待核对清单损坏或存储不可用/).waitFor();assert.equal(await page.locator('#createCustomer').isDisabled(),true);
  assert.equal(await page.evaluate(k=>sessionStorage.getItem(k),key),'broken-private-content');
  assert.doesNotMatch(await page.locator('body').textContent(),/broken-private-content/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  await page.close();
 }
 const quota=await browser.newPage();let writes=0;
 await quota.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('salon.pending.v1:'))throw Error('synthetic quota');return original.call(this,k,v);};});
 await quota.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
 quota.on('request',r=>{if(r.url().endsWith('/api/salon')&&r.postDataJSON()?.operation==='customer_create')writes++;});
 await quota.goto(app.url);await quota.locator('#connect').click();await quota.getByText(connected,{exact:true}).waitFor();
 await quota.locator('#name').fill('不可发送');await quota.locator('#createCustomer').click();await quota.getByText(/待核对清单损坏或存储不可用/).waitFor();
 assert.equal(writes,0);assert.equal(await quota.locator('#createCustomer').isDisabled(),true);await quota.close();
 // A rejected retry after an unknown commit must retain the recovery metadata.
 const denied=await browser.newPage();let lost=false;
 await denied.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
 await denied.route('**/api/salon',async route=>{
  if(!lost&&route.request().postDataJSON().operation==='order_create'){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();
 });
 await denied.goto(app.url);await denied.locator('#connect').click();await denied.getByText(connected,{exact:true}).waitFor();
 await denied.locator('#customer').selectOption('1');await denied.locator('#createOrder').click();await denied.locator('#retry:not([disabled])').waitFor();
 const pending=await denied.evaluate(k=>sessionStorage.getItem(k),key);
 app.sql("delete from public.salon_role_permissions where role_id=1 and resource='orders' and action='write'");
 await denied.locator('#retry').click();await denied.getByText('会话已锁定，旧业务选择已清除；请重新连接。',{exact:true}).waitFor();
 assert.equal(await denied.evaluate(k=>sessionStorage.getItem(k),key),pending,'rejected retry must not erase an earlier unknown commit');
 app.sql("insert into public.salon_role_permissions(role_id,resource,action) values(1,'orders','write')");
 await denied.locator('#connect').click();await denied.getByText(connected,{exact:true}).waitFor();await denied.locator('#lookupRequest').click();
 await denied.getByText('已核对原请求并读取当前记录，没有重新提交业务。',{exact:true}).waitFor();await denied.close();
 assert.equal(app.sql('select count(*) from public.salon_customers'),'2');assert.equal(app.sql('select count(*) from public.salon_orders'),'3');
 assert.equal(app.sql('select count(*) from public.salon_order_lines'),'2');
 console.log('Recovery browser passed: 1280/390 lost-response reload for 3 operations, read-only recovery, no duplicate rows, unknown/malformed/corrupt protection and storage failure before send');
}finally{if(browser)await browser.close();if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
