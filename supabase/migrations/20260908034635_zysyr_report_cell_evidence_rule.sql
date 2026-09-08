-- Treat a non-formula monthly report cell as one independently managed record
-- when no lower-level business rows exist. This does not change the amount or
-- discard evidence; it only stores that one cell's evidence requirement.

set statement_timeout = '30s';
set lock_timeout = '5s';

alter table public.zysyr_business_evidence_rules
  drop constraint if exists zysyr_business_evidence_rules_business_type_check;

alter table public.zysyr_business_evidence_rules
  add constraint zysyr_business_evidence_rules_business_type_check check (
    business_type in (
      'income_record', 'expense_record', 'petty_cash_record', 'salary',
      'goods_receipt', 'usage_record', 'employee_purchase', 'daily_sheet',
      'report_cell'
    ) or business_type ~ '^history_[a-z_]{1,50}$'
  );

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
  elsif p_business_type = 'report_cell' then
    select exists (
      select 1
      from public.zysyr_report_cells cell
      join public.zysyr_report_uploads report
        on report.company_id = cell.company_id
       and report.id = cell.report_id
      where cell.company_id = p_company_id
        and cell.store_id = p_store_id
        and cell.id = p_business_id
        and coalesce(cell.cell_kind, '') <> 'formula'
        and report.store_id = p_store_id
        and report.report_type = 'monthly_profit_loss'
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

revoke execute on function public.zysyr_save_business_evidence_rule(
  uuid, uuid, uuid, text, uuid, boolean, text
) from public, anon, authenticated;
grant execute on function public.zysyr_save_business_evidence_rule(
  uuid, uuid, uuid, text, uuid, boolean, text
) to service_role;

comment on function public.zysyr_save_business_evidence_rule(
  uuid, uuid, uuid, text, uuid, boolean, text
) is 'Save one business-record evidence requirement, including direct non-formula monthly report cells, with finance scope and append-only audit.';
