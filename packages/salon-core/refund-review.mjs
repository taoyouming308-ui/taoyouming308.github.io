import {serverId,amountToCents,orderEditVersion} from './api-client.mjs';
export const refundStates=Object.freeze({submitted:'待审批',approved:'已批准（未执行）',rejected:'已拒绝',executed:'已执行',cancelled:'已取消'});
const methods=Object.freeze({cash:'现金',wechat:'微信',alipay:'支付宝',member_value:'储值卡',member_units:'次卡/疗程'});
const fail=()=>{throw Error('退款核对数据不完整或范围不匹配，请重新读取');};
const money=value=>{if(typeof value!=='string'||!/^\d{1,10}\.\d{2}$/.test(value))fail();return amountToCents(value);};
const units=value=>{if(typeof value!=='string'||!/^\d{1,11}\.\d{3}$/.test(value))fail();const n=Number(value.replace('.',''));if(!Number.isSafeInteger(n))fail();return n;};
const label=(value,max=500)=>{if(typeof value!=='string'||value.length>max)fail();return value;};
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export function refundPage(data,scope,{status='submitted',beforeId=null}={}){
 if(!data||serverId(data.organizationId)!==serverId(scope.organizationId)||serverId(data.storeId)!==serverId(scope.storeId)||!Array.isArray(data.rows)||data.rows.length>50)fail();
 let previous=beforeId??Infinity;
 const rows=data.rows.map(row=>{
  const id=serverId(row.id);serverId(row.orderId);money(row.amount);
  if(id>=previous||!Object.hasOwn(refundStates,row.status)||(status&&row.status!==status))fail();previous=id;
  return Object.freeze({...row});
 });
 const next=data.nextBeforeId===null?null:serverId(data.nextBeforeId);
 if(next!==null&&(rows.length!==50||next!==rows.at(-1).id))fail();
 return Object.freeze({rows:Object.freeze(rows),nextBeforeId:next});
}
export function inspectRefund(data,id,scope){
 const r=data?.refund,o=data?.order;
 if(!r||!o||serverId(r.id)!==serverId(id)||serverId(r.organizationId)!==serverId(scope.organizationId)||serverId(r.storeId)!==serverId(scope.storeId)||serverId(r.orderId)!==serverId(o.id))fail();
 if(!Object.hasOwn(refundStates,r.status)||!['full','partial'].includes(r.type)||!['paid','reversed','draft','opened','in_service','awaiting_payment','cancelled'].includes(o.status))fail();
 serverId(r.createdByStaffId);if(r.reviewedByStaffId!==null)serverId(r.reviewedByStaffId);orderEditVersion(o.version);
 label(r.reason);label(r.decisionReason);label(o.number,160);
 const total=money(r.amount),payable=money(o.payable),refunded=money(o.refundedTotal);
 if(!Array.isArray(data.lines)||data.lines.length>100||!Array.isArray(data.payments)||data.payments.length>100)fail();
 let lineTotal=0,paymentTotal=0,validPayments=true;const ids=new Set();
 for(const l of data.lines){const key=serverId(l.orderLineId);if(ids.has(key)||!['service','product','package','year_card'].includes(l.type)||units(l.quantity)<=0)fail();ids.add(key);label(l.name,200);lineTotal+=money(l.amount);}
 ids.clear();
 for(const p of data.payments){
  const key=serverId(p.paymentId);if(ids.has(key)||!Object.hasOwn(methods,p.method)||!Object.hasOwn(methods,p.originalMethod)||!['pending','confirmed','failed','reversed'].includes(p.originalStatus))fail();ids.add(key);
  const amount=money(p.amount),original=money(p.originalAmount),requestedUnits=units(p.units),originalUnits=units(p.originalUnits);
  paymentTotal+=amount;validPayments&&=amount>0&&amount<=original&&p.method===p.originalMethod&&p.originalStatus==='confirmed'&&(p.method==='member_units'?(requestedUnits>0&&requestedUnits<=originalUnits):requestedUnits===0);
 }
 const canReview=r.status==='submitted'&&serverId(r.createdByStaffId)!==serverId(scope.staffId);
 const canApprove=canReview&&o.status==='paid'&&total>0&&total<=payable-refunded&&lineTotal===total&&paymentTotal===total&&data.lines.length>0&&data.payments.length>0&&validPayments;
 return Object.freeze({snapshot:freeze(JSON.parse(JSON.stringify(data))),canReview,canApprove});
}
export function verifyRefundDecision(data,id,scope,decision=null){
 if(!data||serverId(data.refundRequestId)!==serverId(id)||serverId(data.reviewedByStaffId)!==serverId(scope.staffId)||!['approved','rejected'].includes(data.status)||(decision&&data.status!==decision))throw Error('退款审批回执不匹配，请核对原请求');
 serverId(data.orderId);return Object.freeze({...data});
}
export function renderRefund(container,record){
 const d=container.ownerDocument,{refund:r,order:o,lines,payments}=record.snapshot,fragment=d.createDocumentFragment();
 const add=(tag,text)=>{const el=d.createElement(tag);el.textContent=text;fragment.append(el);};
 add('h3',`退款申请 ${r.id} · ${refundStates[r.status]}`);
 add('p',`原单 ${o.number}（${o.id}）· 当前 ${o.status} · 原应收 ¥${o.payable} · 已执行退款 ¥${o.refundedTotal}`);
 add('p',`${r.type==='full'?'全额':'部分'}退款 ¥${r.amount} · 申请人编号 ${r.createdByStaffId} · 原因：${r.reason}`);
 for(const l of lines)add('p',`明细 ${l.orderLineId} · ${l.name} · ${l.quantity} · 申请退 ¥${l.amount}${l.type==='product'?'（商品；执行前需核实返库）':''}`);
 for(const p of payments)add('p',`原支付 ${p.paymentId} · ${methods[p.method]} · 原金额 ¥${p.originalAmount} · 申请退 ¥${p.amount} · 原状态 ${p.originalStatus}${p.method==='member_units'?' · 申请退次数 '+p.units+' / 原次数 '+p.originalUnits:''}`);
 if(r.reviewedByStaffId!==null)add('p',`审批人编号 ${r.reviewedByStaffId} · 意见：${r.decisionReason}`);
 add('p',record.canApprove?'请逐项核对原因、原支付和返库情况；批准只改变审批状态。':record.canReview?'分配或原单状态不满足批准条件；可以核实后拒绝，不可强行批准。':'当前不可审批：申请人与审批人须分开，且申请必须处于待审批。');
 add('p','本页不执行退款、不退会员余额/次数、不返库。批准不代表顾客已收到退款；商品返库和实际退款必须另行核实。');
 container.replaceChildren(fragment);
}
