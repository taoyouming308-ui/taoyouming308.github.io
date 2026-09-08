import {serverId} from './api-client.mjs';
export const orderStates=Object.freeze({draft:'草稿',opened:'已开单',in_service:'服务中',awaiting_payment:'待付款',paid:'已支付',cancelled:'已取消',reversed:'已冲正'});
export function orderPage(data,scope,{status='',beforeId=null}={}){
 const bad=()=>{throw Error('订单列表范围或分页结果无效，请重新查询。');};
 if(!data||serverId(data.organizationId)!==serverId(scope.organizationId)||serverId(data.storeId)!==serverId(scope.storeId)||!Array.isArray(data.rows)||data.rows.length>50)bad();
 let last=beforeId==null?Infinity:serverId(beforeId);
 const rows=data.rows.map(row=>{
  const id=serverId(row.id);
  if(id>=last||!Object.hasOwn(orderStates,row.status)||(status&&status!==row.status)||typeof row.order_no!=='string'||row.order_no.length>500||typeof row.created_at!=='string'||!Number.isFinite(Date.parse(row.created_at)))bad();
  last=id;return Object.freeze({id,number:row.order_no,status:row.status,createdAt:row.created_at});
 });
 if(data.nextBeforeId!==null&&(rows.length!==50||serverId(data.nextBeforeId)!==last))bad();
 return Object.freeze({rows:Object.freeze(rows),nextBeforeId:data.nextBeforeId});
}
export function renderOrderPage(container,page,onView,onEdit,onProcess){
 const doc=container.ownerDocument,fragment=doc.createDocumentFragment();
 if(!page.rows.length){const p=doc.createElement('p');p.textContent='本页没有匹配订单。';fragment.append(p);}
 for(const row of page.rows){
  const item=doc.createElement('article');item.style.overflowWrap='anywhere';item.dataset.orderId=String(row.id);
  const title=doc.createElement('p');title.textContent=`${row.number} · ${orderStates[row.status]} · 编号 ${row.id}`;item.append(title);
  const nav=doc.createElement('nav');
  for(const [label,action] of [['查看',onView],...(row.status==='draft'?[['载入草稿编辑',onEdit]]:[]),...(onProcess&&['opened','in_service','awaiting_payment'].includes(row.status)?[['载入订单处理',onProcess]]:[])]){
   const button=doc.createElement('button');button.textContent=label;button.onclick=()=>action(row.id);nav.append(button);
  }
  item.append(nav);fragment.append(item);
 }
 container.replaceChildren(fragment);
}
