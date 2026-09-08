#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'operations.html'), 'utf8');
const api = fs.readFileSync(path.join(root, 'supabase/functions/operations-api/index.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260905073551_zysyr_monthly_evidence_workbench.sql'), 'utf8');
const detailMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20260908023351_zysyr_monthly_cell_detail_workbench.sql'), 'utf8');
const directEvidence = fs.readFileSync(path.join(root, 'supabase/migrations/20260906122116_zysyr_history_monthly_direct_evidence.sql'), 'utf8');
const releaseVersion = fs.readFileSync(path.join(root, 'version.txt'), 'utf8').trim();
function expect(value, message) { if (!value) throw new Error(message); }

for (const marker of [
  '上传原表 / 凭证', 'monthly-material-form', '金额处理',
  '上传这个数字的凭证', '修改这个金额', 'monthly-inline-amount', '上传凭证图片 / PDF',
  '逐笔收入 / 开支与凭证', '此笔不需要凭证（只影响这一笔）', 'business_evidence_rule_save',
  'report-focus', 'minReadable=phone ? .68 : .7',
]) expect(page.includes(marker), `monthly workbench UI missing: ${marker}`);

expect(page.includes("record_type:'report',record_id:report.id,monthly_cell_id:target.id")
  && api.includes('p_source_cell_id: monthlyCellId'), 'voucher upload must bind to the selected monthly cell');
expect(page.includes("report_type:type,report_date:date,month:$('month').value")
  && page.includes('日报日期必须属于当前月份'), 'monthly materials must remain scoped to the active store and month');
expect(page.includes("cell.onclick=function(){openMonthlyVoucher(cell.dataset.traceCell)}")
  && page.includes("typeof value==='number'"), 'only numeric report amounts should open the monthly workbench');
expect(page.includes("state.user.role!=='finance'||!data.can_upload_vouchers")
  && !page.includes("state.user.role!=='finance'||!data.can_upload_vouchers||data.evidence_policy==='none'"),
  'finance must still be able to upload an optional voucher after one detail is waived');
expect(page.includes("api('history_monthly_cell_save'") && api.includes('async function historyMonthlyCellSave(')
  && api.includes('rpc/zysyr_revise_history_monthly_cell'),
  'historical monthly input must use the amount-only revision path from the detail page');
expect(page.includes("api('history_ledger_evidence_upload'")
  && api.includes('async function historyLedgerEvidenceUpload(')
  && api.includes('rpc/zysyr_attach_history_ledger_evidence'),
  'historical monthly amounts must accept direct evidence uploads');
expect(directEvidence.includes('create or replace function public.zysyr_attach_history_ledger_evidence')
  && directEvidence.includes("entry.status = 'posted'")
  && directEvidence.includes("entry.entry_type = 'monthly_profit_loss'")
  && directEvidence.includes("'page_confirmed'")
  && directEvidence.includes("'evidence_upload'")
  && directEvidence.includes("'evidence_link'"),
  'historical evidence must append an exact link and audit events without rewriting posted amounts');
expect(/revoke execute on function public\.zysyr_attach_history_ledger_evidence[\s\S]*?from public, anon, authenticated/.test(directEvidence)
  && /grant execute on function public\.zysyr_attach_history_ledger_evidence[\s\S]*?to service_role/.test(directEvidence),
  'historical evidence RPC must remain server-only');
expect(api.includes('entry_type=eq.monthly_profit_loss'),
  'direct historical evidence upload must only target posted monthly report entries');

for (const policy of ['voucher_required', 'source_report', 'none']) {
  expect(api.includes(`"${policy}"`) && migration.includes(`'${policy}'`), `evidence policy missing: ${policy}`);
}
expect(api.includes('defaultMonthlyEvidencePolicy') && api.includes('monthlyEvidencePolicyMap')
  && api.includes('monthly_evidence_rule_save'), 'monthly evidence policy API flow missing');
expect(api.includes('uploadedVoucherCount > 0 ? "matched"'),
  'newly uploaded cell voucher must immediately mark the amount as matched');
expect(api.includes('missingRequiredDetails.length')
  && api.includes('evidencePolicy === "source_report" && !sources.length'),
  'per-record voucher requirements and source-report anomalies must be evaluated separately');

expect(migration.includes('create table public.zysyr_monthly_evidence_rules')
  && migration.includes('unique (company_id, store_id, template_code, cell_address)'),
  'evidence rules must be isolated by company, store, template and cell');
expect(migration.includes("account_has_company_capability(")
  && migration.includes("'finance_account.create'"), 'only company administrators may change evidence rules');
expect(migration.includes("'monthly_evidence_rule'") && migration.includes("'save_evidence_policy'")
  && migration.includes("'financial'"), 'evidence policy changes must write permanent financial audit events');
expect(migration.includes('enable row level security') && migration.includes('force row level security')
  && migration.includes('dashboard.store.read'), 'evidence rules must enforce store-scoped RLS');
expect(/revoke execute on function public\.zysyr_save_monthly_evidence_rule[\s\S]*?from public, anon, authenticated/.test(migration)
  && /grant execute on function public\.zysyr_save_monthly_evidence_rule[\s\S]*?to service_role/.test(migration),
  'evidence rule RPC must not be browser-executable');

expect(detailMigration.includes('create table public.zysyr_business_evidence_rules')
  && detailMigration.includes('unique (company_id, store_id, business_type, business_id)'),
  'single-record evidence rules must be isolated by company, store, type and record');
expect(detailMigration.includes("'confirmed_finance.adjust'")
  && detailMigration.includes("'save_evidence_requirement'")
  && detailMigration.includes("'financial'"),
  'finance single-record changes must be capability-checked and permanently audited');
expect(detailMigration.includes('zysyr_private.business_record_exists')
  && detailMigration.includes("business_type ~ '^history_[a-z_]{1,50}$'"),
  'single-record evidence changes must verify current and historical targets server-side');
expect(detailMigration.includes('enable row level security') && detailMigration.includes('force row level security')
  && detailMigration.includes('dashboard.store.read'), 'single-record rules must enforce store-scoped RLS');
expect(/revoke execute on function public\.zysyr_save_business_evidence_rule[\s\S]*?from public, anon, authenticated/.test(detailMigration)
  && /grant execute on function public\.zysyr_save_business_evidence_rule[\s\S]*?to service_role/.test(detailMigration),
  'single-record evidence RPC must remain server-only');
expect(detailMigration.includes("v_cell_kind = 'formula'")
  && detailMigration.includes('MONTHLY_UNLOCK_APPROVAL_REQUIRED')
  && detailMigration.includes("'{amount}'"),
  'historical amount correction must reject formulas, respect locks and only replace amount');

const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
expect(scripts.length === 1, 'inline script missing');
new vm.Script(scripts[0][1], { filename: 'operations.html' });
expect(page.includes(`data-version="${releaseVersion}"`)
  && page.includes(`operations-auth-bridge.js?v=${releaseVersion}`)
  && page.includes(`operations-voucher-view.js?v=${releaseVersion}`), 'release cache markers missing');
console.log('ZYSYR_MONTHLY_WORKBENCH_V472_STATIC_OK');
