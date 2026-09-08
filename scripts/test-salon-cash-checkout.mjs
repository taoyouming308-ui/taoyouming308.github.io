import assert from 'node:assert/strict';
import {verifyCashReceipt,verifyCashLookup} from '../packages/salon-core/cash-receipt.mjs';
import {createSalonHandler} from '../supabase/functions/_shared/salon-api-core.mjs';
const scope={organizationId:1,storeId:2},key='synthetic-cash-key-0001';
const r={...scope,orderId:3,paymentId:4,requestKey:key,expectedVersion:5,status:'paid',method:'cash',paid:'12.34',tendered:'20.00',change:'7.66'};
const expected={orderId:3,version:5,payable:'12.34',tendered:'20.00',change:'7.66'};
assert.deepEqual(verifyCashReceipt(r,scope,key,expected),r);
for(const delta of [{storeId:1},{organizationId:2},{orderId:4},{paymentId:0},{expectedVersion:4},{requestKey:'another-key'},{method:'member_value'},{paid:'12.35'},{tendered:'20.01'},{change:'7.65'},{paid:12.34},{paid:'1e1'},{status:'reversed'}])assert.throws(()=>verifyCashReceipt({...r,...delta},scope,key,expected));
const lookup={operation:'cash_checkout',status:'committed',resourceType:'order',resourceId:'3',completedAt:'2026-09-08T00:00:00Z',receipt:r,paymentStatus:'confirmed'};
verifyCashLookup(lookup,scope,key,expected);verifyCashLookup({...lookup,paymentStatus:'reversed'},scope,key);
for(const delta of [{resourceId:4},{completedAt:null},{status:'unconfirmed'},{paymentStatus:'pending'}])assert.throws(()=>verifyCashLookup({...lookup,...delta},scope,key));
let calls=[];
const handler=createSalonHandler({verifyUser:async()=>({id:'synthetic-user'}),findStaff:async()=>({id:1,organization_id:1,store_id:2,employment_status:'active'}),resolveStore:async()=>2,invoke:async(name,args)=>{calls.push({name,args});return r;}});
const payload={operation:'cash_checkout',orderId:3,expectedVersion:5,amount:'12.34',tendered:'20.00',requestKey:key};
const send=body=>handler(new Request('http://127.0.0.1/api',{method:'POST',headers:{Authorization:'Bearer synthetic-only-token-123456'},body:JSON.stringify(body)}));
assert.equal((await send({...payload,actorStaffId:999,organizationId:999})).status,200);
assert.equal(calls[0].name,'salon_checkout_cash');assert.equal(calls[0].args.p_actor_staff_id,1);assert.equal(calls[0].args.p_organization_id,1);
for(const delta of [{expectedVersion:null},{expectedVersion:'5'},{expectedVersion:-1},{expectedVersion:2147483648},{amount:12.34},{amount:'1e1'},{amount:'12.345'},{tendered:' 20'},{requestKey:key+' '.repeat(130)}]){
 const count=calls.length;assert.notEqual((await send({...payload,...delta})).status,200);assert.equal(calls.length,count);
}
console.log('Cash receipt/API tests passed: exact fields, scope, request binding, historic reversal and strict inputs');
