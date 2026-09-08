import {mapRows,serverId} from './api-client.mjs';
import {createSalonSession} from './session-controller.mjs';
import {withRequestDeadline} from './request-deadline.mjs';
import {createRecoveryJournal,recoverableOperations} from './recovery-journal.mjs';
import {instantToStoreInput,storeTimeToInstant,formatStoreInstant,storeTimeContext} from './store-time.mjs';
let timeZone=null,timeVersion=null;
const $=id=>document.getElementById(id);
let client,customers=[],items=[],cancelRequests=[],rescheduleRequests=[],orderId=null,retry=null,viewRevision=0,signingOut=false,logoutUnconfirmed=false;
let journalFault=false,running=false;
const status=text=>{$('status').textContent=text;};
const journal=()=>createRecoveryJournal(()=>sessionStorage,client.scope);
function renderRecovery(){
 const selected=$('recoveryRequest').value;$('recoveryRequest').replaceChildren(new Option('请选择',''));$('recoveryPanel').disabled=true;
 if(!client?.scope){$('recoveryStatus').textContent='请先连接并验证身份。';return;}
 try{
  const rows=journal().list();
  for(const row of rows)$('recoveryRequest').add(new Option(`${row.operation} · ${row.requestKey}`,row.requestKey));
  if(rows.length===1)$('recoveryRequest').value=rows[0].requestKey;else $('recoveryRequest').value=selected;
  if(rows.length||journalFault)$('panel').disabled=true;
  $('recoveryPanel').disabled=signingOut||logoutUnconfirmed||!!retry||!rows.length||journalFault;
  if(rows.length)$('recoveryStatus').textContent=retry?'原请求仍在本页，请先使用“按原请求重试”。':'发现待核对请求。请只读查询，不要重新开单。';
  else if(!journalFault)$('recoveryStatus').textContent='本店暂无待核对请求。';
 }catch(error){journalFault=true;$('panel').disabled=true;$('recoveryStatus').textContent=error.message;}
}
function options(id,rows,label){
 if(id==='changeRequest')$('changeDetails').textContent='选择申请后查看原时间、新时间与申请原因。';
 const select=$(id);select.replaceChildren(new Option('请选择',''));
 for(const row of rows)select.add(new Option(label(row),String(row.id)));
}
function clear(){timeZone=null;$('timeZone').textContent='门店时区未加载';options('changeRequest',[],()=>{});$('changeReason').value='';customers=[];items=[];cancelRequests=[];rescheduleRequests=[];orderId=null;retry=null;options('customer',[],()=>{});options('item',[],()=>{});options('cancelRequest',[],()=>{});options('rescheduleRequest',[],()=>{});$('rescheduleStart').value='';$('rescheduleReason').value='';$('cancelReason').value='';$('order').textContent='尚未创建订单';$('saveLines').disabled=true;}
async function refresh(){
 timeZone=null;$('timeZone').textContent='正在读取门店时区';
 const config=await client.read('store_time');
 timeZone=storeTimeContext(config.data,client.scope.organizationId,client.scope.storeId);timeVersion=config.data.timeVersion;$('timeZone').textContent=`当前门店时区：${timeZone}（不使用设备时区）`;
 const changes=await client.read('reschedule_requests',{status:'submitted'});
 options('changeRequest',changes.data,row=>`申请 ${row.id} · 预约 ${row.booking_request_id} · ${formatStoreInstant(row.expected_starts_at,timeZone)} → ${formatStoreInstant(row.new_starts_at,timeZone)} · ${row.request_reason}`);
 const [customerResult,itemResult,cancelResult,rescheduleResult]=await Promise.all([client.read('customers'),client.read('catalog',{status:'active'}),client.read('booking_requests',{status:'cancel_requested'}),client.read('booking_requests',{status:'confirmed'})]);
 customers=mapRows('customers',customerResult.data,client.scope);items=mapRows('catalog',itemResult.data,client.scope);
 options('customer',customers,row=>row.displayName);options('item',items,row=>`${row.name} · ¥${(row.listPriceCents/100).toFixed(2)}`);
 cancelRequests=cancelResult.data.map(row=>({id:serverId(row.id),startsAt:row.starts_at}));
 options('cancelRequest',cancelRequests,row=>`申请 ${row.id} · ${formatStoreInstant(row.startsAt,timeZone)}`);
 rescheduleRequests=rescheduleResult.data.map(row=>({id:serverId(row.id),startsAt:row.starts_at,endsAt:row.ends_at,version:row.reschedule_version}));
 options('rescheduleRequest',rescheduleRequests,row=>`申请 ${row.id} · ${formatStoreInstant(row.startsAt,timeZone)}`);$('rescheduleStart').value='';
}
async function verifyTimeZone(){
 const result=await client.read('store_time'),current=storeTimeContext(result.data,client.scope.organizationId,client.scope.storeId);
 if(!timeZone||current!==timeZone||result.data.timeVersion!==timeVersion)throw Error('门店时区已变化或未加载，请刷新本店数据后重新填写');
}
async function run(action){
 if(running)return;
 if(signingOut||logoutUnconfirmed){status('退出未确认，请重试退出；禁止继续业务。');return;}
 running=true;$('recoveryPanel').disabled=true;
 const epoch=viewRevision;
 $('panel').disabled=true;$('connect').disabled=true;$('retry').disabled=true;
 try{await action();}
 catch(error){if(epoch===viewRevision)status(`${error.message}${error.requestId?'\n追踪号：'+error.requestId:''}${retry?'\n当前原请求保留；请先重试核对，不要另建业务。':''}`);}
 finally{running=false;if(epoch===viewRevision){$('panel').disabled=!client?.scope||Boolean(retry);$('connect').disabled=Boolean(retry);$('retry').disabled=!retry;$('logout').disabled=!client?.scope;for(const id of ['rescheduleRequest','rescheduleStart','rescheduleBooking','changeRequest','approveChange','rejectChange'])$(id).disabled=!timeZone;renderRecovery();}}
}
async function mutate(operation,fields,onSuccess){
 if(journalFault||journal().list().length)throw Error('待核对清单未解决，禁止新建业务。');
 const ticket=client.prepare(operation,fields);
 const tracked=recoverableOperations.includes(operation),pendingJournal=journal();
 let hadUnknownResult=false;
 if(tracked)try{pendingJournal.remember(ticket);}catch(error){journalFault=true;throw error;}
 retry=async()=>{
  let result;
  try{result=await client.submit(ticket);}catch(error){
   // A later rejection cannot prove an earlier unknown submission did not commit.
   if(error.code==='API_REJECTED'&&error.httpStatus>=400&&error.httpStatus<500){
    retry=null;if(tracked&&!hadUnknownResult)try{pendingJournal.acknowledge(ticket);}catch(e){journalFault=true;throw e;}
   }else hadUnknownResult=true;
   throw error;
  }
  if(tracked){
   try{
    const id=serverId(result.data?.[operation==='customer_create'?'customerId':'orderId']);
    if(operation==='order_lines'&&id!==fields.orderId)throw Error('返回订单不匹配，请继续核对原请求。');
   }catch(error){hadUnknownResult=true;throw error;}
  }
  retry=null;
  // A successful write is not a completed UI handoff. Retain metadata until
  // the current resource has been read; read failures must never invite a new write.
  status(`写入已保存，正在核对当前记录 · 请求号 ${result.requestId}`);
  try{await onSuccess(result.data);}catch(error){throw Error(`写入已经成功，请勿重复创建。后续回读失败：${error.message}；${tracked?'原请求号已保留，请使用“只读核对原请求”。':''}追踪号 ${result.requestId}`);}
  if(tracked)try{pendingJournal.acknowledge(ticket);}catch(error){journalFault=true;throw Error('写入已成功，但清单更新失败；请勿重复提交。'+error.message);}
 };
 await retry();
}
$('connect').onclick=()=>run(async()=>{
 if(location.protocol!=='http:'||location.hostname!=='127.0.0.1')throw Error('仅允许专用本机测试服务，不能连接线上或直接打开文件');
 clear();client?.dispose();
 const session=await withRequestDeadline(async signal=>{
  const response=await fetch('/__salon_test_session',{method:'POST',cache:'no-store',redirect:'error',signal});
  const result=await response.json();if(!response.ok||result.environment!=='synthetic-local-only')throw Error('不是合成测试环境');return result;
 });
 // Synthetic provider with the same four auth methods; never a production SDK login.
 let localSession={access_token:session.token,user:session.user,expires_at:session.expires_at},listener=()=>{};
 const auth={
  getSession:async()=>({data:{session:localSession}}),
  getUser:async token=>{
   const response=await fetch('/__salon_test_user',{method:'POST',headers:{Authorization:`Bearer ${token}`},cache:'no-store',redirect:'error'});
   return response.ok?response.json():{error:true};
  },
  onAuthStateChange:callback=>{listener=callback;return {data:{subscription:{unsubscribe:()=>{listener=()=>{};}}}};},
  signOut:async()=>{
   // Keep the original synthetic token for retry even if a late completion cleared localSession.
   const response=await fetch('/__salon_test_logout',{method:'POST',headers:{Authorization:`Bearer ${session.token}`},redirect:'error'});
   if(!response.ok)return {error:true};localSession=null;listener('SIGNED_OUT',null);return {error:null};
  },
 };
 client=createSalonSession({auth,endpoint:location.origin+'/api/salon',onReset:reason=>{
  if(reason==='DISPOSED')return;
  viewRevision++;clear();$('name').value='';options('store',[],()=>{});$('panel').disabled=true;$('retry').disabled=true;$('connect').disabled=signingOut||logoutUnconfirmed;
  status(logoutUnconfirmed?'退出未确认，请重试退出；禁止继续业务。':'会话已锁定，旧业务选择已清除；请重新连接。');
  renderRecovery();
 }});
 await client.connect();
 const result=await client.read('stores');options('store',result.data.map(row=>({id:serverId(row.store_id),name:row.name})),row=>row.name);
 $('store').value=String(client.scope.storeId);await refresh();status('已连接临时数据库；所有操作只影响本次合成数据。');
});
$('store').onchange=()=>run(async()=>{const id=$('store').value;clear();if(!id){client.disconnect();return;}await client.connect(serverId(id));await refresh();status('已切换门店，旧选择已清除。');});
$('createCustomer').onclick=()=>run(async()=>{
 const displayName=$('name').value.trim();if(!displayName)throw Error('请输入合成顾客姓名');
 await mutate('customer_create',{displayName,source:'other'},async data=>{
  await refresh();const id=serverId(data.customerId);
  if(!customers.some(row=>row.id===id))throw Error('当前授权列表未找到已建立的顾客，请核对原记录');
  $('customer').value=String(id);status('顾客已建档并读取确认。');
 });
});
$('createOrder').onclick=()=>run(async()=>{
 if(orderId)throw Error('已有订单草稿，请先处理原订单');
 const selected=customers.find(row=>row.id===Number($('customer').value));if(!selected)throw Error('请选择本店顾客');
 await mutate('order_create',{customerId:selected.id,notes:'本机合成接口联调'},async data=>{
  const id=serverId(data.orderId),result=await client.read('order_detail',{orderId:id});
  if(serverId(result.data?.order?.id)!==id)throw Error('订单回读与创建对象不一致，请核对原订单');
  orderId=id;$('order').textContent=`订单 ${id} · ${result.data.order.status}`;$('saveLines').disabled=result.data.order.status!=='draft';
  status('订单已创建并读取确认。');
 });
});
$('saveLines').onclick=()=>run(async()=>{
 const selected=items.find(row=>row.id===Number($('item').value));if(!selected||!orderId)throw Error('请选择本店商品并先创建草稿');
 await mutate('order_lines',{orderId,lines:[{catalogItemId:selected.id,quantity:1,unitPrice:selected.listPriceCents/100,discountAmount:0}]},async()=>{
  const result=await client.read('order_detail',{orderId});
  if(serverId(result.data?.order?.id)!==orderId||!result.data.lines?.some(line=>serverId(line.catalog_item_id)===selected.id))throw Error('订单回读与保存对象不一致，请核对原订单');
  $('order').textContent=`订单 ${orderId} · 明细已从数据库读取确认`;
  $('saveLines').disabled=result.data.order.status!=='draft';
  status(`明细已保存并读取验证 · 追踪号 ${result.requestId}`);
 });
});
$('retry').onclick=()=>run(async()=>{if(retry)await retry();});
$('lookupRequest').onclick=()=>run(async()=>{
 if(retry||journalFault)throw Error('请先处理本页原请求或存储异常。');
 const pendingJournal=journal(),ticket=pendingJournal.list().find(r=>r.requestKey===$('recoveryRequest').value);
 if(!ticket)throw Error('请选择当前身份和门店的待核对请求。');
 const result=(await client.read('request_lookup',{requestKey:ticket.requestKey,targetOperation:ticket.operation})).data;
 if(result?.operation!==ticket.operation)throw Error('核对结果不匹配，原请求继续保留。');
 if(result.status==='unconfirmed'){status('尚未确认结果，原请求保留；这不代表失败，禁止重新提交。');return;}
 const expectedType=ticket.operation==='customer_create'?'customer':'order';
 if(result.status!=='committed'||result.resourceType!==expectedType||typeof result.completedAt!=='string'||!Number.isFinite(Date.parse(result.completedAt)))throw Error('核对结果不完整，原请求继续保留。');
 const id=serverId(result.resourceId);
 let recoveredOrder;
 if(expectedType==='order'){
  recoveredOrder=(await client.read('order_detail',{orderId:id})).data;
  if(serverId(recoveredOrder?.order?.id)!==id)throw Error('订单现状核对失败，原请求继续保留。');
 }
 await refresh();
 if(expectedType==='customer'&&!customers.some(row=>row.id===id))throw Error('历史建档已完成，但当前列表未找到顾客，请人工核对；原请求保留。');
 try{pendingJournal.acknowledge(ticket);}catch(error){journalFault=true;throw error;}
 if(recoveredOrder){orderId=id;$('order').textContent=`已恢复订单 ${id} · 当前状态 ${recoveredOrder.order.status}`;$('saveLines').disabled=recoveredOrder.order.status!=='draft';}
 else $('customer').value=String(id);
 status('已核对原请求并读取当前记录，没有重新提交业务。');
});
$('refresh').onclick=()=>run(async()=>{await refresh();status('已刷新本店数据。');});
$('changeRequest').onchange=()=>{$('changeDetails').textContent=$('changeRequest').value?$('changeRequest').selectedOptions[0].textContent:'请选择申请';};
for(const [id,decision] of [['approveChange','approved'],['rejectChange','rejected']])$(id).onclick=()=>run(async()=>{
 const changeRequestId=serverId($('changeRequest').value),reason=$('changeReason').value.trim();
 if(!reason)throw Error('请填写改期复核原因');
 await verifyTimeZone();
 await mutate('reschedule_review',{changeRequestId,decision,reason,expectedTimeZone:timeZone,expectedTimeVersion:timeVersion},async()=>{
  await refresh();$('changeReason').value='';status(decision==='approved'?'改期申请已批准，预约已更新。':'改期申请已拒绝，原预约保留。');
 });
});
$('rescheduleRequest').onchange=()=>{
 const selected=rescheduleRequests.find(row=>row.id===Number($('rescheduleRequest').value));
 $('rescheduleStart').value=selected?instantToStoreInput(selected.startsAt,timeZone):'';
};
$('rescheduleBooking').onclick=()=>run(async()=>{
 const selected=rescheduleRequests.find(row=>row.id===Number($('rescheduleRequest').value)),reason=$('rescheduleReason').value.trim(),value=$('rescheduleStart').value;
 if(!selected||!reason||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw Error('请选择本店预约，填写门店新时间与原因');
 await verifyTimeZone();
 await mutate('booking_reschedule',{bookingRequestId:selected.id,expectedStartsAt:selected.startsAt,expectedEndsAt:selected.endsAt,expectedVersion:selected.version,newStartsAt:storeTimeToInstant(value,timeZone),reason,expectedTimeZone:timeZone,expectedTimeVersion:timeVersion},async()=>{
  await refresh();$('rescheduleReason').value='';status('改期成功，原预约与档期已同步更新。');
 });
});
for(const [id,decision] of [['approveCancel','approved'],['rejectCancel','rejected']])$(id).onclick=()=>run(async()=>{
 const selected=cancelRequests.find(row=>row.id===Number($('cancelRequest').value)),reason=$('cancelReason').value.trim();
 if(!selected||!reason)throw Error('请选择本店待复核申请并填写处理原因');
 await mutate('booking_cancel_review',{bookingRequestId:selected.id,decision,reason},async data=>{
  await refresh();$('cancelReason').value='';status(data.status==='cancelled'?'取消已批准，档期已释放。':'取消已拒绝，原预约和档期保留。');
 });
});
$('logout').onclick=async()=>{
 if(signingOut)return;
 signingOut=true;logoutUnconfirmed=true;let completed=false;$('logout').disabled=true;$('connect').disabled=true;
 try{await client.signOut();completed=true;logoutUnconfirmed=false;$('logout').disabled=true;status('已退出本次测试会话；旧请求不能继续提交。');}
 catch(error){status(error.message);$('logout').disabled=false;}
 finally{signingOut=false;$('connect').disabled=!completed;}
};
window.addEventListener('beforeunload',event=>{if(retry||logoutUnconfirmed||journalFault){event.preventDefault();event.returnValue='';}});
