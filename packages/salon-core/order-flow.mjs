import {inspectOrder} from './order-inspection.mjs';
import {orderEditVersion} from './api-client.mjs';
const labels=Object.freeze({opened:'确认开单',in_service:'开始服务（整单）',awaiting_payment:'转待收银（不收款）'});
export function orderFlow(data,scope){
 const record=inspectOrder(data,data?.order?.id,scope),version=orderEditVersion(data.order.edit_version);
 const next={draft:['opened'],opened:['in_service','awaiting_payment'],in_service:['awaiting_payment']}[data.order.status]||[];
 return Object.freeze({id:record.id,number:record.number,state:data.order.status,status:record.status,version,
  actions:Object.freeze(record.lines.length?next:[])});
}
export function renderOrderFlow(container,flow,locked,onAction){
 const doc=container.ownerDocument,fragment=doc.createDocumentFragment(),p=doc.createElement('p');
 p.textContent=flow?`当前处理订单 ${flow.number} · 编号 ${flow.id} · ${flow.status}`:'请先创建订单，或从列表载入订单处理。';fragment.append(p);
 if(flow){
  const hint=doc.createElement('p');hint.textContent=locked?'有未保存修改或版本冲突，请先处理；不能推进状态。':flow.state==='awaiting_payment'?'当前待收银；可在现金区域核对并确认，当前尚未收款或扣会员。':'只推进整单状态，不自动完成项目明细，也不产生收款或出库。';fragment.append(hint);
  const nav=doc.createElement('nav');
  for(const target of flow.actions){const button=doc.createElement('button');button.textContent=labels[target];button.dataset.orderStatus=target;button.disabled=locked;button.onclick=()=>onAction(target,labels[target]);nav.append(button);}
  fragment.append(nav);
 }
 container.replaceChildren(fragment);
}
