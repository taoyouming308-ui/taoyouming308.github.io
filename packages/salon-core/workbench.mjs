import {mapRows,serverId,orderEditVersion} from './api-client.mjs';
import {createSalonSession} from './session-controller.mjs';
import {withRequestDeadline} from './request-deadline.mjs';
import {createRecoveryJournal,recoverableOperations} from './recovery-journal.mjs';
import {inspectOrder,renderOrderInspection} from './order-inspection.mjs';
import {verifyOrderLines} from './order-readback.mjs';
import {createDraftEditor,renderDraftEditor} from './draft-editor.mjs';
import {orderStates,orderPage,renderOrderPage} from './order-list.mjs';
import {orderFlow,renderOrderFlow} from './order-flow.mjs';
import {createCashPreview,renderCashPreview} from './cash-preview.mjs';
import {verifyCashReceipt,verifyCashLookup,renderCashReceipt} from './cash-receipt.mjs';
import {refundStates,refundPage,inspectRefund,verifyRefundDecision,renderRefund} from './refund-review.mjs';
import {instantToStoreInput,storeTimeToInstant,formatStoreInstant,storeTimeContext} from './store-time.mjs';
let timeZone=null,timeVersion=null;
const $=id=>document.getElementById(id);
let client,customers=[],items=[],cancelRequests=[],rescheduleRequests=[],orderId=null,retry=null,viewRevision=0,signingOut=false,logoutUnconfirmed=false;
let journalFault=false,running=false;
let orderVersion=null;
const editor=createDraftEditor();
let loadedFlow=null;
let refundRecord=null,refundNext=null,refundListedStatus='';
function clearRefundDetail(){refundRecord=null;$('refundDetail').replaceChildren();$('refundReason').value='';$('approveRefund').disabled=true;$('rejectRefund').disabled=true;}
function clearRefunds(){clearRefundDetail();refundNext=null;$('nextRefunds').disabled=true;$('refundSelection').replaceChildren(new Option('请选择',''));$('refundListStatus').textContent='请查询本店退款申请。';}
function showRefund(record){clearRefundDetail();refundRecord=record;renderRefund($('refundDetail'),record);$('approveRefund').disabled=!record.canApprove;$('rejectRefund').disabled=!record.canReview;}
async function loadRefundPage(beforeId=null){
 const state=$('refundFilter').value;clearRefunds();
 const page=refundPage((await client.read('refund_queue',{status:state,beforeId})).data,client.scope,{status:state,beforeId});
 refundNext=page.nextBeforeId;refundListedStatus=state;
 for(const row of page.rows)$('refundSelection').add(new Option(`申请 ${row.id} · 订单 ${row.orderId} · ¥${row.amount} · ${refundStates[row.status]}`,String(row.id)));
 $('nextRefunds').disabled=refundNext===null;$('refundListStatus').textContent=`本页 ${page.rows.length} 条 · ${refundNext===null?'已到末页':'还有更早申请'} · 载入时重新核对，列表不是实时状态`;
}
let cash=createCashPreview(),cashConfirmation=null;
function clearCashResult(){cashConfirmation=null;$('cashConfirm').disabled=true;$('cashResult').replaceChildren();}
function resetCash(){cash.clear();$('cashTendered').value='';clearCashResult();}
function hydrateEditor(data,scope){const next=orderFlow(data,scope),nextCash=createCashPreview();nextCash.load(data,scope);editor.load(data,scope);loadedFlow=next;resetCash();cash=nextCash;}
function resetEditor(){editor.clear();loadedFlow=null;resetCash();clearRefunds();}
let nextOrderId=null,listedStatus='';
for(const [value,label] of Object.entries(orderStates))$('orderFilter').add(new Option(label,value));
function clearOrderList(){nextOrderId=null;$('orderList').replaceChildren();$('nextOrders').disabled=true;$('orderListStatus').textContent='请查询本店订单。';}
async function loadOrderList(beforeId=null){
 const filter=$('orderFilter').value;
 clearOrderList();
 const result=await client.read('orders',{status:filter,beforeId});
 const page=orderPage(result.data,client.scope,{status:filter,beforeId});
 listedStatus=filter;nextOrderId=page.nextBeforeId;
 renderOrderPage($('orderList'),page,id=>selectOrder(id,false),id=>selectOrder(id,true),id=>selectOrder(id,'process'));
 $('nextOrders').disabled=nextOrderId===null;
 $('orderListStatus').textContent=`本页 ${page.rows.length} 单 · ${nextOrderId===null?'已到末页':'还有更早订单'} · 按内部编号倒序，状态不是实时更新`;
}
function selectOrder(id,edit){return run(async()=>{
 if(edit&&editor.dirty&&!confirm('载入草稿会丢弃当前未保存的项目修改，是否继续？'))return;
 $('orderInspection').replaceChildren();
 const result=await client.read('order_detail',{orderId:id});
 const record=inspectOrder(result.data,id,client.scope);
 if(edit){
  const candidate=createDraftEditor();candidate.load(result.data,client.scope);
  if(edit===true&&!candidate.editable)throw Error('该订单当前不能编辑：仅允许草稿且所有明细待服务。请查看最新状态。');
  const version=orderEditVersion(result.data.order.edit_version);
  hydrateEditor(result.data,client.scope);orderId=id;orderVersion=version;renderEditor();
  $('order').textContent=`当前编辑订单 ${record.number} · 编号 ${id} · ${record.status}`;
  status(edit===true?'已重新读取并载入草稿；保存时仍校验版本，尚未写入业务。':'已载入订单处理，尚未修改状态或收款。');
 }else{renderOrderInspection($('orderInspection'),record);status('原单已只读查询；未修改订单或当前编辑对象。');}
});}
function renderEditor(){
 const cashDisabled=!cash.available||editor.dirty||orderVersion===null;
 $('cashOrder').textContent=cash.available?`已载入订单 ${cash.order.number} · 应收 ¥${cash.order.payable}（点击预览时重新核对）`:'请先载入有明细、应收大于零的待收银订单。';
 $('cashPreview').disabled=cashDisabled;$('cashTendered').disabled=cashDisabled;
 if(cashDisabled)clearCashResult();
 renderOrderFlow($('orderFlow'),loadedFlow,editor.dirty||orderVersion===null,advanceOrder);
 renderDraftEditor($('draftRows'),editor,renderEditor,error=>status(error.message));
 $('draftSummary').textContent=`共 ${editor.rows.length} 项 · ${!editor.editable?'只读，不能保存':editor.dirty?'有未保存修改':'与最近读取记录一致'}`;
 $('addItem').disabled=!editor.editable;$('saveLines').disabled=!editor.editable;
}
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
 if(id==='customer'){$('inspectOrderId').value='';$('orderInspection').replaceChildren();}
 if(id==='changeRequest')$('changeDetails').textContent='选择申请后查看原时间、新时间与申请原因。';
 const select=$(id);select.replaceChildren(new Option('请选择',''));
 for(const row of rows)select.add(new Option(label(row),String(row.id)));
}
function clear(){clearOrderList();resetEditor();renderEditor();timeZone=null;$('timeZone').textContent='门店时区未加载';options('changeRequest',[],()=>{});$('changeReason').value='';customers=[];items=[];cancelRequests=[];rescheduleRequests=[];orderId=null;orderVersion=null;retry=null;options('customer',[],()=>{});options('item',[],()=>{});options('cancelRequest',[],()=>{});options('rescheduleRequest',[],()=>{});$('rescheduleStart').value='';$('rescheduleReason').value='';$('cancelReason').value='';$('order').textContent='尚未创建订单';$('saveLines').disabled=true;}
async function refresh(){
 clearRefunds();
 clearCashResult();
 clearOrderList();
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
 clearRefundDetail();
 clearCashResult();
 clearOrderList();
 $('orderInspection').replaceChildren();
 if(journalFault||journal().list().length)throw Error('待核对清单未解决，禁止新建业务。');
 const ticket=client.prepare(operation,fields);
 const tracked=recoverableOperations.includes(operation),pendingJournal=journal();
 let hadUnknownResult=false;
 if(tracked)try{pendingJournal.remember(ticket);}catch(error){journalFault=true;throw error;}
 retry=async()=>{
  let result;
  try{result=await client.submit(ticket);}catch(error){
   if(['order_lines','order_status','cash_checkout'].includes(operation)&&error.message.includes('订单版本已变化')){editor.lock();orderVersion=null;renderEditor();}
   // A later rejection cannot prove an earlier unknown submission did not commit.
   if(error.code==='API_REJECTED'&&error.httpStatus>=400&&error.httpStatus<500){
    retry=null;if(tracked&&!hadUnknownResult)try{pendingJournal.acknowledge(ticket);}catch(e){journalFault=true;throw e;}
   }else hadUnknownResult=true;
   throw error;
  }
  if(tracked){
   try{
    const id=serverId(result.data?.[operation==='customer_create'?'customerId':operation==='refund_review'?'refundRequestId':'orderId']);
    if(operation==='refund_review')verifyRefundDecision(result.data,fields.refundRequestId,client.scope,fields.decision);
    if(['order_lines','order_status','cash_checkout'].includes(operation)&&id!==fields.orderId)throw Error('返回订单不匹配，请继续核对原请求。');
    if(operation==='cash_checkout')verifyCashReceipt(result.data,client.scope,ticket.requestKey,{orderId:fields.orderId,version:fields.expectedVersion,payable:fields.amount,tendered:fields.tendered,change:fields.change});
    if(operation==='order_status'&&result.data.status!==fields.status)throw Error('返回状态不匹配，请继续核对原请求。');
   }catch(error){hadUnknownResult=true;throw error;}
  }
  retry=null;
  // A successful write is not a completed UI handoff. Retain metadata until
  // the current resource has been read; read failures must never invite a new write.
  status(`写入已保存，正在核对当前记录 · 请求号 ${result.requestId}`);
  try{await onSuccess(result.data,ticket);}catch(error){throw Error(`写入已经成功，请勿重复创建。后续回读失败：${error.message}；${tracked?'原请求号已保留，请使用“只读核对原请求”。':''}追踪号 ${result.requestId}`);}
  if(tracked)try{pendingJournal.acknowledge(ticket);}catch(error){journalFault=true;throw Error('写入已成功，但清单更新失败；请勿重复提交。'+error.message);}
 };
 await retry();
}
$('connect').onclick=()=>run(async()=>{
 if(editor.dirty&&!confirm('重新连接会丢弃尚未保存的项目修改，是否继续？'))return;
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
$('store').onchange=()=>run(async()=>{const id=$('store').value;if(editor.dirty&&!confirm('切换门店会丢弃尚未保存的项目修改，是否继续？')){$('store').value=String(client.scope.storeId);return;}clear();if(!id){client.disconnect();return;}await client.connect(serverId(id));await refresh();status('已切换门店，旧选择已清除。');});
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
  orderVersion=orderEditVersion(result.data.order.edit_version);orderId=id;$('order').textContent=`订单 ${id} · ${result.data.order.status}`;$('saveLines').disabled=result.data.order.status!=='draft';
  hydrateEditor(result.data,client.scope);renderEditor();
  status('订单已创建并读取确认。');
 });
});
$('saveLines').onclick=()=>run(async()=>{
 if(!orderId)throw Error('请先创建订单草稿');
 const lines=editor.snapshot();
 await mutate('order_lines',{orderId,lines,expectedVersion:orderEditVersion(orderVersion)},async()=>{
  const result=await client.read('order_detail',{orderId});
  verifyOrderLines(result.data,orderId,client.scope,lines);
  orderVersion=orderEditVersion(result.data.order.edit_version);
  hydrateEditor(result.data,client.scope);renderEditor();
  $('order').textContent=`订单 ${orderId} · 明细已从数据库读取确认`;
  $('saveLines').disabled=!editor.editable;
  status(`明细已保存并读取验证 · 追踪号 ${result.requestId}`);
 });
});
$('addItem').onclick=()=>{try{editor.add(items.find(row=>row.id===Number($('item').value)));renderEditor();}catch(error){status(error.message);}};
$('retry').onclick=()=>run(async()=>{if(retry)await retry();});
$('listRefunds').onclick=()=>run(()=>loadRefundPage());
$('nextRefunds').onclick=()=>run(async()=>{if(refundNext!==null&&refundListedStatus===$('refundFilter').value)await loadRefundPage(refundNext);});
$('refundFilter').onchange=clearRefunds;
$('refundSelection').onchange=clearRefundDetail;
$('loadRefund').onclick=()=>run(async()=>{
 const id=serverId($('refundSelection').value);clearRefundDetail();
 showRefund(inspectRefund((await client.read('refund_detail',{refundRequestId:id})).data,id,client.scope));
 status('退款申请与原支付已读取；尚未审批或退款。');
});
for(const [button,decision] of [['approveRefund','approved'],['rejectRefund','rejected']])$(button).onclick=()=>run(async()=>{
 const record=refundRecord,reason=$('refundReason').value.trim();
 if(!record?.canReview||(decision==='approved'&&!record.canApprove)||!reason)throw Error('请重新核对申请并填写审批意见；申请人不能审批本人申请');
 const snapshot=record.snapshot,id=snapshot.refund.id;
 if(!confirm(`退款申请 ${id} · ¥${snapshot.refund.amount}：${decision==='approved'?'批准':'拒绝'}？本操作不执行退款、不退会员或返库。`))return;
 await mutate('refund_review',{refundRequestId:id,decision,reason,expectedSnapshot:snapshot},async data=>{
  if(data.orderId!==snapshot.order.id)throw Error('审批回执原订单不匹配');
  const current=inspectRefund((await client.read('refund_detail',{refundRequestId:id})).data,id,client.scope);
  if(current.snapshot.refund.status!==decision||current.snapshot.refund.reviewedByStaffId!==client.scope.staffId||current.snapshot.refund.decisionReason!==reason)throw Error('审批现状与本次决定不匹配，请只读核对原请求');
  showRefund(current);status('退款审批已保存并读取确认；未执行退款或返库。');
 });
});
$('cashTendered').oninput=clearCashResult;
$('cashPreview').onclick=()=>run(async()=>{
 clearCashResult();
 if(!cash.available||editor.dirty||orderVersion===null||cash.order.id!==orderId)throw Error('请从列表重新载入待收银订单');
 const input=$('cashTendered').value;
 const result=await client.read('order_detail',{orderId:cash.order.id});
 cashConfirmation=cash.preview(result.data,client.scope,input);
 renderCashPreview($('cashResult'),cashConfirmation);$('cashConfirm').disabled=false;
 status('已重新核对订单并生成现金预览；没有提交收款。');
});
 $('cashConfirm').onclick=()=>run(async()=>{
  const preview=cashConfirmation;
  if(!preview||!cash.available||editor.dirty||preview.orderId!==orderId||preview.version!==orderVersion)throw Error('请重新预览并核对现金金额');
  if(!confirm(`仅合成测试：订单 ${preview.number}，收款 ¥${preview.payable}，实收 ¥${preview.tendered}，找零 ¥${preview.change}。确认现金已点清？提交后会生成支付和商品出库记录。`))return;
  await mutate('cash_checkout',{orderId:preview.orderId,expectedVersion:preview.version,amount:preview.payable,tendered:preview.tendered,change:preview.change},async(data,ticket)=>{
   const lookup=(await client.read('request_lookup',{targetOperation:'cash_checkout',requestKey:ticket.requestKey})).data;
   const checked=verifyCashLookup(lookup,client.scope,ticket.requestKey,preview);
   if(checked.receipt.paymentId!==data.paymentId)throw Error('支付编号回读不匹配');
   const current=(await client.read('order_detail',{orderId:preview.orderId})).data;
   inspectOrder(current,preview.orderId,client.scope);hydrateEditor(current,client.scope);
   orderVersion=orderEditVersion(current.order.edit_version);renderEditor();
   $('order').textContent=`订单 ${orderId} · 当前状态 ${current.order.status}`;
   renderCashReceipt($('cashResult'),checked,current.order.status);
   status('现金收款已提交，并按原请求核对支付记录；未扣会员。');
  });
 });
