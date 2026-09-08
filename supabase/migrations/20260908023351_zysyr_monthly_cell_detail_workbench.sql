-- ZYSYR amount detail workbench.
-- Voucher requirements are controlled per individual income/expense/business
-- record. Turning one record off never changes another record, a whole monthly
-- cell, or a future month. Originals and audit history remain append-only.

set statement_timeout = '30s';
set lock_timeout = '5s';

create table public.zysyr_business_evidence_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.zysyr_companies(id) on delete restrict,
  store_id uuid not null,
  business_type text not null check (
    business_type in (
      'income_record', 'expense_record', 'petty_cash_record', 'salary',
      'goods_receipt', 'usage_record', 'employee_purchase', 'daily_sheet'
    ) or business_type ~ '^history_[a-z_]{1,50}$'
  ),
  business_id uuid not null,
  evidence_policy text not null check (evidence_policy in ('voucher_required', 'none')),
  reason text not null check (nullif(btrim(reason), '') is not null),
  updated_by_user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  unique (company_id, store_id, business_type, business_id),
  foreign key (company_id, store_id)
    references public.zysyr_stores(company_id, id) on delete restrict,
  foreign key (company_id, updated_by_user_id)
    references public.zysyr_user_accounts(company_id, id) on delete restrict
);

create index zysyr_business_evidence_rules_scope_idx
  on public.zysyr_business_evidence_rules
  (company_id, store_id, business_type, business_id);

create or replace function public.zysyr_save_business_evidence_rule(
  p_actor_user_id uuid,
  p_company_id uuid,
  p_store_id uuid,
  p_business_type text,
  p_business_id uuid,
  p_evidence_required boolean,
  p_reason text
)
returns public.zysyr_business_evidence_rules
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.zysyr_business_evidence_rules;
  v_saved public.zysyr_business_evidence_rules;
  v_exists boolean := false;
  v_history_type text;
begin
  perform zysyr_private.assert_finance_scope(
    p_actor_user_id, p_company_id, p_store_id, 'confirmed_finance.adjust'
  );
  if p_business_id is null
     or nullif(btrim(p_business_type), '') is null
     or nullif(btrim(p_reason), '') is null then
    raise exception using errcode = '22023', message = 'BUSINESS_EVIDENCE_RULE_INVALID';
  end if;

  if p_business_type in (
    'income_record', 'expense_record', 'petty_cash_record', 'salary',
    'goods_receipt', 'usage_record', 'employee_purchase'
  ) then
    v_exists := zysyr_private.business_record_exists(
      p_company_id, p_store_id, p_business_type, p_business_id
    );
  elsif p_business_type = 'daily_sheet' then
    select exists (
      select 1 from public.zysyr_daily_sheet_drafts record
      where record.company_id = p_company_id
        and record.store_id = p_store_id
        and record.id = p_business_id
    ) into v_exists;
  elsif p_business_type ~ '^history_[a-z_]{1,50}$' then
    v_history_type := substring(p_business_type from 9);
    select exists (
      select 1 from public.zysyr_history_ledger_entries record
      where record.company_id = p_company_id
        and record.store_id = p_store_id
        and record.id = p_business_id
        and record.entry_type = v_history_type
        and record.status = 'posted'
    ) into v_exists;
  end if;
  if not v_exists then
    raise exception using errcode = 'P0002', message = 'BUSINESS_EVIDENCE_RECORD_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_company_id::text || ':' || p_store_id::text || ':' ||
    p_business_type || ':' || p_business_id::text, 0
  ));
  select * into v_before
  from public.zysyr_business_evidence_rules rule_row
  where rule_row.company_id = p_company_id
    and rule_row.store_id = p_store_id
    and rule_row.business_type = p_business_type
    and rule_row.business_id = p_business_id
  for update;

  insert into public.zysyr_business_evidence_rules (
    company_id, store_id, business_type, business_id, evidence_policy,
    reason, updated_by_user_id
  ) values (
    p_company_id, p_store_id, p_business_type, p_business_id,
    case when p_evidence_required then 'voucher_required' else 'none' end,
    btrim(p_reason), p_actor_user_id
  )
  on conflict (company_id, store_id, business_type, business_id)
  do update set
    evidence_policy = excluded.evidence_policy,
    reason = excluded.reason,
    updated_by_user_id = excluded.updated_by_user_id,
    updated_at = clock_timestamp()
  returning * into v_saved;

  insert into public.zysyr_audit_events (
    company_id, store_id, actor_type, actor_user_id, channel,
    entity_type, entity_id, action, before_json, after_json, reason, sensitivity
  ) values (
    p_company_id, p_store_id, 'user', p_actor_user_id, 'api',
    p_business_type, p_business_id, 'save_evidence_requirement',
    case when v_before.id is null then null else to_jsonb(v_before) end,
    to_jsonb(v_saved), btrim(p_reason), 'financial'
  );
  return v_saved;
