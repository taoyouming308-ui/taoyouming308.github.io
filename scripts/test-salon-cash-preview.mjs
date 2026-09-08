import assert from 'node:assert/strict';
import {createCashPreview} from '../packages/salon-core/cash-preview.mjs';
const scope={organizationId:1,storeId:2};
const fixture=()=>({order:{id:3,organization_id:1,store_id:2,order_no:'TEST',status:'awaiting_payment',edit_version:5,subtotal:'12.34',discount_total:'0',payable_total:'12.34'},lines:[{id:4,organization_id:1,order_id:3,item_name:'合成',quantity:1,unit_price:'12.34',discount_amount:0,line_total:'12.34',service_status:'pending'}]});
const cash=createCashPreview();assert.equal(cash.available,false);cash.load(fixture(),scope);
assert.deepEqual(cash.preview(fixture(),scope,'20'),{orderId:3,number:'TEST',version:5,payable:'12.34',tendered:'20.00',change:'7.66'});
assert.equal(cash.preview(fixture(),scope,'12.34').change,'0.00');assert.equal(cash.preview(fixture(),scope,'12.35').change,'0.01');
for(const input of ['',null,20,' 20','1e2','-1','20.001','1,000','12.33','10000000000','Infinity'])assert.throws(()=>cash.preview(fixture(),scope,input));
assert.equal(cash.preview(fixture(),scope,'9999999999.99').change,'9999999987.65');
for(const change of [d=>d.order.id=9,d=>d.order.store_id=9,d=>d.order.edit_version++,d=>d.order.payable_total='12.35',d=>d.order.status='paid',d=>d.lines=[]]){const data=fixture();change(data);assert.throws(()=>cash.preview(data,scope,'20'));}
for(const state of ['draft','opened','in_service','paid','cancelled','reversed']){const data=fixture();data.order.status=state;cash.load(data,scope);assert.equal(cash.available,false);}
const zero=fixture();zero.order.payable_total=0;cash.load(zero,scope);assert.equal(cash.available,false);
cash.clear();assert.equal(cash.order,null);
console.log('Cash preview passed: integer cents, exact change, bounds, invalid input, fresh version/state/scope and no payment payload');
