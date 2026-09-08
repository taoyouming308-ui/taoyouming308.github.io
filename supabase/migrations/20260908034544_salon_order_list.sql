-- Independent Salon branch only. Read-only keyset list; no customer or payment fields.
create index salon_orders_store_id_idx on public.salon_orders(organization_id,store_id,id desc);
create index salon_orders_store_status_id_idx on public.salon_orders(organization_id,store_id,status,id desc);

create function public.salon_list_orders(p_actor_staff_id bigint,p_organization_id bigint,p_store_id bigint,p_status text default '',p_before_id bigint default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_rows jsonb;v_more boolean;
begin
  perform salon_private.assert_staff_permission(p_actor_staff_id,p_organization_id,p_store_id,'orders','read');
  if p_status is null or p_status not in ('','draft','opened','in_service','awaiting_payment','paid','cancelled','reversed') then raise exception '订单状态筛选无效';end if;
  if p_before_id is not null and (p_before_id<=0 or p_before_id>9007199254740991) then raise exception '订单分页游标无效';end if;
  with candidates as (
    select o.id,o.order_no,o.status,o.created_at from public.salon_orders o
    where o.organization_id=p_organization_id and o.store_id=p_store_id
      and (p_status='' or o.status=p_status) and (p_before_id is null or o.id<p_before_id)
    order by o.id desc limit 51
  ), page as (select * from candidates order by id desc limit 50)
  select coalesce((select jsonb_agg(to_jsonb(p) order by p.id desc) from page p),'[]'::jsonb),
    (select count(*)>50 from candidates) into v_rows,v_more;
  return jsonb_build_object('organizationId',p_organization_id,'storeId',p_store_id,'rows',v_rows,
    'nextBeforeId',case when v_more then (v_rows->49->>'id')::bigint else null end);
end $$;
revoke execute on function public.salon_list_orders(bigint,bigint,bigint,text,bigint) from public,anon,authenticated;
grant execute on function public.salon_list_orders(bigint,bigint,bigint,text,bigint) to service_role;
