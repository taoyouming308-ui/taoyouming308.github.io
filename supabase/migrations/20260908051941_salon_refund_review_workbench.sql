-- Independent local development. Review never executes a refund.
set statement_timeout='30s';
set lock_timeout='5s';
create or replace function public.salon_get_refund_review(p_actor_staff_id bigint,p_organization_id bigint,p_store_id bigint,p_refund_request_id bigint)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_refund public.salon_refund_requests;v_order public.salon_orders;v_lines jsonb;v_payments jsonb;
begin
 perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','refund_read');
 perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','read');
 select * into v_refund from public.salon_refund_requests where organization_id=p_organization_id and store_id=p_store_id and id=p_refund_request_id;
 if not found then raise exception '退款申请不存在或不属于当前门店';end if;
 select * into v_order from public.salon_orders where organization_id=p_organization_id and store_id=p_store_id and id=v_refund.order_id;
 if not found then raise exception '退款原订单范围不匹配';end if;
 select coalesce(jsonb_agg(jsonb_build_object('orderLineId',l.order_line_id,'name',l.item_name,'type',l.item_type,'quantity',l.quantity::text,'amount',l.refund_amount::text) order by l.order_line_id),'[]') into v_lines
 from public.salon_refund_request_lines l join public.salon_order_lines o on o.organization_id=l.organization_id and o.id=l.order_line_id and o.order_id=v_order.id
 where l.organization_id=p_organization_id and l.refund_request_id=p_refund_request_id;
 select coalesce(jsonb_agg(jsonb_build_object('paymentId',l.original_payment_id,'method',l.payment_method,'amount',l.refund_amount::text,'units',l.refund_units::text,'originalMethod',p.payment_method,'originalAmount',p.amount::text,'originalUnits',p.member_units::text,'originalStatus',p.status) order by l.original_payment_id),'[]') into v_payments
 from public.salon_refund_request_payments l join public.salon_payments p on p.organization_id=l.organization_id and p.id=l.original_payment_id and p.order_id=v_order.id and p.store_id=p_store_id and p.reversal_of_id is null
 where l.organization_id=p_organization_id and l.refund_request_id=p_refund_request_id;
 if jsonb_array_length(v_lines)<>(select count(*) from public.salon_refund_request_lines where organization_id=p_organization_id and refund_request_id=p_refund_request_id) or jsonb_array_length(v_payments)<>(select count(*) from public.salon_refund_request_payments where organization_id=p_organization_id and refund_request_id=p_refund_request_id) then raise exception '退款明细或支付分配范围不匹配';end if;
 return jsonb_build_object('refund',jsonb_build_object('id',v_refund.id,'organizationId',v_refund.organization_id,'storeId',v_refund.store_id,'orderId',v_refund.order_id,'type',v_refund.refund_type,'status',v_refund.status,'amount',v_refund.requested_amount::text,'reason',v_refund.reason,'createdByStaffId',v_refund.created_by_staff_id,'reviewedByStaffId',v_refund.reviewed_by_staff_id,'decisionReason',v_refund.decision_reason),
 'order',jsonb_build_object('id',v_order.id,'number',v_order.order_no,'status',v_order.status,'payable',v_order.payable_total::text,'refundedTotal',v_order.refunded_total::text,'version',v_order.edit_version),'lines',v_lines,'payments',v_payments);
end $$;
revoke execute on function public.salon_get_refund_review(bigint,bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.salon_get_refund_review(bigint,bigint,bigint,bigint) to service_role;

create or replace function public.salon_list_refund_review_queue(p_actor_staff_id bigint,p_organization_id bigint,p_store_id bigint,p_status text,p_before_id bigint default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_rows jsonb;
begin
 perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','refund_read');
 if p_status is null or p_status not in ('','submitted','approved','rejected','executed','cancelled') or (p_before_id is not null and p_before_id<=0) then raise exception '退款列表筛选无效';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'orderId',r.order_id,'status',r.status,'amount',r.requested_amount::text) order by r.id desc),'[]') into v_rows
 from (select id,order_id,status,requested_amount from public.salon_refund_requests where organization_id=p_organization_id and store_id=p_store_id and (p_status='' or status=p_status) and (p_before_id is null or id<p_before_id) order by id desc limit 51) r;
 return jsonb_build_object('organizationId',p_organization_id,'storeId',p_store_id,'rows',case when jsonb_array_length(v_rows)>50 then v_rows-50 else v_rows end,'nextBeforeId',case when jsonb_array_length(v_rows)>50 then v_rows->49->'id' else null end);
