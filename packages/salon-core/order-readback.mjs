// Match the exact submitted line multiset. A mismatch is not proof of rollback:
// another authorized operation may have changed the order after this write.
import {serverId,amountToCents} from './api-client.mjs';
import {inspectOrder} from './order-inspection.mjs';
const mismatch=()=>{throw Error('订单回读明细与本次提交不一致，可能已被后续修改；请只读核对原订单，不要重复保存。');};
function quantity(value){
 const text=String(value);
 if(!/^\d{1,9}(\.\d{1,3})?$/.test(text))mismatch();
 const [whole,fraction='']=text.split('.'),milli=BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0'));
 if(milli<=0n)mismatch();return milli.toString();
}
function key(line,returned){
 return JSON.stringify([
  serverId(returned?line.catalog_item_id:line.catalogItemId),
  quantity(line.quantity),amountToCents(returned?line.unit_price:line.unitPrice),
  amountToCents(returned?line.discount_amount:line.discountAmount),
  (returned?line.staff_id:line.staffId)==null?null:serverId(returned?line.staff_id:line.staffId),
 ]);
}
export function verifyOrderLines(data,orderId,scope,submitted){
 // Reuse the strict read-only projection for scope, IDs, states and numeric shape.
 inspectOrder(data,orderId,scope);
 if(!Array.isArray(submitted)||submitted.length<1||submitted.length>100||data.lines.length!==submitted.length)mismatch();
 const remaining=new Map();
 for(const line of submitted){const fingerprint=key(line,false);remaining.set(fingerprint,(remaining.get(fingerprint)||0)+1);}
 for(const line of data.lines){
  const fingerprint=key(line,true),count=remaining.get(fingerprint)||0;
  if(!count)mismatch();remaining.set(fingerprint,count-1);
 }
 return true;
}
