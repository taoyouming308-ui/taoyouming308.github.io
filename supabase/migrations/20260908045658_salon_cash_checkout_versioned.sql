-- Independent development only: cash full settlement, atomic stock + payment + receipt.
set statement_timeout='30s';
set lock_timeout='5s';
alter table public.salon_operation_requests drop constraint salon_operation_requests_action_check;
alter table public.salon_operation_requests add constraint salon_operation_requests_action_check check(action in(
 'cash_checkout','checkout','refund','inventory_move','customer_create','customer_status','customer_relation','catalog_create','catalog_enable','catalog_status','inventory_count',
 'member_open','member_recharge','member_status','order_create','order_lines','order_status','refund_request','refund_review','refund_execute','finance_entry',
 'staff_create','staff_status','commission_rule','payroll_generate','payroll_review','role_create','role_status','staff_assign','staff_transfer',
 'customer_bind','consent_set','work_create','work_submit','work_review','review_create','review_moderate','campaign_create','campaign_status','booking_request','booking_review','booking_cancel','booking_cancel_review','booking_reschedule','booking_change_request','booking_change_review'
));
create or replace function public.salon_checkout_cash(
 p_actor_staff_id bigint,p_organization_id bigint,p_store_id bigint,p_order_id bigint,
 p_request_key text,p_expected_version integer,p_amount text,p_tendered text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_request public.salon_operation_requests;v_order public.salon_orders;v_amount numeric(12,2);v_tendered numeric(12,2);v_payment_id bigint;v_response jsonb;v_stock record;v_balance public.salon_inventory_balances;
begin
 perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','checkout');
 perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','read');
 if p_request_key is null or p_request_key !~ '^[A-Za-z0-9._:-]{16,120}$' then raise exception '请求幂等键无效';end if;
 v_request:=salon_private.claim_staff_request(p_organization_id,p_store_id,p_request_key,'cash_checkout','order',p_order_id,p_actor_staff_id,jsonb_build_object('p_actor_staff_id',p_actor_staff_id,'p_organization_id',p_organization_id,'p_store_id',p_store_id,'p_order_id',p_order_id,'p_expected_version',p_expected_version,'p_amount',p_amount,'p_tendered',p_tendered),'orders','checkout');
 if v_request.completed_at is not null then return v_request.response_json;end if;
 if p_amount is null or p_tendered is null or p_amount !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' or p_tendered !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' then raise exception '现金金额必须为最多两位小数';end if;
 v_amount:=p_amount::numeric;v_tendered:=p_tendered::numeric;
 if v_amount<=0 or v_tendered<v_amount then raise exception '现金金额无效或实收不足';end if;
 select * into v_order from public.salon_orders where organization_id=p_organization_id and store_id=p_store_id and id=p_order_id for update;
 if not found then raise exception '订单不存在或不属于当前门店';end if;
 if p_expected_version is null or p_expected_version<0 or v_order.edit_version<>p_expected_version then raise exception '订单版本已变化，请重新读取后确认';end if;
 if v_order.status<>'awaiting_payment' or not exists(select 1 from public.salon_order_lines where organization_id=p_organization_id and order_id=p_order_id) then raise exception '仅有明细的待收银订单可以收款';end if;
 if v_amount<>v_order.payable_total then raise exception '现金支付金额必须等于订单应收';end if;
 if exists(select 1 from public.salon_payments where organization_id=p_organization_id and order_id=p_order_id and status in ('pending','confirmed')) then raise exception '订单已有支付记录，请人工核对';end if;
 -- Same parent-order then ascending product lock order as existing checkout/refund.
 for v_stock in select catalog_item_id,sum(quantity)::numeric(14,3) quantity from public.salon_order_lines where organization_id=p_organization_id and order_id=p_order_id and item_type='product' group by catalog_item_id order by catalog_item_id loop
  if not exists(select 1 from public.salon_catalog_store_settings where organization_id=p_organization_id and store_id=p_store_id and catalog_item_id=v_stock.catalog_item_id and status='active' and stock_tracked) then raise exception '订单商品未启用当前门店库存';end if;
  select * into v_balance from public.salon_inventory_balances where organization_id=p_organization_id and store_id=p_store_id and catalog_item_id=v_stock.catalog_item_id for update;
  if not found or v_balance.quantity<v_stock.quantity then raise exception '商品库存不足，收银已回滚';end if;
  update public.salon_inventory_balances set quantity=quantity-v_stock.quantity,updated_at=now() where organization_id=p_organization_id and store_id=p_store_id and catalog_item_id=v_stock.catalog_item_id;
  insert into public.salon_inventory_ledger(organization_id,store_id,catalog_item_id,movement_type,quantity_delta,quantity_before,quantity_after,order_id,reason) values(p_organization_id,p_store_id,v_stock.catalog_item_id,'sale',-v_stock.quantity,v_balance.quantity,v_balance.quantity-v_stock.quantity,p_order_id,'现金订单收银自动出库');
 end loop;
 insert into public.salon_payments(organization_id,store_id,order_id,payment_method,amount,tendered_amount,change_amount,status,confirmed_at) values(p_organization_id,p_store_id,p_order_id,'cash',v_amount,v_tendered,v_tendered-v_amount,'confirmed',now()) returning id into v_payment_id;
 update public.salon_orders set status='paid',paid_at=now(),updated_at=now() where organization_id=p_organization_id and id=p_order_id;
 v_response:=jsonb_build_object('organizationId',p_organization_id,'storeId',p_store_id,'orderId',p_order_id,'paymentId',v_payment_id,'requestKey',p_request_key,'expectedVersion',p_expected_version,'status','paid','method','cash','paid',v_amount::text,'tendered',v_tendered::text,'change',(v_tendered-v_amount)::numeric(12,2)::text);
 insert into public.salon_audit_events(organization_id,store_id,actor_staff_id,entity_type,entity_id,action,after_json,reason) values(p_organization_id,p_store_id,p_actor_staff_id,'order',p_order_id::text,'checkout',v_response,'现金全额收款');
 update public.salon_operation_requests set response_json=v_response,completed_at=now() where id=v_request.id;
 return v_response;
end $$;
revoke execute on function public.salon_checkout_cash(bigint,bigint,bigint,bigint,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.salon_checkout_cash(bigint,bigint,bigint,bigint,text,integer,text,text) to service_role;

create or replace function public.salon_lookup_staff_request(
 p_actor_staff_id bigint,p_organization_id bigint,p_store_id bigint,
 p_lookup_key text,p_target_operation text
) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_resource text;v_id_field text;v_result jsonb;v_unknown jsonb;
begin
 if p_lookup_key is null or p_lookup_key !~ '^[A-Za-z0-9._:-]{16,120}$' then
  raise exception '请求核对编号无效';
 end if;
 if p_target_operation='cash_checkout' then
  perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','checkout');
  perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','read');
  select jsonb_build_object('operation',p_target_operation,'status','committed','resourceType','order',
   'resourceId',r.response_json->>'orderId','completedAt',r.completed_at,'receipt',r.response_json,'paymentStatus',p.status)
  into v_result from public.salon_operation_requests r
  join public.salon_payments p on p.organization_id=r.organization_id and p.store_id=r.store_id
   and p.id=case when (r.response_json->>'paymentId') ~ '^[1-9][0-9]{0,17}$' then (r.response_json->>'paymentId')::bigint end
   and p.order_id=case when (r.response_json->>'orderId') ~ '^[1-9][0-9]{0,17}$' then (r.response_json->>'orderId')::bigint end
   and p.payment_method='cash' and p.amount::text=r.response_json->>'paid'
   and p.tendered_amount::text=r.response_json->>'tendered' and p.change_amount::text=r.response_json->>'change'
  where r.organization_id=p_organization_id and r.store_id=p_store_id and r.request_key=p_lookup_key
   and r.action='cash_checkout' and r.staff_request_actor_id=p_actor_staff_id
   and r.staff_payload_digest is not null and r.completed_at is not null;
  return coalesce(v_result,jsonb_build_object('operation',p_target_operation,'status','unconfirmed'));
 end if;
 case p_target_operation
  when 'customer_create' then v_resource:='customers';v_id_field:='customerId';
  when 'order_create' then v_resource:='orders';v_id_field:='orderId';
  when 'order_status' then v_resource:='orders';v_id_field:='orderId';
  when 'order_lines' then v_resource:='orders';v_id_field:='orderId';
  else raise exception '不支持核对该操作';
 end case;
 -- Recheck current permissions even when an old completed receipt exists.
 perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,v_resource,'write');
 perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,v_resource,'read');
 v_unknown:=jsonb_build_object('operation',p_target_operation,'status','unconfirmed');
 -- The existing (organization_id, request_key) unique index bounds this exact lookup.
 -- No lock/claim/update: an uncommitted transaction stays indistinguishable from no receipt.
 select jsonb_build_object('operation',p_target_operation,'status','committed',
          'resourceType',case when v_resource='customers' then 'customer' else 'order' end,
          'resourceId',r.response_json->>v_id_field,'completedAt',r.completed_at)
 into v_result
 from public.salon_operation_requests r
 where r.organization_id=p_organization_id and r.store_id=p_store_id
  and r.request_key=p_lookup_key and r.action=p_target_operation
  and r.staff_request_actor_id=p_actor_staff_id
  and r.staff_payload_digest is not null
  and r.completed_at is not null
  and jsonb_typeof(r.response_json)='object'
  and (r.response_json->>v_id_field) ~ '^[1-9][0-9]{0,18}$';
 -- Missing, legacy, wrong actor/store/action and incomplete results reveal no receipt details.
 return coalesce(v_result,v_unknown);
end $$;
revoke execute on function public.salon_lookup_staff_request(bigint,bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.salon_lookup_staff_request(bigint,bigint,bigint,text,text) to service_role;
comment on function public.salon_lookup_staff_request(bigint,bigint,bigint,text,text) is
 'Own-store, own-actor minimal historical receipt only. unconfirmed is not failure or authorization to resubmit; committed is not current business status.';
