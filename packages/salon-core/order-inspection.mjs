// Read-only projection. Never expose the full receipt or calculate payment success.
import {serverId,amountToCents} from './api-client.mjs';
const states={draft:'草稿',opened:'已开单',in_service:'服务中',awaiting_payment:'待付款',paid:'已支付',cancelled:'已取消',reversed:'已冲正'};
const services={pending:'待服务',in_service:'服务中',completed:'已完成',cancelled:'已取消'};
const invalid=()=>{throw Error('订单查询结果不完整或范围不匹配，请重新查询。');};
const text=value=>{if(typeof value!=='string'||value.length>500)invalid();return value;};
const money=value=>{const cents=BigInt(amountToCents(value));return `¥${cents/100n}.${String(cents%100n).padStart(2,'0')}`;};
export function inspectOrder(data,requestedId,scope){
 const order=data?.order,id=serverId(requestedId),org=serverId(scope.organizationId),store=serverId(scope.storeId);
 if(!order||serverId(order.id)!==id||serverId(order.organization_id)!==org||serverId(order.store_id)!==store||!Object.hasOwn(states,order.status)||!Array.isArray(data.lines))invalid();
 const seen=new Set();
 const lines=data.lines.map(line=>{
  const lineId=serverId(line.id),quantity=String(line.quantity);
  if(seen.has(lineId)||serverId(line.order_id)!==id||serverId(line.organization_id)!==org||!/^\d{1,9}(\.\d{1,3})?$/.test(quantity)||Number(quantity)<=0||!Object.hasOwn(services,line.service_status))invalid();
  seen.add(lineId);
  return Object.freeze({id:lineId,name:text(line.item_name)||'未命名项目',quantity,unitPrice:money(line.unit_price),discount:money(line.discount_amount),total:money(line.line_total),status:services[line.service_status]});
 });
 return Object.freeze({id,number:text(order.order_no),status:states[order.status],subtotal:money(order.subtotal),discount:money(order.discount_total),payable:money(order.payable_total),lines:Object.freeze(lines)});
}
export function renderOrderInspection(container,record){
 const doc=container.ownerDocument,fragment=doc.createDocumentFragment();
 const add=(tag,value)=>{const node=doc.createElement(tag);node.textContent=value;fragment.append(node);};
 add('h3',`订单 ${record.number} · 内部编号 ${record.id}`);
 add('p',`当前状态：${record.status}`);
 add('p',`项目小计 ${record.subtotal} · 优惠 ${record.discount} · 应收 ${record.payable}`);
 add('p','以上为订单应收，不是实收、会员余额或支付凭证。查询不会修改订单，也不会把原单加载到编辑器。');
 if(!record.lines.length)add('p','暂无项目明细。');
 for(const line of record.lines){
  add('h4',`${line.name} · 明细 ${line.id}`);
  add('p',`数量 ${line.quantity} · 单价 ${line.unitPrice} · 优惠 ${line.discount} · 小计 ${line.total} · ${line.status}`);
 }
 container.replaceChildren(fragment);
}