function advanceOrder(target,label){return run(async()=>{
 if(!loadedFlow||loadedFlow.id!==orderId||orderVersion===null||editor.dirty||!loadedFlow.actions.includes(target))throw Error('当前订单不能执行该状态操作，请先保存或重新载入核对。');
 if(!confirm(`订单 ${loadedFlow.number}：${label}？只修改整单状态，不代表项目完成或已收款。`))return;
 const id=orderId;
 await mutate('order_status',{orderId:id,status:target,reason:'本机整单状态确认',expectedVersion:orderEditVersion(orderVersion)},async()=>{
  const result=await client.read('order_detail',{orderId:id});
  inspectOrder(result.data,id,client.scope);
  if(result.data.order.status!==target)throw Error('订单现状与提交目标不同，请只读核对原请求');
  hydrateEditor(result.data,client.scope);orderVersion=orderEditVersion(result.data.order.edit_version);renderEditor();
  $('order').textContent=`订单 ${id} · ${loadedFlow.status}`;
  status('订单状态已保存并读取确认；未收款、未扣会员或自动完成明细。');
 });
});}
$('listOrders').onclick=()=>run(()=>loadOrderList());
$('nextOrders').onclick=()=>run(async()=>{if(nextOrderId!==null&&listedStatus===$('orderFilter').value)await loadOrderList(nextOrderId);});
$('orderFilter').onchange=clearOrderList;
$('leaveDraft').onclick=()=>run(async()=>{
 if(editor.dirty&&!confirm('离开编辑会丢弃未保存的项目修改，是否继续？'))return;
 resetEditor();orderId=null;orderVersion=null;renderEditor();$('order').textContent='尚未创建订单';
 status('已离开编辑，数据库订单未删除；可从列表重新载入或新建草稿。');
});
$('inspectOrder').onclick=()=>run(async()=>{
 $('orderInspection').replaceChildren();
 const id=serverId($('inspectOrderId').value),result=await client.read('order_detail',{orderId:id});
 renderOrderInspection($('orderInspection'),inspectOrder(result.data,id,client.scope));
 status('原单已只读查询；未修改订单或当前编辑对象。');
});
$('inspectOrderId').oninput=()=>{$('orderInspection').replaceChildren();};
$('lookupRequest').onclick=()=>run(async()=>{
 if(retry||journalFault)throw Error('请先处理本页原请求或存储异常。');
 const pendingJournal=journal(),ticket=pendingJournal.list().find(r=>r.requestKey===$('recoveryRequest').value);
 if(!ticket)throw Error('请选择当前身份和门店的待核对请求。');
 const result=(await client.read('request_lookup',{requestKey:ticket.requestKey,targetOperation:ticket.operation})).data;
 if(result?.operation!==ticket.operation)throw Error('核对结果不匹配，原请求继续保留。');
 if(result.status==='unconfirmed'){status('尚未确认结果，原请求保留；这不代表失败，禁止重新提交。');return;}
 if(ticket.operation==='refund_review'){
  if(result.status!=='committed'||result.resourceType!=='refund_request'||typeof result.completedAt!=='string'||!Number.isFinite(Date.parse(result.completedAt)))throw Error('退款审批核对结果不完整，原请求保留');
  const id=serverId(result.resourceId),receipt=verifyRefundDecision(result.receipt,id,client.scope);
  const current=inspectRefund((await client.read('refund_detail',{refundRequestId:id})).data,id,client.scope);
  if(current.snapshot.order.id!==receipt.orderId)throw Error('退款审批原单不匹配，原请求保留');
  if(current.snapshot.refund.status==='submitted'||current.snapshot.refund.reviewedByStaffId!==receipt.reviewedByStaffId)throw Error('历史审批与当前审批人或状态不一致，请人工核对；原请求保留');
  showRefund(current);
  try{pendingJournal.acknowledge(ticket);}catch(error){journalFault=true;throw error;}
  status(`原审批决定已核对：${refundStates[receipt.status]}；当前申请：${refundStates[current.snapshot.refund.status]}。未重新审批或执行退款。`);return;
 }
 const expectedType=ticket.operation==='customer_create'?'customer':'order';
 if(result.status!=='committed'||result.resourceType!==expectedType||typeof result.completedAt!=='string'||!Number.isFinite(Date.parse(result.completedAt)))throw Error('核对结果不完整，原请求继续保留。');
 const id=serverId(result.resourceId);
 let recoveredOrder,recoveredCash;
 if(ticket.operation==='cash_checkout')recoveredCash=verifyCashLookup(result,client.scope,ticket.requestKey);
 if(expectedType==='order'){
  recoveredOrder=(await client.read('order_detail',{orderId:id})).data;
  if(serverId(recoveredOrder?.order?.id)!==id)throw Error('订单现状核对失败，原请求继续保留。');
  orderEditVersion(recoveredOrder.order.edit_version);
 }
 await refresh();
 if(expectedType==='customer'&&!customers.some(row=>row.id===id))throw Error('历史建档已完成，但当前列表未找到顾客，请人工核对；原请求保留。');
 if(recoveredOrder)hydrateEditor(recoveredOrder,client.scope);
 try{pendingJournal.acknowledge(ticket);}catch(error){journalFault=true;throw error;}
 if(recoveredOrder){orderVersion=orderEditVersion(recoveredOrder.order.edit_version);orderId=id;$('order').textContent=`已恢复订单 ${id} · 当前状态 ${recoveredOrder.order.status}`;$('saveLines').disabled=recoveredOrder.order.status!=='draft';}
 else $('customer').value=String(id);
 renderEditor();
 if(recoveredCash)renderCashReceipt($('cashResult'),recoveredCash,recoveredOrder.order.status);
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
 if(!logoutUnconfirmed&&editor.dirty&&!confirm('退出会丢弃尚未保存的项目修改，是否继续？'))return;
 signingOut=true;logoutUnconfirmed=true;let completed=false;$('logout').disabled=true;$('connect').disabled=true;
 try{await client.signOut();completed=true;logoutUnconfirmed=false;$('logout').disabled=true;status('已退出本次测试会话；旧请求不能继续提交。');}
 catch(error){status(error.message);$('logout').disabled=false;}
 finally{signingOut=false;$('connect').disabled=!completed;}
};
window.addEventListener('beforeunload',event=>{if(retry||logoutUnconfirmed||journalFault||editor.dirty){event.preventDefault();event.returnValue='';}});
