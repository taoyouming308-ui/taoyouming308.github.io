const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startServer}=require('./salon-local-integration.cjs');
(async()=>{let app,browser;try{
 app=await startServer();
 app.sql(`insert into public.salon_orders(organization_id,store_id,order_no) select 1,1,'合成单-'||n from generate_series(1,53) n;
 insert into public.salon_orders(organization_id,store_id,order_no,status) values(1,1,'<img src=x>','paid'),(1,2,'乙店单','draft');`);
 const list=(args="1,1,1,'',null")=>JSON.parse(app.sql(`set role service_role;begin read only;select public.salon_list_orders(${args});commit;`));
 const before=app.sql('select jsonb_agg(o order by id) from public.salon_orders o');
 const first=list();assert.equal(first.rows.length,50);assert.equal(first.rows[0].id,54);assert.equal(first.nextBeforeId,5);
 const next=list("1,1,1,'',5");assert.deepEqual(next.rows.map(r=>r.id),[4,3,2,1]);assert.equal(next.nextBeforeId,null);
 assert.deepEqual(Object.keys(first.rows[0]).sort(),['created_at','id','order_no','status']);
 assert.equal(list("1,1,1,'paid',null").rows.length,1);assert.equal(list("1,1,2,'',null").rows[0].id,55);
 for(const args of ["1,1,3,'',null","1,2,1,'',null","1,1,1,'bad',null","1,1,1,'',0"])assert.throws(()=>list(args));
 assert.equal(app.sql("select has_function_privilege('anon','public.salon_list_orders(bigint,bigint,bigint,text,bigint)','execute') or has_function_privilege('authenticated','public.salon_list_orders(bigint,bigint,bigint,text,bigint)','execute')"),'f');
 app.sql("delete from public.salon_role_permissions where resource='orders' and action='read'");assert.throws(()=>list());
 app.sql("insert into public.salon_role_permissions(role_id,resource,action) values(1,'orders','read')");
 assert.equal(app.sql('select jsonb_agg(o order by id) from public.salon_orders o'),before);
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:844}}),writes=[],errors=[];let dismiss=false,fail=false;
  page.on('dialog',d=>dismiss?d.dismiss():d.accept());page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).origin===app.url?r.continue():r.abort());
  await page.route('**/api/salon',async r=>{const b=r.request().postDataJSON();if(['order_lines','order_create','customer_create'].includes(b.operation))writes.push(b);if(fail&&b.operation==='orders'){fail=false;await r.abort('failed');}else await r.continue();});
  await page.goto(app.url);await page.locator('#connect').click();await page.getByText('已连接临时数据库；所有操作只影响本次合成数据。',{exact:true}).waitFor();
  const query=async()=>{await page.locator('#listOrders').click();await page.getByText(/本页 50 单/).waitFor();};
  const row=id=>page.locator(`#orderList article[data-order-id="${id}"]`);
  await query();assert.equal(await page.locator('#orderList article').count(),50);assert.equal(await page.locator('#orderList img').count(),0);
  await row(54).getByRole('button',{name:'查看',exact:true}).click();await page.getByText('原单已只读查询；未修改订单或当前编辑对象。',{exact:true}).waitFor();assert.equal(await page.locator('#saveLines').isDisabled(),true);
  await page.locator('#nextOrders').click();await page.getByText(/本页 4 单/).waitFor();assert.equal(await page.locator('#nextOrders').isDisabled(),true);
  await query();await row(53).getByText('载入草稿编辑',{exact:true}).click();await page.getByText(/已重新读取并载入草稿/).waitFor();
  assert.equal(writes.length,0);await page.locator('#item').selectOption('1');await page.locator('#addItem').click();
  dismiss=true;await row(52).getByText('载入草稿编辑',{exact:true}).click();assert.match(await page.locator('#order').textContent(),/编号 53/);dismiss=false;
  await page.locator('#saveLines').click();await page.getByText(/明细已保存并读取验证/).waitFor();assert.equal(writes.at(-1).orderId,53);
  await page.reload();await page.locator('#connect').click();await page.getByText('已连接临时数据库；所有操作只影响本次合成数据。',{exact:true}).waitFor();await query();
  await row(53).getByText('载入草稿编辑',{exact:true}).click();await page.getByText(/已重新读取并载入草稿/).waitFor();assert.ok(await page.locator('#draftRows article').count()>=1);
  // State may change after listing; never trust a cached draft button.
  app.sql("update public.salon_orders set status='opened' where id=52");await row(52).getByText('载入草稿编辑',{exact:true}).click();await page.getByText(/该订单当前不能编辑/).waitFor();assert.match(await page.locator('#order').textContent(),/编号 53/);
  app.sql("update public.salon_orders set status='draft' where id=52");
  // Loaded version still protects subsequent saves from a different writer.
  app.sql('update public.salon_orders set subtotal=subtotal where id=53');await page.locator('#saveLines').click();await page.getByText(/订单版本已变化/).waitFor();assert.equal(await page.locator('#saveLines').isDisabled(),true);
  await page.locator('#leaveDraft').click();await page.getByText(/已离开编辑/).waitFor();assert.equal(await page.locator('#draftRows article').count(),0);
  await page.locator('#orderFilter').selectOption('paid');assert.equal(await page.locator('#orderList article').count(),0);await page.locator('#listOrders').click();await page.getByText(/本页 1 单/).waitFor();assert.equal(await row(54).getByText('载入草稿编辑',{exact:true}).count(),0);
  if(width===390)await page.screenshot({path:'/private/tmp/salon-order-list-mobile.png',fullPage:true});
  fail=true;await page.locator('#listOrders').click();await page.getByText(/未收到有效结果/).waitFor();assert.equal(await page.locator('#orderList article').count(),0);
  await page.locator('#store').selectOption('2');await page.getByText('已切换门店，旧选择已清除。',{exact:true}).waitFor();await page.locator('#orderFilter').selectOption('');await page.locator('#listOrders').click();await page.getByText(/本页 1 单/).waitFor();assert.equal(await row(55).count(),1);
  await page.locator('#logout').click();await page.getByText('已退出本次测试会话；旧请求不能继续提交。',{exact:true}).waitFor();assert.equal(await page.locator('#orderList article').count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Order list PG/browser passed: scoped read-only keyset pagination, privilege, 1280/390 list/view/edit/reload/save, dirty guard, stale state/version, failure and logout');
}finally{if(browser)await browser.close();if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
