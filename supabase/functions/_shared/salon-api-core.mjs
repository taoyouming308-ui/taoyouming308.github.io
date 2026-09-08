const OPERATIONS={
  orders:{rpc:'salon_list_orders'},
  request_lookup:{rpc:'salon_lookup_staff_request'},
  store_time:{rpc:'salon_get_store_time_context'},
  reschedule_review:{rpc:'salon_review_reschedule_with_time'},reschedule_requests:{rpc:'salon_list_reschedule_requests'},
  checkout:{rpc:'salon_checkout_order',fields:['orderId','requestKey','payments']},
  inventory_move:{rpc:'salon_move_inventory',fields:['catalogItemId','requestKey','movementType','quantity','orderId','reason']},
  customer_create:{rpc:'salon_create_customer'},customer_status:{rpc:'salon_set_customer_status'},customer_relation:{rpc:'salon_update_customer_relation'},
  catalog_create:{rpc:'salon_create_catalog_item'},catalog_enable:{rpc:'salon_enable_catalog_item'},catalog_status:{rpc:'salon_set_catalog_status'},inventory_count:{rpc:'salon_count_inventory'},
  member_open:{rpc:'salon_open_member_account'},member_recharge:{rpc:'salon_recharge_member_account'},member_status:{rpc:'salon_set_member_status'},
  order_create:{rpc:'salon_create_order'},order_lines:{rpc:'salon_replace_order_lines_versioned'},order_status:{rpc:'salon_set_order_status_versioned'},
  refund_request:{rpc:'salon_submit_refund_request'},refund_review:{rpc:'salon_review_refund_request'},refund_execute:{rpc:'salon_execute_refund_request'},
  finance_entry:{rpc:'salon_add_finance_entry'},operating_report:{rpc:'salon_get_operating_report'},
  staff_create:{rpc:'salon_create_staff'},staff_status:{rpc:'salon_set_staff_status'},commission_rule:{rpc:'salon_create_commission_rule'},payroll_generate:{rpc:'salon_generate_payroll'},payroll_review:{rpc:'salon_review_payroll'},payrolls:{rpc:'salon_list_payroll'},
  role_create:{rpc:'salon_create_role'},role_status:{rpc:'salon_set_role_status'},staff_assign:{rpc:'salon_assign_staff_store_role'},staff_transfer:{rpc:'salon_transfer_staff'},stores:{rpc:'salon_list_staff_stores'},audit:{rpc:'salon_list_audit_events'},
  customer_bind:{rpc:'salon_bind_customer_identity'},work_create:{rpc:'salon_create_work'},work_submit:{rpc:'salon_submit_work'},work_review:{rpc:'salon_review_work'},works:{rpc:'salon_list_works'},
  review_moderate:{rpc:'salon_moderate_review'},reviews:{rpc:'salon_list_reviews'},campaign_create:{rpc:'salon_create_campaign'},campaign_status:{rpc:'salon_set_campaign_status'},campaigns:{rpc:'salon_list_campaigns'},
  booking_review:{rpc:'salon_review_customer_booking'},booking_cancel_review:{rpc:'salon_review_booking_cancel'},booking_reschedule:{rpc:'salon_reschedule_booking_with_time'},booking_requests:{rpc:'salon_list_customer_bookings'},
  context:{read:true},order_receipt:{read:true},order_detail:{read:true},refunds:{read:true},inventory:{read:true},customers:{read:true},catalog:{read:true},members:{read:true},
};

function text(value,max=160){return String(value==null?'':value).trim().slice(0,max)}
function integer(value,label,optional=false){if(optional&&(value==null||value===''))return null;const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw new Error(label+'无效');return n}
function nonnegative(value,label){const n=Number(value==null||value===''?0:value);if(!Number.isFinite(n)||n<0)throw new Error(label+'无效');return n}
function requestKey(value){const key=text(value,120);if(key.length<16||!/^[A-Za-z0-9._:-]+$/.test(key))throw new Error('请求幂等键无效');return key}
function uuid(value,label){const v=text(value,40);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v))throw new Error(label+'无效');return v}
function timestamp(value,label){const v=text(value,64);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))throw new Error(label+'必须是带时区的有效时间');return v}
function bearer(request){const value=request.headers.get('Authorization')||'';const match=value.match(/^Bearer\s+(.+)$/i);if(!match||match[1].length<20)throw new Error('请重新登录');return match[1]}
function errorCode(message){if(/请重新登录|登录已过期/.test(message))return'AUTH_REQUIRED';if(/账号|员工|停用/.test(message))return'STAFF_INACTIVE';if(/不支持/.test(message))return'UNSUPPORTED_OPERATION';if(/数据库请求失败/.test(message))return'DATABASE_OPERATION_FAILED';return'VALIDATION_ERROR'}