end
$$;

-- Historical monthly inputs need a constrained amount-only correction path.
-- The client cannot replace the whole JSON payload or bypass period locks.
create or replace function public.zysyr_revise_history_monthly_cell(
  p_actor_user_id uuid,
  p_company_id uuid,
  p_store_id uuid,
  p_ledger_entry_id uuid,
  p_after_amount numeric,
  p_reason text
)
returns public.zysyr_history_ledger_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.zysyr_history_ledger_entries;
  v_after public.zysyr_history_ledger_entries;
  v_payload jsonb;
  v_unlock public.zysyr_monthly_cell_unlock_requests;
  v_cell_kind text;
  v_label text;
begin
  perform zysyr_private.assert_finance_scope(
    p_actor_user_id, p_company_id, p_store_id, 'confirmed_finance.adjust'
  );
  if p_after_amount is null
     or abs(p_after_amount) > 99999999999999.9999
     or nullif(btrim(p_reason), '') is null then
    raise exception using errcode = '22023', message = 'HISTORY_MONTHLY_CELL_CHANGE_INVALID';
  end if;

  select * into v_before
  from public.zysyr_history_ledger_entries entry
  where entry.company_id = p_company_id
    and entry.store_id = p_store_id
    and entry.id = p_ledger_entry_id
    and entry.entry_type = 'monthly_profit_loss'
    and entry.status = 'posted'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'HISTORY_MONTHLY_CELL_NOT_EDITABLE';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_company_id::text || ':' || p_store_id::text || ':' || v_before.period_month::text, 0
  ));
  v_cell_kind := coalesce(v_before.current_payload->>'cell_kind', '');
  v_label := coalesce(v_before.current_payload->>'label', '');
  if v_cell_kind = 'formula' or v_label ~ '(小计|合计|总计|盈亏|编号|序号|员工号)' then
    raise exception using errcode = '55000', message = 'HISTORY_MONTHLY_CELL_EDIT_FORBIDDEN';
  end if;
  if coalesce(v_before.current_payload->>'amount', '') !~ '^-?[0-9]+([.][0-9]+)?$' then
    raise exception using errcode = '55000', message = 'HISTORY_MONTHLY_CELL_AMOUNT_MISSING';
  end if;
  if round((v_before.current_payload->>'amount')::numeric, 4) = round(p_after_amount, 4) then
    raise exception using errcode = '22023', message = 'HISTORY_MONTHLY_CELL_AMOUNT_UNCHANGED';
  end if;

  if zysyr_private.period_is_locked(p_company_id, p_store_id, v_before.period_month) then
    select * into v_unlock
    from public.zysyr_monthly_cell_unlock_requests request
    where request.company_id = p_company_id
      and request.store_id = p_store_id
      and request.period_month = v_before.period_month
      and request.requested_by_user_id = p_actor_user_id
      and request.status = 'approved'
    order by request.decided_at asc
    limit 1 for update;
    if not found then
      raise exception using errcode = '55000', message = 'MONTHLY_UNLOCK_APPROVAL_REQUIRED';
    end if;
  end if;

  v_payload := jsonb_set(
    v_before.current_payload, '{amount}', to_jsonb(round(p_after_amount, 4)), true
  );
  insert into public.zysyr_history_ledger_revisions (
    company_id, store_id, ledger_entry_id, import_batch_id, import_row_id,
    version, action, before_payload, after_payload, reason, actor_user_id
  ) values (
    p_company_id, p_store_id, v_before.id, v_before.import_batch_id,
    v_before.import_row_id, v_before.version + 1, 'revise_monthly_amount',
    v_before.current_payload, v_payload, btrim(p_reason), p_actor_user_id
  );
  update public.zysyr_history_ledger_entries set
    current_payload = v_payload, version = v_before.version + 1,
    last_modified_by_user_id = p_actor_user_id, last_modified_at = clock_timestamp()
  where company_id = p_company_id and id = v_before.id
  returning * into v_after;

  insert into public.zysyr_history_import_events (
    company_id, store_id, import_batch_id, import_row_id, action,
    before_json, after_json, reason, actor_user_id
  ) values (
    p_company_id, p_store_id, v_before.import_batch_id, v_before.import_row_id,
    'ledger_revise_monthly_amount', v_before.current_payload, v_after.current_payload,
    btrim(p_reason), p_actor_user_id
  );
  insert into public.zysyr_audit_events (
    company_id, store_id, actor_type, actor_user_id, channel, entity_type,
    entity_id, action, before_json, after_json, reason, sensitivity
  ) values (
    p_company_id, p_store_id, 'user', p_actor_user_id, 'api',
    'history_monthly_cell', v_after.id, 'amount_change',
    jsonb_build_object('amount', v_before.current_payload->'amount',
      'period_month', v_before.period_month,
      'cell_address', v_before.current_payload->>'cell_address'),
    jsonb_build_object('amount', v_after.current_payload->'amount',
      'period_month', v_after.period_month,
      'cell_address', v_after.current_payload->>'cell_address',
      'version', v_after.version, 'unlock_request_id', v_unlock.id),
    btrim(p_reason), 'financial'
  );
  if v_unlock.id is not null then
    update public.zysyr_monthly_cell_unlock_requests
    set status = 'consumed', consumed_at = clock_timestamp()
    where company_id = p_company_id and id = v_unlock.id;
  end if;
  return v_after;
