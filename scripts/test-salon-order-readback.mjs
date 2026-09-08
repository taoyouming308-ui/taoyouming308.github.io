import assert from 'node:assert/strict';
import {verifyOrderLines} from '../packages/salon-core/order-readback.mjs';
const scope={organizationId:1,storeId:2};
const submitted=[{catalogItemId:7,quantity:1.125,unitPrice:12.34,discountAmount:1,staffId:8},{catalogItemId:7,quantity:2,unitPrice:10,discountAmount:0}];
const receipt=()=>({order:{id:3,organization_id:1,store_id:2,order_no:'TEST',status:'draft',subtotal:33.88,discount_total:1,payable_total:32.88},lines:submitted.map((line,i)=>({id:i+1,organization_id:1,order_id:3,catalog_item_id:line.catalogItemId,quantity:line.quantity,unit_price:line.unitPrice,discount_amount:line.discountAmount,staff_id:line.staffId??null,item_name:'合成项目',line_total:i?20:12.88,service_status:'pending'}))});
assert.equal(verifyOrderLines(receipt(),3,scope,submitted),true);
const reordered=receipt();reordered.lines.reverse();reordered.lines[1].quantity='1.125';reordered.lines[0].quantity='2.000';
assert.equal(verifyOrderLines(reordered,3,scope,submitted),true,'row order and decimal formatting are not business differences');
for(const change of [
 data=>data.lines.pop(),data=>data.lines.push({...data.lines[0],id:4}),
 data=>data.lines[1]={...data.lines[0],id:2},data=>data.lines[0].quantity=2,
 data=>data.lines[0].unit_price=12.35,data=>data.lines[0].discount_amount=0,
 data=>data.lines[0].catalog_item_id=9,data=>data.lines[0].staff_id=9,
 data=>data.lines[0].quantity='1.1250',data=>data.lines[0].quantity='1e0',
 data=>data.order.store_id=9,data=>data.lines[0].order_id=9,
]){const data=receipt();change(data);assert.throws(()=>verifyOrderLines(data,3,scope,submitted));}
const duplicate=[submitted[0],submitted[0]],data=receipt();data.lines[1]={...data.lines[0],id:2};
assert.equal(verifyOrderLines(data,3,scope,duplicate),true,'identical lines must be counted, not deduplicated');
assert.throws(()=>verifyOrderLines(receipt(),3,scope,[]));
console.log('Order readback passed: complete multiset, duplicate counts, quantity/price/discount/staff identity and scope; no float arithmetic');
