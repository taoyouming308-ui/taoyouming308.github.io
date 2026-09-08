// In-memory complete order draft. No persistence, networking or inferred staff assignment.
import {serverId,amountToCents,orderEditVersion} from './api-client.mjs';
import {inspectOrder} from './order-inspection.mjs';
const invalid=message=>{throw Error(message);};
function quantity(value){
 const raw=String(value);if(!/^\d{1,9}(\.\d{1,3})?$/.test(raw)||Number(raw)<=0)invalid('数量必须大于 0，最多三位小数');
 return Number(raw);
}
export function createDraftEditor(){
 let rows=[],scope=null,editable=false,baseline='[]';
 const payload=()=>rows.map(r=>({catalogItemId:r.catalogItemId,quantity:r.quantity,unitPrice:r.unitPrice,discountAmount:r.discountAmount,staffId:r.staffId}));
 const guard=()=>{if(!editable)invalid('当前订单不能编辑，请先核对原单');};
 const at=index=>{if(!Number.isInteger(index)||index<0||index>=rows.length)invalid('项目行无效');return rows[index];};
 return {
  get editable(){return editable;},get dirty(){return JSON.stringify(payload())!==baseline;},
  get rows(){return rows.map(r=>Object.freeze({...r}));},
  clear(){rows=[];scope=null;editable=false;baseline='[]';},
  lock(){editable=false;},
  load(data,currentScope){
   inspectOrder(data,data?.order?.id,currentScope);orderEditVersion(data.order.edit_version);
   if(data.lines.length>100)invalid('订单超过 100 项，不能在此编辑');
   const next=data.lines.map(line=>({catalogItemId:serverId(line.catalog_item_id),name:line.item_name||'未命名项目',quantity:quantity(line.quantity),unitPrice:amountToCents(line.unit_price)/100,discountAmount:amountToCents(line.discount_amount)/100,staffId:line.staff_id==null?null:serverId(line.staff_id)}));
   rows=next;scope={organizationId:serverId(currentScope.organizationId),storeId:serverId(currentScope.storeId)};
   editable=data.order.status==='draft'&&data.lines.every(line=>line.service_status==='pending');baseline=JSON.stringify(payload());
  },
  add(item){
   guard();if(rows.length>=100)invalid('最多 100 项');
   if(!item||item.organizationId!==scope.organizationId||item.storeId!==scope.storeId||item.status!=='active'||!Number.isSafeInteger(item.listPriceCents)||item.listPriceCents<0)invalid('请选择本店可售项目');
   rows.push({catalogItemId:serverId(item.id),name:String(item.name),quantity:1,unitPrice:item.listPriceCents/100,discountAmount:0,staffId:null});
  },
  setQuantity(index,value){
   guard();const row=at(index),next=quantity(value),[whole,fraction='']=String(next).split('.');
   const milli=BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0'));
   if(milli*BigInt(amountToCents(row.unitPrice))<BigInt(amountToCents(row.discountAmount))*1000n)invalid('修改后项目金额小于原优惠，需由优惠流程处理');
   row.quantity=next;
  },
  remove(index){guard();at(index);rows.splice(index,1);},
  snapshot(){guard();if(!rows.length)invalid('请先添加至少一个项目；不能保存空订单');return Object.freeze(payload().map(row=>Object.freeze(row)));},
 };
}
export function renderDraftEditor(container,editor,onChange,onError){
 const doc=container.ownerDocument,fragment=doc.createDocumentFragment();
 editor.rows.forEach((row,index)=>{
  const card=doc.createElement('article');card.style.cssText='border-top:1px solid #52616e;padding:12px 0;overflow-wrap:anywhere';
  const title=doc.createElement('h4');title.textContent=`${index+1} · ${row.name}`;
  const detail=doc.createElement('p');detail.textContent=`单价 ¥${row.unitPrice.toFixed(2)} · 原优惠 ¥${row.discountAmount.toFixed(2)} · ${row.staffId==null?'未分配员工':'原员工编号 '+row.staffId}`;
  const label=doc.createElement('label');label.textContent='数量';const input=doc.createElement('input');input.inputMode='decimal';input.maxLength=13;input.value=String(row.quantity);input.disabled=!editor.editable;
  input.onchange=()=>{try{editor.setQuantity(index,input.value);onChange();}catch(error){input.value=String(row.quantity);onError(error);}};label.append(input);
  const remove=doc.createElement('button');remove.textContent='移除此项目';remove.disabled=!editor.editable;remove.onclick=()=>{try{editor.remove(index);onChange();}catch(error){onError(error);}};
  card.append(title,detail,label,remove);fragment.append(card);
 });
 container.replaceChildren(fragment);
}
