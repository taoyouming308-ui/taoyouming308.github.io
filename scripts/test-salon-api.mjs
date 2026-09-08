import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createSalonHandler} from '../supabase/functions/_shared/salon-api-core.mjs';

const calls=[],logs=[];
const handler=createSalonHandler({
  verifyUser:async token=>token==='valid-user-token-123456789'?{id:'auth-user-1'}:null,
  findStaff:async id=>id==='auth-user-1'?{id:7,organization_id:3,store_id:9,display_name:'员工甲',employment_status:'active'}:null,
  resolveStore:async scope=>scope.requestedStoreId===10?10:9,
  invoke:async(rpc,args)=>{calls.push({rpc,args});return{ok:true,rpc}},
  read:async(operation,scope)=>{calls.push({operation,scope});return[{ok:true}]},
  log:async row=>logs.push(row),
});
const request=(body,token='valid-user-token-123456789')=>new Request('http://local/salon-api',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
for(const targetOperation of ['customer_create','order_create','order_lines']){
 const query={operation:'request_lookup',targetOperation,requestKey:'lookup-api-000001',storeId:10,actorStaffId:999,organizationId:999};
 assert.equal((await handler(request(query))).status,200);
 assert.deepEqual(calls.at(-1),{rpc:'salon_lookup_staff_request',args:{p_actor_staff_id:7,p_organization_id:3,p_store_id:10,p_lookup_key:'lookup-api-000001',p_target_operation:targetOperation}});
}
for(const patch of [{requestKey:'x'},{requestKey:'x'.repeat(121)},{requestKey:12},{requestKey:' padded-request-001'},{targetOperation:'checkout'},{targetOperation:'__proto__'},{targetOperation:null}]){
 const count=calls.length;
 assert.equal((await handler(request({operation:'request_lookup',targetOperation:'order_create',requestKey:'lookup-api-000001',...patch}))).status,400);
 assert.equal(calls.length,count);
}
const changeReview={expectedTimeZone:'Asia/Shanghai',expectedTimeVersion:0,operation:'reschedule_review',storeId:9,changeRequestId:31,requestKey:'staff-change-00001',decision:'approved',reason:'确认改期',actorStaffId:999};
assert.equal((await handler(request({operation:'store_time',storeId:10,actorStaffId:999,organizationId:999}))).status,200);assert.equal(calls.at(-1).rpc,'salon_get_store_time_context');assert.deepEqual(calls.at(-1).args,{p_actor_staff_id:7,p_organization_id:3,p_store_id:10});
assert.equal((await handler(request(changeReview))).status,200);assert.equal(calls.at(-1).rpc,'salon_review_reschedule_with_time');assert.equal(calls.at(-1).args.p_actor_staff_id,7);
assert.equal((await handler(request({...changeReview,decision:'confirmed'}))).status,400);
assert.equal((await handler(request({operation:'reschedule_requests',storeId:9,limit:999}))).status,200);assert.equal(calls.at(-1).args.p_limit,200);

let result=await handler(new Request('http://local/salon-api',{method:'POST'}));
assert.equal(result.status,403,'missing bearer token must be rejected');
for(const decision of ['approved','rejected']){
 const tested=await handler(request({operation:'booking_cancel_review',bookingRequestId:23,decision,reason:'合成复核',requestKey:'cancel-api-test-0001',actorStaffId:999,organizationId:999}));
 assert.equal(tested.status,200);assert.equal(calls.at(-1).rpc,'salon_review_booking_cancel');
 assert.deepEqual(calls.at(-1).args,{p_actor_staff_id:7,p_organization_id:3,p_store_id:9,p_booking_request_id:23,p_request_key:'cancel-api-test-0001',p_decision:decision,p_reason:'合成复核'});
}
for(const fields of [{decision:'confirmed',reason:'test'},{decision:'approved',reason:''}])assert.equal((await handler(request({operation:'booking_cancel_review',bookingRequestId:23,requestKey:'cancel-api-test-0002',...fields}))).status,400);
calls.length=0;
const reschedule={expectedTimeZone:'Asia/Shanghai',expectedTimeVersion:0,operation:'booking_reschedule',bookingRequestId:23,requestKey:'reschedule-api-test',expectedVersion:0,expectedStartsAt:'2026-10-01T01:00:00+00:00',expectedEndsAt:'2026-10-01T01:30:00+00:00',newStartsAt:'2026-10-02T09:00:00+08:00',reason:'合成改期'};
assert.equal((await handler(request(reschedule))).status,200);assert.equal(calls.at(-1).rpc,'salon_reschedule_booking_with_time');
assert.deepEqual(calls.at(-1).args,{p_actor_staff_id:7,p_organization_id:3,p_store_id:9,p_booking_request_id:23,p_request_key:'reschedule-api-test',p_expected_starts_at:reschedule.expectedStartsAt,p_expected_ends_at:reschedule.expectedEndsAt,p_expected_version:0,p_new_starts_at:reschedule.newStartsAt,p_reason:'合成改期',p_expected_time_zone:'Asia/Shanghai',p_expected_time_version:0});
for(const patch of [{expectedTimeVersion:null},{expectedTimeVersion:'0'},{expectedTimeZone:''},{expectedTimeVersion:-1}])assert.equal((await handler(request({...reschedule,...patch}))).status,400);
for(const expectedVersion of [null,-1,1.2,'0',2147483648])assert.equal((await handler(request({...reschedule,expectedVersion}))).status,400);
for(const field of ['expectedStartsAt','expectedEndsAt','newStartsAt'])for(const bad of ['2026-10-02T09:00','infinity','2026-99-02T09:00:00Z',null])assert.equal((await handler(request({...reschedule,[field]:bad}))).status,400);
assert.equal((await handler(request({...reschedule,reason:''}))).status,400);
calls.length=0;
result=await handler(request({operation:'checkout',orderId:4,requestKey:'checkout-request-0001',payments:[{method:'cash',amount:120}],p_store_id:999}));
assert.equal(result.status,200);assert.equal(calls[0].rpc,'salon_checkout_order');
assert.deepEqual({actor:calls[0].args.p_actor_staff_id,org:calls[0].args.p_organization_id,store:calls[0].args.p_store_id},{actor:7,org:3,store:9},'identity and store must come from server staff binding');
assert.equal('staffId' in calls[0].args,false);assert.equal(calls[0].args.p_order_id,4);
result=await handler(request({operation:'refund_execute',refundRequestId:51,requestKey:'refund-execute-0001'}));
assert.equal(result.status,200);assert.equal(calls[1].rpc,'salon_execute_refund_request');
result=await handler(request({operation:'inventory_move',catalogItemId:8,requestKey:'inventory-request-001',movementType:'sale',quantity:1,orderId:4,reason:'订单销售'}));
assert.equal(result.status,200);assert.equal(calls[2].rpc,'salon_move_inventory');
result=await handler(request({operation:'context'}));assert.equal(result.status,200);assert.deepEqual(result.body.data,{staffId:7,organizationId:3,storeId:9,homeStoreId:9,displayName:'员工甲'});
result=await handler(request({operation:'order_receipt',orderId:4,storeId:9}));assert.equal(result.status,200);assert.deepEqual(calls.at(-1).scope,{actorStaffId:7,organizationId:3,storeId:9,orderId:4});
result=await handler(request({operation:'inventory',catalogItemId:8}));assert.equal(result.status,200);assert.equal(calls.at(-1).scope.storeId,9);
result=await handler(request({operation:'customer_create',requestKey:'customer-create-0001',displayName:'测试顾客',phone:'138 0000 0000',ownerStaffId:7,source:'walkin',tags:['新客']}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_create_customer');assert.equal(calls.at(-1).args.p_store_id,9);
result=await handler(request({operation:'customer_status',requestKey:'customer-status-0001',customerId:12,status:'frozen',reason:'顾客申请'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_set_customer_status');
result=await handler(request({operation:'customer_relation',requestKey:'customer-relation-01',customerId:12,ownerStaffId:7,source:'referral',tags:['重点']}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_update_customer_relation');
result=await handler(request({operation:'customers',query:'13800000000',status:'active',limit:50,storeId:9}));assert.equal(result.status,200);assert.deepEqual(calls.at(-1).scope,{actorStaffId:7,organizationId:3,storeId:9,query:'13800000000',status:'active',limit:50});
result=await handler(request({operation:'catalog_create',requestKey:'catalog-create-0001',code:'prd-01',itemType:'product',name:'洗发水',listPrice:128,memberPrice:108,costPrice:50,unit:'瓶',stockTracked:true,safetyStock:3}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_create_catalog_item');assert.equal(calls.at(-1).args.p_store_id,9);
result=await handler(request({operation:'catalog_enable',requestKey:'catalog-enable-0001',catalogItemId:21,stockTracked:true,safetyStock:2}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_enable_catalog_item');
result=await handler(request({operation:'catalog_status',requestKey:'catalog-status-0001',catalogItemId:21,status:'disabled',reason:'门店停售'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_set_catalog_status');
result=await handler(request({operation:'inventory_count',requestKey:'inventory-count-001',catalogItemId:21,counted:8,reason:'月末盘点'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_count_inventory');
result=await handler(request({operation:'catalog',itemType:'product',status:'active',query:'洗发',limit:50,storeId:9}));assert.equal(result.status,200);assert.deepEqual(calls.at(-1).scope,{actorStaffId:7,organizationId:3,storeId:9,itemType:'product',status:'active',query:'洗发',limit:50});
result=await handler(request({operation:'member_open',requestKey:'member-open-00001',customerId:12,accountType:'stored_value',accountNo:'SV-1',displayName:'储值卡',usableScope:'store'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_open_member_account');
result=await handler(request({operation:'member_recharge',requestKey:'member-recharge-01',accountId:31,paidAmount:500,cashAdded:500,bonusAdded:50,unitsAdded:0,paymentMethod:'wechat',externalReference:'TEST-1',reason:'测试充值'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_recharge_member_account');
result=await handler(request({operation:'member_status',requestKey:'member-status-0001',accountId:31,status:'frozen',reason:'顾客申请'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_set_member_status');
result=await handler(request({operation:'members',customerId:12,status:'active',limit:50,storeId:9}));assert.equal(result.status,200);assert.deepEqual(calls.at(-1).scope,{actorStaffId:7,organizationId:3,storeId:9,customerId:12,status:'active',limit:50});
result=await handler(request({operation:'order_create',requestKey:'order-create-00001',customerId:12,notes:'到店开单'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_create_order');
result=await handler(request({operation:'order_lines',expectedVersion:0,requestKey:'order-lines-00001',orderId:41,lines:[{catalogItemId:21,quantity:1,unitPrice:180,discountAmount:20,staffId:7}],discountReason:'新客优惠'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_replace_order_lines_versioned');assert.equal(calls.at(-1).args.p_expected_version,0);
for(const expectedVersion of [undefined,null,'0',-1,1.5,2147483648])assert.equal((await handler(request({operation:'order_lines',expectedVersion,requestKey:'order-version-bad1',orderId:41,lines:[{catalogItemId:21,quantity:1}]}))).status,400);
result=await handler(request({operation:'order_status',requestKey:'order-status-0001',orderId:41,status:'opened',expectedVersion:0}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_set_order_status_versioned');assert.equal(calls.at(-1).args.p_expected_version,0);
result=await handler(request({operation:'order_detail',orderId:41,storeId:9}));assert.equal(result.status,200);assert.deepEqual(calls.at(-1).scope,{actorStaffId:7,organizationId:3,storeId:9,orderId:41});
result=await handler(request({operation:'refund_request',requestKey:'refund-apply-0001',orderId:41,refundType:'partial',reason:'部分退货',lines:[{orderLineId:5,quantity:1,amount:80}],payments:[{originalPaymentId:9,amount:80}]}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_submit_refund_request');
result=await handler(request({operation:'refund_review',requestKey:'refund-review-001',refundRequestId:51,decision:'approved',reason:'核对通过',expectedSnapshot:{refund:{id:51}}}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_review_refund_checked');
result=await handler(request({operation:'finance_entry',requestKey:'finance-entry-0001',entryDate:'2026-09-06',entryType:'expense',category:'房租',amount:100,note:'测试支出'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_add_finance_entry');assert.equal(calls.at(-1).args.p_store_id,9);
result=await handler(request({operation:'operating_report',dateFrom:'2026-09-01',dateTo:'2026-09-30',storeId:9}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_get_operating_report');assert.equal(calls.at(-1).args.p_store_id,9);
result=await handler(request({operation:'staff_create',requestKey:'staff-create-00001',staffNo:'S01',displayName:'员工乙',roleId:2,position:'发型师',levelName:'高级',baseSalary:3000}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_create_staff');assert.equal(calls.at(-1).args.p_store_id,9);
result=await handler(request({operation:'staff_status',requestKey:'staff-status-00001',staffId:8,status:'leave',reason:'休假'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_set_staff_status');
result=await handler(request({operation:'commission_rule',requestKey:'commission-rule-001',category:'service',name:'服务提成',rate:40,validFrom:'2026-09-01'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_create_commission_rule');
result=await handler(request({operation:'payroll_generate',requestKey:'payroll-generate-01',staffId:8,month:'2026-09-01',bonus:200,deduction:100,reason:'月度调整'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_generate_payroll');
result=await handler(request({operation:'payroll_review',requestKey:'payroll-review-001',payrollId:61,decision:'approved',reason:'核对通过'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_review_payroll');
result=await handler(request({operation:'payrolls',month:'2026-09-01',storeId:9}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_list_payroll');assert.equal(calls.at(-1).args.p_store_id,9);
result=await handler(request({operation:'role_create',requestKey:'role-create-00001',name:'区域经理',dataScope:'organization',permissions:['reports/read','audit/read']}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_create_role');
result=await handler(request({operation:'role_status',requestKey:'role-status-00001',roleId:5,status:'disabled',reason:'停用测试'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_set_role_status');
result=await handler(request({operation:'staff_assign',requestKey:'staff-assign-00001',staffId:8,roleId:5,reason:'跨店授权',storeId:10}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_assign_staff_store_role');assert.equal(calls.at(-1).args.p_store_id,10);
result=await handler(request({operation:'staff_transfer',requestKey:'staff-transfer-001',staffId:8,targetStoreId:10,targetRoleId:5,effectiveDate:'2026-09-06',reason:'正式调店'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_transfer_staff');
result=await handler(request({operation:'stores'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_list_staff_stores');
result=await handler(request({operation:'audit',entityType:'staff',limit:50,storeId:10}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_list_audit_events');assert.equal(calls.at(-1).args.p_store_id,10);
result=await handler(request({operation:'customer_bind',customerId:12,authUserId:'123e4567-e89b-12d3-a456-426614174000',requestKey:'customer-bind-0001',reason:'顾客本人确认绑定'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_bind_customer_identity');
result=await handler(request({operation:'work_create',requestKey:'work-create-00001',customerId:12,orderId:41,consentId:71,title:'短发层次',description:'服务后作品',assetRef:'private/works/test.jpg'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_create_work');
result=await handler(request({operation:'work_submit',requestKey:'work-submit-00001',workId:81}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_submit_work');
result=await handler(request({operation:'work_review',requestKey:'work-review-00001',workId:81,decision:'published',reason:'授权有效'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_review_work');
result=await handler(request({operation:'works',status:'pending_review',limit:50}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_list_works');
result=await handler(request({operation:'review_moderate',requestKey:'review-moderate-1',reviewId:91,status:'hidden',reason:'顾客主动申请隐藏'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_moderate_review');
result=await handler(request({operation:'reviews',status:'published',limit:50}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_list_reviews');
result=await handler(request({operation:'campaign_create',requestKey:'campaign-create-01',name:'新客关怀',channel:'in_app',audience:{tag:'新客'},messageTemplate:'欢迎预约',startsOn:'2026-09-07',endsOn:'2026-09-30'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_create_campaign');
result=await handler(request({operation:'campaign_status',requestKey:'campaign-status-01',campaignId:101,status:'active',reason:'人工确认启用'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_set_campaign_status');
result=await handler(request({operation:'campaigns',status:'active',limit:50}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_list_campaigns');
result=await handler(request({operation:'booking_review',requestKey:'booking-review-001',bookingRequestId:111,decision:'confirmed',staffId:7,reason:'档期确认'}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_review_customer_booking');
result=await handler(request({operation:'booking_requests',status:'submitted',limit:50}));assert.equal(result.status,200);assert.equal(calls.at(-1).rpc,'salon_list_customer_bookings');
result=await handler(request({operation:'refunds',status:'submitted',limit:50,storeId:9}));assert.equal(result.status,200);assert.equal(calls.at(-1).scope.storeId,9);
result=await handler(request({operation:'refund_execute',refundRequestId:51,requestKey:'short'}));assert.equal(result.status,400);
result=await handler(request({operation:'checkout',orderId:4,requestKey:'checkout-request-0002',payments:[]}));assert.equal(result.status,400);
result=await handler(request({operation:'unknown'}));assert.equal(result.status,400);
result=await handler(request({operation:'refund_execute',refundRequestId:51,requestKey:'refund-execute-0002'},'invalid-user-token-123456'));assert.equal(result.status,403);
assert.ok(logs.every(log=>!('token'in log)&&!('payments'in log)&&!('amount'in log)),'request logs must not contain credentials or business payloads');
assert.ok(logs.every(log=>typeof log.request_id==='string'&&log.request_id.length>20));
assert.equal(logs.find(log=>log.operation==='unknown').error_code,'UNSUPPORTED_OPERATION');

const failing=createSalonHandler({verifyUser:async()=>({id:'auth-user-1'}),findStaff:async()=>({id:7,organization_id:3,store_id:9,employment_status:'active'}),resolveStore:async()=>9,invoke:async()=>{throw new Error('数据库请求失败 (500) secret internal detail')}});
result=await failing(request({operation:'refund_execute',refundRequestId:51,requestKey:'refund-execute-0003'}));assert.equal(result.status,500);assert.equal(result.body.code,'DATABASE_OPERATION_FAILED');assert.equal(result.body.error,'操作未完成，请稍后重试');assert.doesNotMatch(JSON.stringify(result.body),/secret internal detail/);

const edge=fs.readFileSync('supabase/functions/salon-api/index.ts','utf8');
const migration=fs.readFileSync('supabase/migrations/20260906064313_salon_auth_identity.sql','utf8');
assert.match(edge,/\/auth\/v1\/user/);assert.match(edge,/SALON_ALLOWED_ORIGINS/);
assert.match(edge,/salon_api_request_logs/);assert.match(edge,/X-Request-ID/);
assert.match(edge,/rpc\/salon_get_order_receipt/);
assert.match(edge,/rpc\/salon_list_inventory_balances/);
assert.doesNotMatch(edge,/salon_payments\?select|salon_account_ledger\?select|salon_inventory_balances\?select/);
assert.doesNotMatch(edge,/user_metadata|raw_user_meta_data/);
assert.doesNotMatch(edge,/service_role.{0,80}(console|Response|body)/i);
assert.match(edge,/rpc\/salon_list_customers/);assert.doesNotMatch(edge,/select=.*phone_normalized/,'customer list must not select raw phones in Edge code');
assert.match(migration,/auth_user_id uuid/);assert.match(migration,/unique index salon_staff_auth_user_org_idx/);
const logMigration=fs.readFileSync('supabase/migrations/20260906064812_salon_api_request_log.sql','utf8'),logColumns=logMigration.match(/create table public\.salon_api_request_logs\(([\s\S]*?)\);/i)?.[1]||'';assert.ok(logColumns);assert.doesNotMatch(logColumns,/payload|phone|customer_name|amount/i);
console.log('salon api tests passed: scoped reads, stable errors, request ids, metadata-only logs, secret boundary');
