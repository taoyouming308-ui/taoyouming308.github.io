import assert from 'node:assert/strict';
import {inspectOrder} from '../packages/salon-core/order-inspection.mjs';
const scope={organizationId:1,storeId:2};
const fixture=()=>({order:{id:3,organization_id:1,store_id:2,order_no:'TEST-3',status:'draft',subtotal:'12.34',discount_total:'1.00',payable_total:'11.34',notes:'PRIVATE-NOTES',customer_id:99},lines:[{id:4,organization_id:1,order_id:3,item_name:'<img src=x>',quantity:'1.000',unit_price:'12.34',discount_amount:'1.00',line_total:'11.34',service_status:'pending',staff_id:98}],payments:[{secret:'PRIVATE-PAYMENT'}]});
const result=inspectOrder(fixture(),3,scope);
assert.equal(result.payable,'¥11.34');assert.equal(result.lines[0].name,'<img src=x>');assert.equal(result.status,'草稿');
assert.doesNotMatch(JSON.stringify(result),/PRIVATE|customer_id|staff_id|payments/);
assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.lines)&&Object.isFrozen(result.lines[0]));
for(const change of [
 data=>data.order.id=9,data=>data.order.store_id=9,data=>data.order.organization_id=9,
 data=>data.order.status='constructor',data=>data.order.payable_total='1.234',
 data=>data.lines[0].order_id=9,data=>data.lines[0].organization_id=9,
 data=>data.lines[0].quantity='0',data=>data.lines[0].quantity='1e2',data=>data.lines[0].quantity='1.0001',
 data=>data.lines[0].service_status='unknown',data=>data.lines.push({...data.lines[0]}),data=>data.lines=null,
]){const data=fixture();change(data);assert.throws(()=>inspectOrder(data,3,scope));}
const empty=fixture();empty.lines=[];assert.deepEqual(inspectOrder(empty,3,scope).lines,[]);
for(const status of ['opened','in_service','awaiting_payment','paid','cancelled','reversed']){const data=fixture();data.order.status=status;assert.ok(inspectOrder(data,3,scope).status);}
assert.throws(()=>inspectOrder(fixture(),'3<script>',scope));
console.log('Order inspection projection passed: scoped IDs, minimal fields, exact money, states, quantities, duplicate lines and frozen output');
