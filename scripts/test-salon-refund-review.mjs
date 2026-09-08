import assert from 'node:assert/strict';
import {inspectRefund,refundPage,verifyRefundDecision} from '../packages/salon-core/refund-review.mjs';
import {createSalonHandler} from '../supabase/functions/_shared/salon-api-core.mjs';
const scope={organizationId:1,storeId:1,staffId:1};
const sample={refund:{id:3,organizationId:1,storeId:1,orderId:2,type:'full',status:'submitted',amount:'12.34',reason:'test',createdByStaffId:2,reviewedByStaffId:null,decisionReason:''},
 order:{id:2,number:'TEST',status:'paid',payable:'12.34',refundedTotal:'0.00',version:4},
 lines:[{orderLineId:5,name:'synthetic',type:'product',quantity:'1.000',amount:'12.34'}],
 payments:[{paymentId:8,method:'cash',amount:'12.34',units:'0.000',originalMethod:'cash',originalAmount:'12.34',originalUnits:'0.000',originalStatus:'confirmed'}]};
const record=inspectRefund(sample,3,scope);assert.ok(record.canApprove);assert.ok(Object.isFrozen(record.snapshot.payments[0]));
for(const type of ['service','product','package','year_card']){const data=structuredClone(sample);data.lines[0].type=type;assert.ok(inspectRefund(data,3,scope).canApprove);}
assert.equal(inspectRefund(sample,3,{...scope,staffId:2}).canReview,false);
for(const tweak of [x=>x.refund.storeId=2,x=>x.order.id=4,x=>x.lines.push(x.lines[0]),x=>x.payments[0].originalAmount='1e2',x=>x.payments[0].paymentId=0]){const bad=structuredClone(sample);tweak(bad);assert.throws(()=>inspectRefund(bad,3,scope));}
for(const tweak of [x=>x.refund.status='approved',x=>x.payments[0].originalStatus='reversed',x=>x.payments[0].amount='12.33',x=>x.order.refundedTotal='1.00',x=>x.lines=[],x=>{x.payments[0].method='member_units';x.payments[0].originalMethod='member_units';}]){const bad=structuredClone(sample);tweak(bad);assert.equal(inspectRefund(bad,3,scope).canApprove,false);}
const page={organizationId:1,storeId:1,rows:[{id:3,orderId:2,status:'submitted',amount:'12.34'}],nextBeforeId:null};
assert.equal(refundPage(page,scope).rows.length,1);
for(const bad of [{...page,storeId:2},{...page,nextBeforeId:3},{...page,rows:[page.rows[0],page.rows[0]]}])assert.throws(()=>refundPage(bad,scope));
assert.throws(()=>refundPage(page,scope,{status:'approved'}));
verifyRefundDecision({refundRequestId:3,orderId:2,status:'approved',reviewedByStaffId:1},3,scope,'approved');
assert.throws(()=>verifyRefundDecision({refundRequestId:3,orderId:2,status:'approved',reviewedByStaffId:2},3,scope));
let calls=[];
const handler=createSalonHandler({verifyUser:async()=>({id:'test'}),findStaff:async()=>({id:1,organization_id:1,store_id:1,employment_status:'active'}),resolveStore:async()=>1,invoke:async(name,args)=>{calls.push({name,args});return {};}});
const send=body=>handler(new Request('http://127.0.0.1/test',{method:'POST',headers:{Authorization:'Bearer synthetic-token-123456'},body:JSON.stringify(body)}));
const payload={operation:'refund_review',refundRequestId:3,requestKey:'refund-unit-key-0001',decision:'approved',reason:'test',expectedSnapshot:sample};
assert.equal((await send({...payload,actorStaffId:2,organizationId:2})).status,200);assert.equal(calls.at(-1).name,'salon_review_refund_checked');assert.equal(calls.at(-1).args.p_actor_staff_id,1);
for(const delta of [{expectedSnapshot:null},{expectedSnapshot:[]},{reason:' '},{reason:'x'.repeat(501)},{decision:'executed'},{requestKey:'x'}]){const count=calls.length;assert.notEqual((await send({...payload,...delta})).status,200);assert.equal(calls.length,count);}
assert.equal((await send({operation:'refund_queue',status:'submitted',beforeId:9})).status,200);assert.equal(calls.at(-1).name,'salon_list_refund_review_queue');
for(const delta of [{status:'unknown'},{beforeId:'9'},{beforeId:-1}])assert.notEqual((await send({operation:'refund_queue',...delta})).status,200);
console.log('Refund review model/API passed: scope, sums, maker/checker, immutable snapshot, queue, original payment and strict review contract');