export function createSalonHandler(deps){return async function(request){
  if(request.method==='OPTIONS')return{status:204,body:null};
  if(request.method!=='POST')return{status:405,body:{error:'POST required'}};
  const started=Date.now(),requestId=crypto.randomUUID();let userId=null,staff=null,operation='',activeStoreId=null;
  const finish=async(status,body)=>{const code=body?.error?errorCode(body.error):null,outcome=status<300?'success':status<500?'rejected':'failed';try{await deps.log?.({request_id:requestId,auth_user_id:userId,organization_id:staff?.organization_id||null,store_id:activeStoreId||staff?.store_id||null,staff_id:staff?.id||null,operation,outcome,http_status:status,error_code:code,duration_ms:Math.max(0,Date.now()-started)})}catch{}return{status,body:{...(body||{}),requestId}}};
  try{
    const token=bearer(request),user=await deps.verifyUser(token);
    if(!user?.id)throw new Error('登录已过期，请重新登录');
    userId=user.id;staff=await deps.findStaff(user.id);
    if(!staff||staff.employment_status!=='active')throw new Error('账号未绑定在职员工或已停用');
    const payload=await request.json();if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('请求内容无效');operation=text(payload.operation,40);const spec=Object.hasOwn(OPERATIONS,operation)?OPERATIONS[operation]:null;
    if(!spec)throw new Error('不支持的操作');
    const actor=integer(staff.id,'员工'),org=integer(staff.organization_id,'组织'),homeStore=integer(staff.store_id,'门店'),requestedStore=payload.storeId==null||payload.storeId===''?homeStore:integer(payload.storeId,'门店');activeStoreId=integer(await deps.resolveStore?.({actorStaffId:actor,organizationId:org,requestedStoreId:requestedStore}),'门店');
    if(activeStoreId!==requestedStore)throw new Error('当前员工不能进入该门店');
    const common={p_actor_staff_id:actor,p_organization_id:org,p_store_id:activeStoreId};
    if(operation==='context')return finish(200,{data:{staffId:actor,organizationId:org,storeId:activeStoreId,homeStoreId:homeStore,displayName:text(staff.display_name,100)}});
    if(operation==='order_receipt')return finish(200,{data:await deps.read('order_receipt',{actorStaffId:actor,organizationId:common.p_organization_id,storeId:common.p_store_id,orderId:integer(payload.orderId,'订单')})});
    if(operation==='order_detail')return finish(200,{data:await deps.read('order_detail',{actorStaffId:common.p_actor_staff_id,organizationId:common.p_organization_id,storeId:common.p_store_id,orderId:integer(payload.orderId,'订单')})});
    if(operation==='inventory')return finish(200,{data:await deps.read('inventory',{actorStaffId:actor,organizationId:common.p_organization_id,storeId:common.p_store_id,catalogItemId:integer(payload.catalogItemId,'商品',true)})});
    if(operation==='customers')return finish(200,{data:await deps.read('customers',{actorStaffId:common.p_actor_staff_id,organizationId:common.p_organization_id,storeId:common.p_store_id,query:text(payload.query,100),status:text(payload.status,20),limit:Math.min(integer(payload.limit||100,'数量'),200)})});
    if(operation==='catalog')return finish(200,{data:await deps.read('catalog',{actorStaffId:common.p_actor_staff_id,organizationId:common.p_organization_id,storeId:common.p_store_id,itemType:text(payload.itemType,20),status:text(payload.status,20),query:text(payload.query,100),limit:Math.min(integer(payload.limit||200,'数量'),500)})});
    if(operation==='members')return finish(200,{data:await deps.read('members',{actorStaffId:common.p_actor_staff_id,organizationId:common.p_organization_id,storeId:common.p_store_id,customerId:integer(payload.customerId,'顾客',true),status:text(payload.status,20),limit:Math.min(integer(payload.limit||200,'数量'),500)})});
    if(operation==='refunds')return finish(200,{data:await deps.read('refunds',{actorStaffId:common.p_actor_staff_id,organizationId:common.p_organization_id,storeId:common.p_store_id,status:text(payload.status,20),limit:Math.min(integer(payload.limit||200,'数量'),500)})});
    let args;
    if(operation==='orders'){
      const state=payload.status??'';
      if(typeof state!=='string'||!['','draft','opened','in_service','awaiting_payment','paid','cancelled','reversed'].includes(state))throw new Error('订单状态筛选无效');
      if(payload.beforeId!=null&&(!Number.isSafeInteger(payload.beforeId)||payload.beforeId<=0))throw new Error('订单分页游标无效');
      args={...common,p_status:state,p_before_id:payload.beforeId??null};
    }else if(operation==='request_lookup'){
      if(typeof payload.requestKey!=='string'||!/^[A-Za-z0-9._:-]{16,120}$/.test(payload.requestKey))throw new Error('请求核对编号无效');
      if(!['customer_create','order_create','order_lines','order_status'].includes(payload.targetOperation))throw new Error('不支持核对该操作');
      args={...common,p_lookup_key:payload.requestKey,p_target_operation:payload.targetOperation};
    }else if(operation==='store_time'){
      args=common;
    }else if(operation==='checkout'){
      if(!Array.isArray(payload.payments)||!payload.payments.length)throw new Error('请添加支付方式');
      args={...common,p_order_id:integer(payload.orderId,'订单'),p_request_key:requestKey(payload.requestKey),p_payments:payload.payments};
    }else if(operation==='inventory_move'){
      const movementType=text(payload.movementType,30),quantity=Number(payload.quantity),reason=text(payload.reason,500);
      if(!['receive','sale','consume','refund'].includes(movementType)||!Number.isFinite(quantity)||quantity<=0||!reason)throw new Error('库存操作参数无效');
      args={...common,p_catalog_item_id:integer(payload.catalogItemId,'商品'),p_request_key:requestKey(payload.requestKey),p_movement_type:movementType,p_quantity:quantity,p_order_id:integer(payload.orderId,'订单',true),p_reason:reason};
    }else if(operation==='customer_create'){
      const name=text(payload.displayName,100),phone=text(payload.phone,30),source=text(payload.source||'walkin',30),tags=Array.isArray(payload.tags)?payload.tags.map(x=>text(x,30)):[];
      if(!name)throw new Error('顾客姓名不能为空');
      args={...common,p_request_key:requestKey(payload.requestKey),p_display_name:name,p_phone:phone||null,p_birthday:text(payload.birthday,10)||null,p_owner_staff_id:integer(payload.ownerStaffId,'负责人',true),p_source:source,p_tags:tags};
    }else if(operation==='customer_status'){
      const status=text(payload.status,20),reason=text(payload.reason,500);if(!['active','frozen'].includes(status)||!reason)throw new Error('顾客状态或变更原因无效');
      args={...common,p_customer_id:integer(payload.customerId,'顾客'),p_request_key:requestKey(payload.requestKey),p_status:status,p_reason:reason};
    }else if(operation==='customer_relation'){
      const source=text(payload.source||'walkin',30),tags=Array.isArray(payload.tags)?payload.tags.map(x=>text(x,30)):[];
      args={...common,p_customer_id:integer(payload.customerId,'顾客'),p_request_key:requestKey(payload.requestKey),p_owner_staff_id:integer(payload.ownerStaffId,'负责人',true),p_source:source,p_tags:tags};
    }else if(operation==='catalog_create'){
      const itemType=text(payload.itemType,20),code=text(payload.code,40),name=text(payload.name,100);if(!code||!name)throw new Error('项目商品编号或名称无效');
      args={...common,p_request_key:requestKey(payload.requestKey),p_code:code,p_item_type:itemType,p_name:name,p_category:text(payload.category,100),p_list_price:nonnegative(payload.listPrice,'售价'),p_member_price:nonnegative(payload.memberPrice,'会员价'),p_cost_price:nonnegative(payload.costPrice,'成本'),p_unit:text(payload.unit||'次',20),p_duration_minutes:payload.durationMinutes==null?null:integer(payload.durationMinutes,'服务时长'),p_stock_tracked:payload.stockTracked===true,p_safety_stock:nonnegative(payload.safetyStock,'安全库存')};
    }else if(operation==='catalog_enable'){
      args={...common,p_catalog_item_id:integer(payload.catalogItemId,'项目商品'),p_request_key:requestKey(payload.requestKey),p_stock_tracked:payload.stockTracked===true,p_safety_stock:nonnegative(payload.safetyStock,'安全库存')};
    }else if(operation==='catalog_status'){
      const status=text(payload.status,20),reason=text(payload.reason,500);if(!['active','disabled'].includes(status)||!reason)throw new Error('项目商品状态或原因无效');
      args={...common,p_catalog_item_id:integer(payload.catalogItemId,'项目商品'),p_request_key:requestKey(payload.requestKey),p_status:status,p_reason:reason};
    }else if(operation==='inventory_count'){
      const counted=Number(payload.counted),reason=text(payload.reason,500);if(!Number.isFinite(counted)||counted<0||!reason)throw new Error('盘点数量或原因无效');
      args={...common,p_catalog_item_id:integer(payload.catalogItemId,'商品'),p_request_key:requestKey(payload.requestKey),p_counted:counted,p_reason:reason};
    }else if(operation==='member_open'){
      const accountType=text(payload.accountType,30),accountNo=text(payload.accountNo,50),name=text(payload.displayName,100),scope=text(payload.usableScope||'store',20);if(!accountNo||!name)throw new Error('会员账户参数无效');
      args={...common,p_customer_id:integer(payload.customerId,'顾客'),p_request_key:requestKey(payload.requestKey),p_account_type:accountType,p_account_no:accountNo,p_display_name:name,p_usable_scope:scope,p_expires_on:text(payload.expiresOn,10)||null};
    }else if(operation==='member_recharge'){
      const reason=text(payload.reason,500);if(!reason)throw new Error('充值原因不能为空');args={...common,p_account_id:integer(payload.accountId,'会员账户'),p_request_key:requestKey(payload.requestKey),p_paid_amount:nonnegative(payload.paidAmount,'实收金额'),p_cash_added:nonnegative(payload.cashAdded,'本金增加'),p_bonus_added:nonnegative(payload.bonusAdded,'赠送增加'),p_units_added:nonnegative(payload.unitsAdded,'次数增加'),p_payment_method:text(payload.paymentMethod,30),p_external_reference:text(payload.externalReference,100),p_reason:reason};
    }else if(operation==='member_status'){
      const status=text(payload.status,20),reason=text(payload.reason,500);if(!['active','frozen'].includes(status)||!reason)throw new Error('会员账户状态或原因无效');args={...common,p_account_id:integer(payload.accountId,'会员账户'),p_request_key:requestKey(payload.requestKey),p_status:status,p_reason:reason};
    }else if(operation==='order_create'){
      args={...common,p_request_key:requestKey(payload.requestKey),p_customer_id:integer(payload.customerId,'顾客',true),p_appointment_id:integer(payload.appointmentId,'预约',true),p_notes:text(payload.notes,500)};
    }else if(operation==='order_lines'){
      if(!Array.isArray(payload.lines)||!payload.lines.length||payload.lines.length>100)throw new Error('订单明细必须为1至100项');
      if(!Number.isInteger(payload.expectedVersion)||payload.expectedVersion<0||payload.expectedVersion>2147483647)throw new Error('订单编辑版本无效');
      args={...common,p_order_id:integer(payload.orderId,'订单'),p_request_key:requestKey(payload.requestKey),p_lines:payload.lines,p_discount_reason:text(payload.discountReason,500),p_expected_version:payload.expectedVersion};
    }else if(operation==='order_status'){
      if(!Number.isInteger(payload.expectedVersion)||payload.expectedVersion<0||payload.expectedVersion>2147483647)throw new Error('订单编辑版本无效');
      const status=text(payload.status,30),reason=text(payload.reason,500);args={...common,p_order_id:integer(payload.orderId,'订单'),p_request_key:requestKey(payload.requestKey),p_status:status,p_reason:reason,p_expected_version:payload.expectedVersion};
    }else if(operation==='refund_request'){
      const type=text(payload.refundType,20),reason=text(payload.reason,500);if(!reason)throw new Error('退款原因不能为空');args={...common,p_order_id:integer(payload.orderId,'订单'),p_request_key:requestKey(payload.requestKey),p_refund_type:type,p_reason:reason,p_lines:Array.isArray(payload.lines)?payload.lines:[],p_payments:Array.isArray(payload.payments)?payload.payments:[]};
    }else if(operation==='refund_review'){
      const decision=text(payload.decision,20),reason=text(payload.reason,500);if(!reason)throw new Error('审批意见不能为空');args={...common,p_refund_request_id:integer(payload.refundRequestId,'退款申请'),p_request_key:requestKey(payload.requestKey),p_decision:decision,p_reason:reason};
    }else if(operation==='refund_execute'){
      args={...common,p_refund_request_id:integer(payload.refundRequestId,'退款申请'),p_request_key:requestKey(payload.requestKey)};
    }else if(operation==='finance_entry'){
      const type=text(payload.entryType,20),category=text(payload.category,100),note=text(payload.note,500),amount=Number(payload.amount);if(!['income','expense'].includes(type)||!category||!note||!Number.isFinite(amount)||amount<=0)throw new Error('收支记录参数无效');args={...common,p_request_key:requestKey(payload.requestKey),p_entry_date:text(payload.entryDate,10),p_entry_type:type,p_category:category,p_amount:amount,p_note:note};
    }else if(operation==='operating_report'){
      const from=text(payload.dateFrom,10),to=text(payload.dateTo,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to))throw new Error('报表日期范围无效');args={...common,p_date_from:from,p_date_to:to};
    }else if(operation==='staff_create'){
      const no=text(payload.staffNo,40),name=text(payload.displayName,100),salary=Number(payload.baseSalary||0);if(!no||!name||!Number.isFinite(salary)||salary<0)throw new Error('员工资料参数无效');args={...common,p_request_key:requestKey(payload.requestKey),p_staff_no:no,p_display_name:name,p_role_id:integer(payload.roleId,'角色',true),p_position:text(payload.position,100),p_level_name:text(payload.levelName,100),p_base_salary:salary};
    }else if(operation==='staff_status'){
      const status=text(payload.status,30),reason=text(payload.reason,500);if(!['active','leave','departed'].includes(status)||!reason)throw new Error('员工状态或变更原因无效');args={...common,p_target_staff_id:integer(payload.staffId,'员工'),p_request_key:requestKey(payload.requestKey),p_status:status,p_reason:reason};
    }else if(operation==='commission_rule'){
      const category=text(payload.category,20),name=text(payload.name,100),rate=Number(payload.rate),from=text(payload.validFrom,10),to=text(payload.validTo,10);if(!['service','product'].includes(category)||!name||!Number.isFinite(rate)||rate<0||rate>100||!/^\d{4}-\d{2}-\d{2}$/.test(from)||(to&&!/^\d{4}-\d{2}-\d{2}$/.test(to)))throw new Error('提成规则参数无效');args={...common,p_request_key:requestKey(payload.requestKey),p_category:category,p_name:name,p_rate:rate,p_valid_from:from,p_valid_to:to||null};
    }else if(operation==='payroll_generate'){
      const month=text(payload.month,10),bonus=Number(payload.bonus||0),deduction=Number(payload.deduction||0),reason=text(payload.reason,500);if(!/^\d{4}-\d{2}-01$/.test(month)||!Number.isFinite(bonus)||bonus<0||!Number.isFinite(deduction)||deduction<0||((bonus>0||deduction>0)&&!reason))throw new Error('工资试算参数无效');args={...common,p_staff_id:integer(payload.staffId,'员工'),p_request_key:requestKey(payload.requestKey),p_month:month,p_bonus:bonus,p_deduction:deduction,p_reason:reason};
    }else if(operation==='payroll_review'){
      const decision=text(payload.decision,20),reason=text(payload.reason,500);if(!['approved','rejected'].includes(decision)||!reason)throw new Error('工资审批决定或意见无效');args={...common,p_payroll_id:integer(payload.payrollId,'工资单'),p_request_key:requestKey(payload.requestKey),p_decision:decision,p_reason:reason};
    }else if(operation==='payrolls'){
      const month=text(payload.month,10);if(month&&!/^\d{4}-\d{2}-01$/.test(month))throw new Error('工资月份无效');args={...common,p_month:month||null};
    }else if(operation==='role_create'){
      const name=text(payload.name,100),scope=text(payload.dataScope,20),permissions=Array.isArray(payload.permissions)?payload.permissions.map(x=>text(x,80)):[];if(!name||!['self','store','organization'].includes(scope)||!permissions.length)throw new Error('角色名称、范围或权限无效');args={...common,p_request_key:requestKey(payload.requestKey),p_name:name,p_data_scope:scope,p_permissions:permissions};
    }else if(operation==='role_status'){
      const status=text(payload.status,20),reason=text(payload.reason,500);if(!['active','disabled'].includes(status)||!reason)throw new Error('角色状态或原因无效');args={...common,p_role_id:integer(payload.roleId,'角色'),p_request_key:requestKey(payload.requestKey),p_status:status,p_reason:reason};
    }else if(operation==='staff_assign'){
      const reason=text(payload.reason,500);if(!reason)throw new Error('角色分配原因不能为空');args={...common,p_target_staff_id:integer(payload.staffId,'员工'),p_role_id:integer(payload.roleId,'角色'),p_request_key:requestKey(payload.requestKey),p_reason:reason};
    }else if(operation==='staff_transfer'){
      const reason=text(payload.reason,500),date=text(payload.effectiveDate,10);if(!reason||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('调店参数无效');args={...common,p_target_staff_id:integer(payload.staffId,'员工'),p_target_store_id:integer(payload.targetStoreId,'目标门店'),p_target_role_id:integer(payload.targetRoleId,'目标角色'),p_request_key:requestKey(payload.requestKey),p_effective_date:date,p_reason:reason};
    }else if(operation==='customer_bind'){
      const reason=text(payload.reason,500);if(!reason)throw new Error('绑定原因不能为空');args={...common,p_customer_id:integer(payload.customerId,'顾客'),p_auth_user_id:uuid(payload.authUserId,'顾客登录账号'),p_request_key:requestKey(payload.requestKey),p_reason:reason};
    }else if(operation==='work_create'){
      const title=text(payload.title,120),asset=text(payload.assetRef,500);if(!title||!asset)throw new Error('作品标题或资源引用无效');args={...common,p_request_key:requestKey(payload.requestKey),p_customer_id:integer(payload.customerId,'顾客',true),p_order_id:integer(payload.orderId,'订单',true),p_consent_id:integer(payload.consentId,'授权',true),p_title:title,p_description:text(payload.description,1000),p_asset_ref:asset};
    }else if(operation==='work_submit'){
      args={...common,p_work_id:integer(payload.workId,'作品'),p_request_key:requestKey(payload.requestKey)};
    }else if(operation==='work_review'){
      const decision=text(payload.decision,20),reason=text(payload.reason,500);if(!['published','rejected'].includes(decision)||!reason)throw new Error('作品审核决定或说明无效');args={...common,p_work_id:integer(payload.workId,'作品'),p_request_key:requestKey(payload.requestKey),p_decision:decision,p_reason:reason};
    }else if(operation==='works'||operation==='reviews'||operation==='campaigns'||operation==='booking_requests'){
      args={...common,p_status:text(payload.status,30),p_limit:Math.min(integer(payload.limit||200,'数量'),500)};
    }else if(operation==='review_moderate'){
      const status=text(payload.status,20),reason=text(payload.reason,500);if(!['published','hidden'].includes(status)||!reason)throw new Error('评价处理状态或原因无效');args={...common,p_review_id:integer(payload.reviewId,'评价'),p_request_key:requestKey(payload.requestKey),p_status:status,p_reason:reason};
    }else if(operation==='campaign_create'){
      const name=text(payload.name,120),channel=text(payload.channel,30),from=text(payload.startsOn,10),to=text(payload.endsOn,10),audience=payload.audience&&typeof payload.audience==='object'&&!Array.isArray(payload.audience)?payload.audience:{};if(!name||!['in_app','wechat_manual','sms_manual'].includes(channel)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(from)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(to))throw new Error('营销活动参数无效');args={...common,p_request_key:requestKey(payload.requestKey),p_name:name,p_channel:channel,p_audience_json:audience,p_message_template:text(payload.messageTemplate,1000),p_starts_on:from,p_ends_on:to};
    }else if(operation==='campaign_status'){
      const status=text(payload.status,20),reason=text(payload.reason,500);if(!['active','paused','ended','cancelled'].includes(status)||!reason)throw new Error('活动状态或原因无效');args={...common,p_campaign_id:integer(payload.campaignId,'活动'),p_request_key:requestKey(payload.requestKey),p_status:status,p_reason:reason};
    }else if(operation==='reschedule_requests'){
      args={...common,p_status:text(payload.status,30),p_limit:Math.min(integer(payload.limit||200,'数量'),200)};
    }else if(operation==='reschedule_review'){
      const decision=text(payload.decision,20),reason=text(payload.reason,500);if(!['approved','rejected'].includes(decision)||!reason)throw new Error('改期处理决定或原因无效');args={...common,p_change_request_id:integer(payload.changeRequestId,'改期申请'),p_request_key:requestKey(payload.requestKey),p_decision:decision,p_reason:reason};
    }else if(operation==='booking_reschedule'){
      const reason=text(payload.reason,500),version=payload.expectedVersion;if(!reason)throw new Error('改期原因不能为空');if(!Number.isInteger(version)||version<0||version>2147483647)throw new Error('预约改期版本无效');args={...common,p_booking_request_id:integer(payload.bookingRequestId,'预约申请'),p_request_key:requestKey(payload.requestKey),p_expected_starts_at:timestamp(payload.expectedStartsAt,'原开始时间'),p_expected_ends_at:timestamp(payload.expectedEndsAt,'原结束时间'),p_expected_version:version,p_new_starts_at:timestamp(payload.newStartsAt,'新开始时间'),p_reason:reason};
    }else if(operation==='booking_cancel_review'){
      const decision=text(payload.decision,20),reason=text(payload.reason,500);if(!['approved','rejected'].includes(decision)||!reason)throw new Error('取消复核决定或原因无效');args={...common,p_booking_request_id:integer(payload.bookingRequestId,'预约申请'),p_request_key:requestKey(payload.requestKey),p_decision:decision,p_reason:reason};
    }else if(operation==='booking_review'){
      const decision=text(payload.decision,20),reason=text(payload.reason,500);if(!['confirmed','rejected'].includes(decision)||!reason)throw new Error('预约处理决定或原因无效');args={...common,p_booking_request_id:integer(payload.bookingRequestId,'预约申请'),p_request_key:requestKey(payload.requestKey),p_decision:decision,p_staff_id:integer(payload.staffId,'手艺人',decision!=='confirmed'),p_reason:reason};
    }else if(operation==='stores'){
      args={p_actor_staff_id:actor,p_organization_id:org};
    }else{
      args={...common,p_entity_type:text(payload.entityType,60),p_limit:Math.min(integer(payload.limit||200,'数量'),500)};
    }
    if(operation==='booking_reschedule'||operation==='reschedule_review'){
      const zone=payload.expectedTimeZone,version=payload.expectedTimeVersion;
      if(typeof zone!=='string'||!zone||zone!==zone.trim()||zone.length>100||!Number.isInteger(version)||version<0||version>2147483647)throw Error('门店时区和版本无效，请刷新后重试');
      args={...args,p_expected_time_zone:zone,p_expected_time_version:version};
    }
    return finish(200,{data:await deps.invoke(spec.rpc,args)});
  }catch(error){const raw=error?.message||'请求失败',code=errorCode(raw),auth=code==='AUTH_REQUIRED'||code==='STAFF_INACTIVE',message=code==='DATABASE_OPERATION_FAILED'?'操作未完成，请稍后重试':raw;return finish(auth?403:code==='DATABASE_OPERATION_FAILED'?500:400,{error:message,code})}
}}
