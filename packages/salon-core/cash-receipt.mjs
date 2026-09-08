import {serverId,amountToCents,orderEditVersion} from './api-client.mjs';
export function verifyCashReceipt(receipt,scope,requestKey,expected=null){
 const fail=()=>{throw Error('现金回执与原请求不匹配，请保留请求号继续核对');};
 if(!receipt||receipt.requestKey!==requestKey||receipt.method!=='cash'||receipt.status!=='paid')fail();
 if(serverId(receipt.organizationId)!==serverId(scope.organizationId)||serverId(receipt.storeId)!==serverId(scope.storeId))fail();
 serverId(receipt.orderId);serverId(receipt.paymentId);orderEditVersion(receipt.expectedVersion);
 for(const field of ['paid','tendered','change'])if(typeof receipt[field]!=='string'||!/^\d{1,10}\.\d{2}$/.test(receipt[field]))fail();
 const paid=amountToCents(receipt.paid),tendered=amountToCents(receipt.tendered),change=amountToCents(receipt.change);
 if(paid<=0||tendered<paid||tendered-paid!==change)fail();
 if(expected&&(receipt.orderId!==expected.orderId||receipt.expectedVersion!==expected.version||receipt.paid!==expected.payable||receipt.tendered!==expected.tendered||receipt.change!==expected.change))fail();
 return Object.freeze({...receipt});
}
export function verifyCashLookup(data,scope,key,expected=null){
 if(data?.operation!=='cash_checkout'||data.status!=='committed'||data.resourceType!=='order'||!['confirmed','reversed'].includes(data.paymentStatus)||typeof data.completedAt!=='string'||!Number.isFinite(Date.parse(data.completedAt)))throw Error('现金支付记录尚未完整核对，禁止重复收款');
 const receipt=verifyCashReceipt(data.receipt,scope,key,expected);
 if(serverId(data.resourceId)!==receipt.orderId)throw Error('现金支付记录订单不匹配');
 return Object.freeze({receipt,paymentStatus:data.paymentStatus,completedAt:data.completedAt});
}
export function renderCashReceipt(container,result,currentStatus){
 const {receipt:r,paymentStatus}=result,doc=container.ownerDocument;
 const heading=doc.createElement('h3');heading.textContent='原现金收款已核对';
 const body=doc.createElement('p');body.textContent=`订单 ${r.orderId} · 支付记录 ${r.paymentId} · 收款 ¥${r.paid} · 实收 ¥${r.tendered} · 找零 ¥${r.change}`;
 const state=doc.createElement('p');state.textContent=`这是原请求的历史收款凭证。当前订单：${currentStatus}；支付记录：${paymentStatus}。后续退款需另行核对，不得重新收款。`;
 const key=doc.createElement('p');key.textContent=`请求号 ${r.requestKey}`;
 container.replaceChildren(heading,body,state,key);
}
