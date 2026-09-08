-- Local-only optimistic concurrency for order line replacement.
set statement_timeout='30s';
set lock_timeout='5s';
alter table public.salon_orders add column edit_version integer not null default 0 check(edit_version>=0);
create function salon_private.bump_order_edit_version() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 new.edit_version:=old.edit_version+1;
 return new;
end$$;
create trigger salon_order_edit_version before update on public.salon_orders for each row execute function salon_private.bump_order_edit_version();
revoke execute on function salon_private.bump_order_edit_version() from public,anon,authenticated;
grant execute on function salon_private.bump_order_edit_version() to service_role;

-- Line changes, including legacy internal writers, invalidate the parent snapshot.
create function salon_private.touch_order_line_version() returns trigger language plpgsql security invoker set search_path='' as $$
declare v_old jsonb;v_new jsonb;v_scope record;
begin
 if tg_op<>'INSERT' then v_old:=to_jsonb(old);end if;
 if tg_op<>'DELETE' then v_new:=to_jsonb(new);end if;
 for v_scope in
  select distinct (j->>'organization_id')::bigint as org,(j->>'order_id')::bigint as id
  from (values(v_old),(v_new)) as parents(j) where j is not null order by org,id
 loop
  update public.salon_orders set edit_version=edit_version where organization_id=v_scope.org and id=v_scope.id;
 end loop;
 return null;
end$$;
create trigger salon_order_line_edit_version after insert or update or delete on public.salon_order_lines for each row execute function salon_private.touch_order_line_version();
revoke execute on function salon_private.touch_order_line_version() from public,anon,authenticated;
grant execute on function salon_private.touch_order_line_version() to service_role;

create function public.salon_replace_order_lines_versioned(p_actor_staff_id bigint,p_organization_id bigint,p_store_id bigint,p_order_id bigint,p_request_key text,p_lines jsonb,p_discount_reason text,p_expected_version integer)
returns jsonb language plpgsql security invoker set search_path='' as $$ declare v_request public.salon_operation_requests;v_order public.salon_orders;v_line jsonb;v_item public.salon_catalog_items;v_qty numeric;v_price numeric;v_discount numeric;v_staff bigint;v_subtotal numeric:=0;v_discount_total numeric:=0;v_payable numeric:=0;v_response jsonb;begin
 perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','write');v_request:=salon_private.claim_staff_request(p_organization_id,p_store_id,p_request_key,'order_lines','order_lines_payload',hashtextextended(jsonb_build_object('order',p_order_id,'lines',p_lines,'reason',btrim(coalesce(p_discount_reason,'')))::text,0),p_actor_staff_id,jsonb_build_object('p_actor_staff_id',p_actor_staff_id,'p_organization_id',p_organization_id,'p_store_id',p_store_id,'p_order_id',p_order_id,'p_lines',p_lines,'p_discount_reason',p_discount_reason,'p_expected_version',p_expected_version),'orders','write');if v_request.completed_at is not null then return v_request.response_json;end if;
 select * into v_order from public.salon_orders where organization_id=p_organization_id and store_id=p_store_id and id=p_order_id for update;if not found then raise exception '订单不存在或不属于当前门店';end if;if v_order.status<>'draft' then raise exception '只有草稿订单可以修改明细';end if;if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 or jsonb_array_length(p_lines)>100 then raise exception '订单明细必须为1至100项';end if;
 if p_expected_version is null or p_expected_version<0 or v_order.edit_version<>p_expected_version then raise exception '订单版本已变化，请先查询原单，不要覆盖其他修改';end if;
 if jsonb_typeof(p_lines) is distinct from 'array' then raise exception '订单明细必须为1至100项';end if;
 delete from public.salon_order_lines where organization_id=p_organization_id and order_id=p_order_id;
 for v_line in select value from jsonb_array_elements(p_lines) loop
  select i.* into v_item from public.salon_catalog_items i join public.salon_catalog_store_settings s on s.organization_id=i.organization_id and s.catalog_item_id=i.id where i.organization_id=p_organization_id and i.id=nullif(v_line->>'catalogItemId','')::bigint and i.status='active' and s.store_id=p_store_id and s.status='active';if not found then raise exception '订单项目商品不存在或当前门店未启用';end if;
  v_qty:=round(coalesce(nullif(v_line->>'quantity','')::numeric,0),3);v_price:=round(coalesce(nullif(v_line->>'unitPrice','')::numeric,v_item.list_price),2);v_discount:=round(coalesce(nullif(v_line->>'discountAmount','')::numeric,0),2);v_staff:=nullif(v_line->>'staffId','')::bigint;
  if v_qty<=0 or v_price<0 or v_discount<0 or v_discount>v_qty*v_price then raise exception '订单明细数量、单价或优惠无效';end if;if v_staff is not null and not exists(select 1 from public.salon_staff s where s.organization_id=p_organization_id and s.store_id=p_store_id and s.id=v_staff and s.employment_status='active') then raise exception '服务员工不是当前门店在职员工';end if;
  v_subtotal:=v_subtotal+v_qty*v_price;v_discount_total:=v_discount_total+v_discount;v_payable:=v_payable+v_qty*v_price-v_discount;
  insert into public.salon_order_lines(organization_id,order_id,catalog_item_id,staff_id,quantity,unit_price,line_total,item_code,item_name,item_type,discount_amount) values(p_organization_id,p_order_id,v_item.id,v_staff,v_qty,v_price,round(v_qty*v_price-v_discount,2),v_item.code,v_item.name,v_item.item_type,v_discount);
 end loop;
 if v_discount_total>0 then perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','discount');if nullif(btrim(p_discount_reason),'') is null then raise exception '优惠订单必须填写原因';end if;end if;
 update public.salon_orders set subtotal=round(v_subtotal,2),discount_total=round(v_discount_total,2),payable_total=round(v_payable,2),discount_reason=btrim(coalesce(p_discount_reason,'')),updated_at=now() where organization_id=p_organization_id and id=p_order_id;
 insert into public.salon_audit_events(organization_id,store_id,actor_staff_id,entity_type,entity_id,action,after_json,reason) values(p_organization_id,p_store_id,p_actor_staff_id,'order',p_order_id::text,'replace_lines',jsonb_build_object('lineCount',jsonb_array_length(p_lines),'subtotal',round(v_subtotal,2),'discount',round(v_discount_total,2),'payable',round(v_payable,2),'requestKey',p_request_key),btrim(coalesce(p_discount_reason,'')));
 v_response:=jsonb_build_object('orderId',p_order_id,'lineCount',jsonb_array_length(p_lines),'subtotal',round(v_subtotal,2),'discountTotal',round(v_discount_total,2),'payableTotal',round(v_payable,2));update public.salon_operation_requests set response_json=v_response,completed_at=now() where id=v_request.id;return v_response;
end $$;
revoke execute on function public.salon_replace_order_lines_versioned(bigint,bigint,bigint,bigint,text,jsonb,text,integer) from public,anon,authenticated;
grant execute on function public.salon_replace_order_lines_versioned(bigint,bigint,bigint,bigint,text,jsonb,text,integer) to service_role;