end $$;
create index salon_refund_review_cursor_idx on public.salon_refund_requests(organization_id,store_id,id desc);
create index salon_refund_review_status_cursor_idx on public.salon_refund_requests(organization_id,store_id,status,id desc);
create index salon_refund_payment_allocation_idx on public.salon_refund_request_payments(organization_id,original_payment_id,refund_request_id);
revoke execute on function public.salon_list_refund_review_queue(bigint,bigint,bigint,text,bigint) from public,anon,authenticated;
grant execute on function public.salon_list_refund_review_queue(bigint,bigint,bigint,text,bigint) to service_role;

create or replace function public.salon_review_refund_checked(p_actor_staff_id bigint,p_organization_id bigint,p_store_id bigint,p_refund_request_id bigint,p_request_key text,p_decision text,p_reason text,p_expected_snapshot jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_req public.salon_operation_requests;v_refund public.salon_refund_requests;v_current jsonb;v_response jsonb;
begin
 perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','refund_approve');
 perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','refund_read');
 perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','read');
 if p_request_key is null or p_request_key !~ '^[A-Za-z0-9._:-]{16,120}$' or p_decision is null or p_decision not in ('approved','rejected') or nullif(btrim(p_reason),'') is null or length(p_reason)>500 or p_expected_snapshot is null or jsonb_typeof(p_expected_snapshot)<>'object' then raise exception '审批决定、意见或核对快照无效';end if;
 v_req:=salon_private.claim_staff_request(p_organization_id,p_store_id,p_request_key,'refund_review','refund_'||p_decision,p_refund_request_id,p_actor_staff_id,jsonb_build_object('p_actor_staff_id',p_actor_staff_id,'p_organization_id',p_organization_id,'p_store_id',p_store_id,'p_refund_request_id',p_refund_request_id,'p_decision',p_decision,'p_reason',p_reason,'p_expected_snapshot',p_expected_snapshot),'orders','refund_approve');
 if v_req.completed_at is not null then return v_req.response_json;end if;
 select * into v_refund from public.salon_refund_requests where organization_id=p_organization_id and store_id=p_store_id and id=p_refund_request_id for update;
 if not found or v_refund.status<>'submitted' then raise exception '退款申请不存在或当前不可审批';end if;
 if v_refund.created_by_staff_id=p_actor_staff_id then raise exception '退款申请人与审批人不能为同一人';end if;
 -- Same refund -> order -> sorted payment locks as the existing execution path.
 perform 1 from public.salon_orders where organization_id=p_organization_id and store_id=p_store_id and id=v_refund.order_id for update;
 perform 1 from public.salon_payments where organization_id=p_organization_id and store_id=p_store_id and order_id=v_refund.order_id order by id for update;
 v_current:=public.salon_get_refund_review(p_actor_staff_id,p_organization_id,p_store_id,p_refund_request_id);
 if v_current<>p_expected_snapshot then raise exception '退款核对内容已变化，请重新载入后审批';end if;
 if p_decision='approved' then
  if v_current->'order'->>'status'<>'paid' or v_refund.requested_amount<=0 or v_refund.requested_amount>(v_current->'order'->>'payable')::numeric-(v_current->'order'->>'refundedTotal')::numeric then raise exception '退款原订单状态或可退金额已变化';end if;
  if jsonb_array_length(v_current->'lines')=0 or jsonb_array_length(v_current->'payments')=0 or
   (select sum((x->>'amount')::numeric) from jsonb_array_elements(v_current->'lines') x)<>v_refund.requested_amount or
   (select sum((x->>'amount')::numeric) from jsonb_array_elements(v_current->'payments') x)<>v_refund.requested_amount or
   exists(select 1 from jsonb_array_elements(v_current->'payments') x where x->>'originalStatus'<>'confirmed' or x->>'originalMethod'<>x->>'method' or (x->>'amount')::numeric<=0 or (x->>'amount')::numeric>(x->>'originalAmount')::numeric or (x->>'method'='member_units' and ((x->>'units')::numeric<=0 or (x->>'units')::numeric>(x->>'originalUnits')::numeric)))
  then raise exception '退款分配与原支付不匹配';end if;
  if exists(
   select 1 from public.salon_refund_request_payments x
   join public.salon_payments p on p.organization_id=x.organization_id and p.id=x.original_payment_id
   where x.organization_id=p_organization_id and x.refund_request_id=p_refund_request_id and
   ((p.payment_method<>'member_units' and x.refund_units<>0) or
    (select sum(a.refund_amount) from public.salon_refund_request_payments a join public.salon_refund_requests r on r.organization_id=a.organization_id and r.id=a.refund_request_id where a.organization_id=p_organization_id and a.original_payment_id=p.id and r.status in ('submitted','approved','executed'))>p.amount or
    (p.payment_method='member_units' and (select sum(a.refund_units) from public.salon_refund_request_payments a join public.salon_refund_requests r on r.organization_id=a.organization_id and r.id=a.refund_request_id where a.organization_id=p_organization_id and a.original_payment_id=p.id and r.status in ('submitted','approved','executed'))>p.member_units))
  ) then raise exception '累计退款分配金额或次数超过原支付';end if;
 end if;
 update public.salon_refund_requests set status=p_decision,reviewed_by_staff_id=p_actor_staff_id,decision_reason=btrim(p_reason),reviewed_at=now() where id=p_refund_request_id;
 v_response:=jsonb_build_object('refundRequestId',p_refund_request_id,'orderId',v_refund.order_id,'status',p_decision,'reviewedByStaffId',p_actor_staff_id);
 insert into public.salon_audit_events(organization_id,store_id,actor_staff_id,entity_type,entity_id,action,before_json,after_json,reason) values(p_organization_id,p_store_id,p_actor_staff_id,'refund_request',p_refund_request_id::text,'review',jsonb_build_object('status','submitted'),v_response,btrim(p_reason));
 update public.salon_operation_requests set response_json=v_response,completed_at=now() where id=v_req.id;
 return v_response;
end $$;
revoke execute on function public.salon_review_refund_checked(bigint,bigint,bigint,bigint,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.salon_review_refund_checked(bigint,bigint,bigint,bigint,text,text,text,jsonb) to service_role;

create or replace function public.salon_lookup_staff_request(
 p_actor_staff_id bigint,p_organization_id bigint,p_store_id bigint,
 p_lookup_key text,p_target_operation text
) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_resource text;v_id_field text;v_result jsonb;v_unknown jsonb;
begin
 if p_lookup_key is null or p_lookup_key !~ '^[A-Za-z0-9._:-]{16,120}$' then
  raise exception '请求核对编号无效';
 end if;
 if p_target_operation='refund_review' then
  perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','refund_approve');
  perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','refund_read');
  perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','read');
  select jsonb_build_object('operation',p_target_operation,'status','committed','resourceType','refund_request',
   'resourceId',f.id,'completedAt',r.completed_at,'receipt',r.response_json)
  into v_result from public.salon_operation_requests r
  join public.salon_refund_requests f on f.organization_id=r.organization_id and f.store_id=r.store_id
   and f.id=case when (r.response_json->>'refundRequestId') ~ '^[1-9][0-9]{0,17}$' then (r.response_json->>'refundRequestId')::bigint end
   and f.order_id::text=r.response_json->>'orderId'
  where r.organization_id=p_organization_id and r.store_id=p_store_id and r.request_key=p_lookup_key
   and r.action='refund_review' and r.staff_request_actor_id=p_actor_staff_id
   and r.staff_payload_digest is not null and r.completed_at is not null
   and r.response_json->>'reviewedByStaffId'=p_actor_staff_id::text and r.response_json->>'status' in ('approved','rejected');
  return coalesce(v_result,jsonb_build_object('operation',p_target_operation,'status','unconfirmed'));
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
