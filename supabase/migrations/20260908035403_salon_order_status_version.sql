create or replace function public.salon_set_order_status_versioned(p_actor_staff_id bigint,p_organization_id bigint,p_store_id bigint,p_order_id bigint,p_request_key text,p_status text,p_reason text,p_expected_version integer)
returns jsonb language plpgsql security invoker set search_path='' as $$ declare v_request public.salon_operation_requests;v_order public.salon_orders;v_response jsonb;begin
 perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','write');v_request:=salon_private.claim_staff_request(p_organization_id,p_store_id,p_request_key,'order_status','order_status_'||coalesce(p_status,''),p_order_id,p_actor_staff_id,jsonb_build_object('p_actor_staff_id',p_actor_staff_id,'p_organization_id',p_organization_id,'p_store_id',p_store_id,'p_order_id',p_order_id,'p_status',p_status,'p_reason',p_reason,'p_expected_version',p_expected_version),'orders','write');if v_request.completed_at is not null then return v_request.response_json;end if;select * into v_order from public.salon_orders where organization_id=p_organization_id and store_id=p_store_id and id=p_order_id for update;if not found then raise exception '订单不存在或不属于当前门店';end if;
 if p_expected_version is null or p_expected_version<0 or v_order.edit_version<>p_expected_version then raise exception '订单版本已变化，请重新读取后确认';end if;
 if not ((v_order.status='draft' and p_status in ('opened','cancelled')) or (v_order.status='opened' and p_status in ('in_service','awaiting_payment','cancelled')) or (v_order.status='in_service' and p_status in ('awaiting_payment','cancelled'))) then raise exception '订单状态流转无效';end if;if p_status<>'cancelled' and not exists(select 1 from public.salon_order_lines where organization_id=p_organization_id and order_id=p_order_id) then raise exception '空订单不能进入业务流程';end if;if p_status='cancelled' and nullif(btrim(p_reason),'') is null then raise exception '取消订单必须填写原因';end if;
 update public.salon_orders set status=p_status,opened_at=case when p_status='opened' then now() else opened_at end,updated_at=now() where organization_id=p_organization_id and id=p_order_id;insert into public.salon_audit_events(organization_id,store_id,actor_staff_id,entity_type,entity_id,action,before_json,after_json,reason) values(p_organization_id,p_store_id,p_actor_staff_id,'order',p_order_id::text,'status_change',jsonb_build_object('status',v_order.status),jsonb_build_object('status',p_status),btrim(coalesce(p_reason,'')));v_response:=jsonb_build_object('orderId',p_order_id,'status',p_status);update public.salon_operation_requests set response_json=v_response,completed_at=now() where id=v_request.id;return v_response;
end $$;

revoke execute on function public.salon_set_order_status_versioned(bigint,bigint,bigint,bigint,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.salon_set_order_status_versioned(bigint,bigint,bigint,bigint,text,text,text,integer) to service_role;

-- Independent development only. A receipt lookup never replays a mutation.
set statement_timeout='30s';
set lock_timeout='5s';

create or replace function public.salon_lookup_staff_request(
 p_actor_staff_id bigint,p_organization_id bigint,p_store_id bigint,
 p_lookup_key text,p_target_operation text
) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_resource text;v_id_field text;v_result jsonb;v_unknown jsonb;
begin
 if p_lookup_key is null or p_lookup_key !~ '^[A-Za-z0-9._:-]{16,120}$' then
  raise exception '请求核对编号无效';
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