end
$$;

revoke all on table public.zysyr_business_evidence_rules
from public, anon, authenticated, service_role;
grant select, insert, update on table public.zysyr_business_evidence_rules to service_role;

revoke execute on function public.zysyr_save_business_evidence_rule(
  uuid, uuid, uuid, text, uuid, boolean, text
) from public, anon, authenticated;
revoke execute on function public.zysyr_revise_history_monthly_cell(
  uuid, uuid, uuid, uuid, numeric, text
) from public, anon, authenticated;
grant execute on function public.zysyr_save_business_evidence_rule(
  uuid, uuid, uuid, text, uuid, boolean, text
) to service_role;
grant execute on function public.zysyr_revise_history_monthly_cell(
  uuid, uuid, uuid, uuid, numeric, text
) to service_role;

alter table public.zysyr_business_evidence_rules enable row level security;
alter table public.zysyr_business_evidence_rules force row level security;

create policy zysyr_business_evidence_rules_scope_select
on public.zysyr_business_evidence_rules for select to authenticated
using ((select zysyr_private.has_capability(company_id, store_id, 'dashboard.store.read')));

grant select on table public.zysyr_business_evidence_rules to authenticated;

comment on table public.zysyr_business_evidence_rules is
  'Audited per-business-record voucher requirement. Setting none suppresses only that record requirement and never deletes evidence or lineage.';
