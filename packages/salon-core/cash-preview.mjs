// Cash planning only. No writes, request tickets, stored receipts or payment confirmation.
import {serverId,amountToCents,orderEditVersion} from './api-client.mjs';
import {inspectOrder} from './order-inspection.mjs';
const maximum=999999999999; // numeric(12,2), expressed in cents.
const money=cents=>`${Math.floor(cents/100)}.${String(cents%100).padStart(2,'0')}`;
function readOrder(data,scope){
 const record=inspectOrder(data,data?.order?.id,scope);
 const cents=amountToCents(data.order.payable_total);
 if(cents>maximum)throw Error('订单应收超出金额范围');
 return Object.freeze({id:record.id,number:record.number,organizationId:serverId(scope.organizationId),storeId:serverId(scope.storeId),version:orderEditVersion(data.order.edit_version),state:data.order.status,cents,payable:money(cents),lineCount:record.lines.length});
}
export function createCashPreview(){
 let order=null;
 return {
  get order(){return order;},
  get available(){return Boolean(order&&order.state==='awaiting_payment'&&order.cents>0&&order.lineCount>0);},
  clear(){order=null;},
  load(data,scope){order=readOrder(data,scope);},
  preview(data,scope,input){
   if(!this.available)throw Error('仅支持已载入、有明细且应收大于零的待收银订单');
   const fresh=readOrder(data,scope);
   if(fresh.id!==order.id||fresh.organizationId!==order.organizationId||fresh.storeId!==order.storeId||fresh.version!==order.version||fresh.state!==order.state||fresh.cents!==order.cents||fresh.lineCount!==order.lineCount)throw Error('订单已变化或范围不匹配，请重新载入后核对金额');
   if(typeof input!=='string'||!/^\d{1,10}(\.\d{1,2})?$/.test(input))throw Error('拟收现金必须是最多两位小数的非负金额');
   const tendered=amountToCents(input);
   if(tendered>maximum)throw Error('拟收现金超出金额范围');
   if(tendered<order.cents)throw Error('拟收现金不足以支付本单应收');
   return Object.freeze({orderId:order.id,number:order.number,version:order.version,payable:money(order.cents),tendered:money(tendered),change:money(tendered-order.cents)});
  }
 };
}
export function renderCashPreview(container,preview){
 const doc=container.ownerDocument,fragment=doc.createDocumentFragment();
 for(const text of [`订单 ${preview.number} · 编号 ${preview.orderId} · 核对版本 ${preview.version}`,`应收 ¥${preview.payable} · 拟收现金 ¥${preview.tendered} · 应找零 ¥${preview.change}`,'仅金额预览，未确认收款、未提交支付、未扣会员或库存。预览不是支付凭证，也不保证库存或收银权限通过。']){
  const p=doc.createElement('p');p.textContent=text;fragment.append(p);
 }
 container.replaceChildren(fragment);
}
