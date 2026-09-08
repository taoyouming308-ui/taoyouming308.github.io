import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { parseMonth } from "../_shared/zysyr-date.mjs";
import { parseHistoricalWorkbook } from "../_shared/zysyr-history-import.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const WORKER_SECRET = Deno.env.get("ZYSYR_WORKER_SECRET") || "";
const SESSION_DAYS = 3650;
const VOUCHER_BUCKET = "zysyr-vouchers";
const MAX_VOUCHER_BYTES = 10 * 1024 * 1024;
const REPORT_BUCKET = "zysyr-reports";
const MAX_REPORT_BYTES = 10 * 1024 * 1024;

const STYLIST_COLUMNS = [
  ["dianping_group", "点评团"], ["douyin", "抖音"], ["wash_cut_blow", "洗剪吹"],
  ["makeup_styling", "彩妆/造型"], ["perm", "烫发"], ["color", "染发"],
  ["treatment", "护理"], ["technical_care", "技护"], ["scalp_care", "头皮护理"],
  ["beirou_care", "倍柔护理"], ["extensions", "接发"], ["retail", "美发零售"],
  ["essence_products", "精华产品"], ["wig_custom", "假发定制/发片"],
  ["beauty_aids", "美发辅助品"], ["makeup_jewelry", "彩妆+首饰"],
  ["home_fragrance", "家居品和香氛"],
] as const;
const TECHNICIAN_COLUMNS = [
  ["extensions", "接发"], ["styling", "造型"], ["base_perm", "基础烫发"],
  ["technical_perm", "技术烫发"], ["base_color", "基础染发"],
  ["technical_color", "技术染发"], ["base_treatment", "基础护理"],
  ["treatment", "护理"], ["technical_care", "技护"], ["scalp_care", "头皮护理"],
  ["beirou_care", "倍柔护理"], ["zhenhei_care", "臻黑护理"], ["retail", "美发零售"],
  ["essence_products", "精华产品"], ["wig_custom", "假发订制/发片"],
  ["beauty_aids", "美发辅助品"], ["makeup_jewelry", "彩妆+首饰"],
  ["home_fragrance", "家居品和香氛"],
] as const;
const SUMMARY_COLUMNS = [
  ["stylist_total", "发型师栏"], ["technician_total", "技师栏"], ["nail_total", "美甲师栏"],
  ["frontdesk_total", "前台栏"], ["actual_total", "实做"], ["treatment_card", "疗程卡"],
  ["qualification_card", "资格卡"], ["membership_card", "会籍卡"],
  ["card_subtotal", "卡类小计"], ["grand_total", "总计"],
] as const;
const PAYMENT_COLUMNS = [
  ["cash", "现金"], ["public_card", "公-刷卡"], ["public_qr", "公-支微"],
  ["private_card", "私-刷卡"], ["private_qr", "私-支微"], ["alipay", "支付宝"],
  ["wechat", "微信"], ["douyin", "抖音"], ["group_buy", "团购"],
  ["cash_flow", "现金流"], ["card_consumption", "卡金消费"], ["total", "总计"],
] as const;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
};

type JsonRecord = Record<string, unknown>;

function cleanText(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function uuidIn(values: unknown[]): string {
  const ids = Array.from(new Set(values.map((value) => cleanText(value, 40)).filter((value) => /^[0-9a-f-]{36}$/i.test(value))));
  return `(${ids.join(",")})`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: cors });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function effectiveCellValue(cell: JsonRecord): number | null {
  const raw = cell.manual_override ? cell.corrected_numeric : null;
  if (raw == null || raw === "") return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric * 100) / 100 : null;
}

function safeCellText(value: unknown, max = 120): string {
  return cleanText(value, max).replace(/[|\r\n]/g, " ");
}

function normalizedName(value: unknown): string {
  return cleanText(value, 80).replace(/[\s·•._-]+/g, "").toLowerCase();
}

type DailyCellSeed = {
  section_code: string; row_key: string; row_label: string; column_code: string; column_label: string;
  row_number: number; column_number: number; cell_role: string; ocr_text: string | null;
  ocr_numeric: number | null; confidence: number | null; bbox: unknown; source_method: string;
};

function dailySheetSeeds(extraction: JsonRecord, storeName = ""): DailyCellSeed[] {
  const parsed = extraction.parsed && typeof extraction.parsed === "object" ? extraction.parsed as JsonRecord : {};
  const detected = Array.isArray(parsed.cells) ? parsed.cells as JsonRecord[] : [];
  const sectionRows = (section: string, fallbackCount: number) => {
    const names: string[] = [];
    detected.filter((cell) => cleanText(cell.section_code, 30) === section)
      .map((cell) => safeCellText(cell.row_label, 80)).filter((name) => name && name !== "小计")
      .forEach((name) => { if (!names.some((item) => normalizedName(item) === normalizedName(name))) names.push(name); });
    while (names.length < fallbackCount) names.push(`第${names.length + 1}行`);
    return names.slice(0, fallbackCount);
  };
  const xiangli = /向里/.test(storeName);
  const stylistNames = sectionRows("stylist", 8), technicianNames = sectionRows("technician", xiangli ? 6 : 7);
  const productNames = sectionRows("product", 4);
  const technicianTotalRow = xiangli ? 21 : 22;
  const productStartRow = xiangli ? 23 : 24;
  const seeds: DailyCellSeed[] = [];
  const add = (section: string, rowKey: string, rowLabel: string, columnCode: string, columnLabel: string,
    rowNumber: number, columnNumber: number, role: string) => {
    seeds.push({ section_code: section, row_key: rowKey, row_label: rowLabel, column_code: columnCode,
      column_label: columnLabel, row_number: rowNumber, column_number: columnNumber, cell_role: role,
      ocr_text: null, ocr_numeric: null, confidence: null,
      bbox: undefined, source_method: "blank_template" });
  };
  stylistNames.forEach((name, rowIndex) => {
    STYLIST_COLUMNS.forEach((column, columnIndex) => add("stylist", `stylist_${rowIndex + 1}`, name,
      column[0], column[1], 3 + rowIndex, 2 + columnIndex + (columnIndex > 13 ? 1 : 0), "staff_value"));
    add("stylist", `stylist_${rowIndex + 1}`, name, "subtotal", "小计", 3 + rowIndex, 20, "staff_total");
    [["old_count", "老"], ["new_count", "新"], ["card_count", "卡类"], ["treatment_card_count", "疗程卡"]].forEach((column, index) =>
      add("stylist", `stylist_${rowIndex + 1}`, name, column[0], column[1], 3 + rowIndex, 21 + index, "staff_count"));
  });
  STYLIST_COLUMNS.forEach((column, index) => add("stylist", "stylist_category_total", "小计",
    column[0], column[1], 12, 2 + index + (index > 13 ? 1 : 0), "category_total"));
  add("stylist", "stylist_category_total", "小计", "subtotal", "小计", 12, 20, "summary_value");
  technicianNames.forEach((name, rowIndex) => {
    TECHNICIAN_COLUMNS.forEach((column, columnIndex) => add("technician", `technician_${rowIndex + 1}`, name,
      column[0], column[1], 15 + rowIndex, 2 + columnIndex + (columnIndex > 14 ? 1 : 0), "technician_value"));
    add("technician", `technician_${rowIndex + 1}`, name, "subtotal", "小计", 15 + rowIndex, 21, "technician_total");
  });
  TECHNICIAN_COLUMNS.forEach((column, index) => add("technician", "technician_category_total", "小计",
    column[0], column[1], technicianTotalRow, 2 + index + (index > 14 ? 1 : 0), "technician_category_total"));
  add("technician", "technician_category_total", "小计", "subtotal", "小计", technicianTotalRow, 21, "technician_total");
  const productColumns = [["product_regular", "普通产品"], ["product_essence", "精华产品"],
    ["other_product", "其他产品"], ["retail_subtotal", "零售小计"], ["nail", "美甲"],
    ["product", "产品"], ["subtotal", "小计"]];
  productNames.forEach((name, rowIndex) => productColumns.forEach((column, columnIndex) =>
    add("product", `product_${rowIndex + 1}`, name, column[0], column[1], productStartRow + rowIndex,
      1 + columnIndex, column[0] === "retail_subtotal" || column[0] === "subtotal" ? "product_total" : "product_value")));
  SUMMARY_COLUMNS.forEach((column, index) => add("summary", "summary", "汇总", column[0], column[1], 30, 1 + index,
    column[0] === "actual_total" ? "summary_actual" : column[0] === "grand_total" ? "summary_grand" : "summary_value"));
  PAYMENT_COLUMNS.forEach((column, index) => add("payment", "payment", "支付", column[0], column[1], 33, 1 + index,
    column[0] === "cash_flow" ? "payment_cashflow" : column[0] === "card_consumption" ? "payment_card_consumption"
      : column[0] === "total" ? "payment_total" : "payment_method"));
  return seeds;
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function restRows(path: string): Promise<JsonRecord[]> {
  const response = await rest(path);
  if (!response.ok) throw new Error(`数据读取失败 (${response.status})`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

async function restRowsAll(path: string, maxRows = 10000): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  const pageSize = 1000;
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const response = await rest(path, { headers: { Range: `${offset}-${offset + pageSize - 1}` } });
    if (!response.ok) throw new Error(`数据读取失败 (${response.status})`);
    const page = await response.json();
    if (!Array.isArray(page)) break;
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
  throw new Error("当前日期范围记录超过 10000 条，请缩短日期范围后重试");
}

async function invokeVoucherOcrWorker(limit = 3): Promise<JsonRecord> {
  if (!WORKER_SECRET) throw new Error("OCR后台任务密钥未配置");
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(5, Math.trunc(limit))) : 3;
  const response = await fetch(`${SUPABASE_URL}/functions/v1/voucher-ocr-worker`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "x-worker-secret": WORKER_SECRET,
    },
    body: JSON.stringify({ limit: safeLimit }),
  });
  const data = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok) throw new Error(`OCR后台任务启动失败 (${response.status})`);
  return data;
}

function wakeVoucherOcrInBackground(limit = 3): void {
  if (!WORKER_SECRET) {
    console.error("voucher-ocr-worker wake skipped: ZYSYR_WORKER_SECRET missing");
    return;
  }
  EdgeRuntime.waitUntil(invokeVoucherOcrWorker(limit).catch((error) => {
    console.error("voucher-ocr-worker wake failed", (error as Error).message);
  }));
}

function scopeRole(scope: JsonRecord, code: string): JsonRecord | null {
  const roles = Array.isArray(scope.roles) ? scope.roles as JsonRecord[] : [];
  return roles.find((role) => cleanText(role.code, 80) === code
    && role.scope && typeof role.scope === "object") || null;
}

function scopeCapability(scope: JsonRecord, code: string, scopeType: string, storeId: string): boolean {
  const capabilities = Array.isArray(scope.capabilities) ? scope.capabilities as JsonRecord[] : [];
  return capabilities.some((capability) => cleanText(capability.code, 100) === code
    && Array.isArray(capability.scopes)
    && (capability.scopes as JsonRecord[]).some((item) => cleanText(item.type, 20) === scopeType
      && (scopeType === "company" || cleanText(item.store_id, 40) === storeId)));
}

async function authSession(request: Request): Promise<JsonRecord | null> {
  const authorization = cleanText(request.headers.get("authorization"), 9000);
  if (!/^Bearer\s+[^\s]+$/i.test(authorization)) return null;
  const response = await fetch(`${SUPABASE_URL}/functions/v1/operations-auth`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: authorization, "Content-Type": "application/json" },
  });
  if (!response.ok) throw new Error("Supabase Auth 登录已失效，请重新登录");
  const scope = await response.json() as JsonRecord;
  if (cleanText(scope.auth_boundary, 80) !== "supabase_auth_rls") throw new Error("Supabase Auth 权限范围无效");

  const shareholder = scopeRole(scope, "shareholder");
  const finance = scopeRole(scope, "finance");
  const storeManager = scopeRole(scope, "store_manager");
  const employee = scopeRole(scope, "employee");
  let operationsRole = "";
  let roleScope: JsonRecord = {};
  if (shareholder && cleanText((shareholder.scope as JsonRecord).type, 20) === "company") {
    operationsRole = "shareholder";
    roleScope = shareholder.scope as JsonRecord;
  } else if (finance) {
    operationsRole = "finance";
    roleScope = finance.scope as JsonRecord;
  } else if (storeManager) {
    operationsRole = "store_manager";
    roleScope = storeManager.scope as JsonRecord;
  } else if (employee) {
    operationsRole = "employee";
    roleScope = employee.scope as JsonRecord;
  }
  const scopeType = cleanText(roleScope.type, 20);
  const storeId = scopeType === "store" ? cleanText(roleScope.store_id, 40) : "";
  const authorized = operationsRole === "shareholder"
    ? scopeCapability(scope, "dashboard.group.read", "company", "")
    : operationsRole === "finance"
      ? scopeCapability(scope, "dashboard.store.read", scopeType, storeId)
        && scopeCapability(scope, "daily_report.write", scopeType, storeId)
      : operationsRole === "store_manager"
        ? scopeType === "store" && scopeCapability(scope, "dashboard.store.read", scopeType, storeId)
        : operationsRole === "employee"
          ? scopeType === "store" && scopeCapability(scope, "employee.self.read", scopeType, storeId)
            && /^[0-9a-f-]{36}$/i.test(cleanText((scope.user as JsonRecord)?.employee_id, 40))
          : false;
  if (!authorized || (scopeType !== "company" && scopeType !== "store")) {
    throw new Error("Supabase Auth 经营角色无权进入驾驶舱");
  }

  const rawStores = Array.isArray(scope.stores) ? scope.stores as JsonRecord[] : [];
  const scopedStores = rawStores.filter((store) => cleanText(store.status, 20) === "active"
    && (scopeType === "company" || cleanText(store.id, 40) === storeId));
  const user = scope.user && typeof scope.user === "object" ? scope.user as JsonRecord : {};
  const capabilities = Array.isArray(scope.capabilities) ? scope.capabilities as JsonRecord[] : [];
  const storeName = scopeType === "store"
    ? cleanText(scopedStores.find((store) => cleanText(store.id, 40) === storeId)?.name, 100)
    : "";
  if (scopeType === "store" && !storeName) throw new Error("Supabase Auth 门店范围无效");

  return {
    username: cleanText(user.login_name, 80) || cleanText(user.display_name, 120),
    role: `auth_${operationsRole}`,
    position: roleLabel(operationsRole),
    store: storeName,
    operations_role: operationsRole,
    auth_user_id: cleanText(user.auth_user_id, 40),
    auth_account_id: cleanText(user.id, 40),
    auth_employee_id: cleanText(user.employee_id, 40),
    auth_company_id: cleanText(user.company_id, 40),
    auth_scope_type: scopeType,
    auth_store_id: storeId,
    auth_stores: scopedStores.map((store) => cleanText(store.name, 100)).filter(Boolean),
    auth_store_records: scopedStores,
    auth_capabilities: capabilities.map((capability) => cleanText(capability.code, 100)).filter(Boolean),
  };
}

function operationsRole(staff: JsonRecord): string {
  const role = cleanText(staff.role, 40);
  const position = cleanText(staff.position, 120);
  if (role === "admin") return "shareholder";
  if (/财务/.test(position)) return "finance";
  if (role === "store_admin" || /店长/.test(position)) return "store_manager";
  return "employee";
}

function roleLabel(role: unknown): string {
  const labels: Record<string, string> = { shareholder: "股东", finance: "财务", store_manager: "店长", employee: "员工" };
  return labels[cleanText(role, 40)] || "员工";
}

function canWriteExpense(session: JsonRecord): boolean {
  return Boolean(cleanText(session.auth_account_id, 40))
    && Array.isArray(session.auth_capabilities)
    && (session.auth_capabilities as unknown[]).some((item) => cleanText(item, 100) === "expense.create_submit");
}

function canUploadReports(session: JsonRecord): boolean {
  return cleanText(session.operations_role, 40) === "finance"
    && Array.isArray(session.auth_capabilities)
    && (session.auth_capabilities as unknown[]).some((item) => cleanText(item, 100) === "report.upload");
}

function canUploadVouchers(session: JsonRecord): boolean {
  return cleanText(session.operations_role, 40) === "finance"
    && hasAuthCapability(session, "voucher.upload");
}

function canReviewVouchers(session: JsonRecord): boolean {
  return cleanText(session.operations_role, 40) === "finance"
    && hasAuthCapability(session, "voucher.review");
}

function hasAuthCapability(session: JsonRecord, capability: string): boolean {
  return Boolean(cleanText(session.auth_account_id, 40))
    && Array.isArray(session.auth_capabilities)
    && (session.auth_capabilities as unknown[]).some((item) => cleanText(item, 100) === capability);
}

async function availableStores(session: JsonRecord): Promise<string[]> {
  if (Array.isArray(session.auth_stores)) return (session.auth_stores as unknown[]).map((item) => cleanText(item, 100)).filter(Boolean);
  const assigned = cleanText(session.store, 100);
  if (cleanText(session.operations_role, 40) !== "shareholder") return assigned ? [assigned] : [];
  const rows = await restRows("zysyr_stores?select=name&status=eq.active&order=name.asc&limit=300");
  return rows.map((row) => cleanText(row.name, 100)).filter(Boolean);
}

async function sessionUser(session: JsonRecord): Promise<JsonRecord> {
  const role = cleanText(session.operations_role, 40);
  return {
    username: session.username,
    role,
    role_label: roleLabel(role),
    position: session.position || "",
    store: session.store || "",
    stores: await availableStores(session),
    can_write_expense: canWriteExpense(session),
    can_manage_finance_workbench: cleanText(session.operations_role, 40) === "finance"
      && hasAuthCapability(session, "expense.create_submit"),
    can_review_expenses: hasAuthCapability(session, "expense.approve"),
    can_confirm_payments: hasAuthCapability(session, "payment.confirm"),
    can_lock_reports: hasAuthCapability(session, "report.lock"),
    can_adjust_confirmed_finance: hasAuthCapability(session, "confirmed_finance.adjust"),
    can_read_salary: hasAuthCapability(session, "salary.read"),
    can_read_petty_cash_reports: hasAuthCapability(session, "dashboard.store.read"),
    can_manage_payroll: role === "finance" && hasAuthCapability(session, "salary.write_approve"),
    can_view_personal_payroll: role === "employee"
      && /^[0-9a-f-]{36}$/i.test(cleanText(session.auth_employee_id, 40)),
    can_upload_reports: canUploadReports(session),
    can_import_photo_reports: hasAuthCapability(session, "daily_report.write"),
    can_upload_vouchers: canUploadVouchers(session),
    can_review_vouchers: canReviewVouchers(session),
    can_manage_service_items: hasAuthCapability(session, "daily_report.write"),
    can_read_daily_reports: hasAuthCapability(session, "voucher.read") || hasAuthCapability(session, "daily_report.write"),
    can_manage_inventory_catalog: hasAuthCapability(session, "inventory.write"),
    can_manage_inventory: hasAuthCapability(session, "inventory.write"),
    can_read_ai_analysis: hasAuthCapability(session, "ai_insight.read"),
    can_create_question: hasAuthCapability(session, "question.create"),
    can_respond_question: hasAuthCapability(session, "question.respond"),
    can_manage_employees: hasAuthCapability(session, "employee.write"),
    can_manage_stores: hasAuthCapability(session, "org.store.write")
      && cleanText(session.auth_scope_type, 20) === "company",
    can_create_store: hasAuthCapability(session, "org.store.write")
      && cleanText(session.auth_scope_type, 20) === "company",
    can_manage_finance_accounts: Array.isArray(session.auth_capabilities)
      && (session.auth_capabilities as unknown[]).some((item) => cleanText(item, 100) === "finance_account.create")
      && cleanText(session.auth_scope_type, 20) === "company",
    can_manage_workforce_accounts: Array.isArray(session.auth_capabilities)
      && (session.auth_capabilities as unknown[]).some((item) => cleanText(item, 100) === "workforce_account.create")
      && cleanText(session.auth_scope_type, 20) === "company",
    personal_scope: role === "employee",
  };
}


async function shareholderRegister(payload: JsonRecord): Promise<JsonRecord> {
  const username = cleanText(payload.login_name, 80);
  const displayName = cleanText(payload.display_name, 80);
  const password = cleanText(payload.password, 200);
  const scopeType = cleanText(payload.scope_type, 20);
  const storeId = cleanText(payload.store_id, 40) || null;
  if (!/^[a-z0-9_一-龥-]{2,40}$/.test(username)) throw new Error("登录名需为2至40位字母、数字、下划线或中文");
  if (displayName.length < 2 || displayName.length > 80) throw new Error("请填写2至80个字的姓名或称呼");
  if (password.length < 10 || password.length > 72) throw new Error("密码需为10至72位");
  if (!["company", "store"].includes(scopeType)) throw new Error("请选择权限范围");
  if (scopeType === "store" && !storeId) throw new Error("请选择所属门店");
  let companyId = "";
  if (storeId) {
    const rows = await restRows(`zysyr_stores?select=company_id&id=eq.${encodeURIComponent(storeId)}&status=eq.active&limit=1`);
    companyId = cleanText(rows[0]?.company_id, 40);
  } else {
    const rows = await restRows(`zysyr_stores?select=company_id&status=eq.active&limit=1`);
    companyId = cleanText(rows[0]?.company_id, 40);
  }
  if (!companyId) throw new Error("门店信息无效");
  const existing = await restRows(`zysyr_user_accounts?select=id&company_id=eq.${companyId}&login_name=eq.${encodeURIComponent(username)}&limit=1`);
  const pending = await restRows(`zysyr_shareholder_registrations?select=id&company_id=eq.${companyId}&login_name=eq.${encodeURIComponent(username)}&status=eq.pending&limit=1`);
  const legacy = await restRows(`staff?select=id&username=eq.${encodeURIComponent(username)}&limit=1`);
  if (existing.length || pending.length || legacy.length) throw new Error("该账号已存在，请更换账号");
  const accountId = crypto.randomUUID();
  const email = `zysyr_account_${accountId.replaceAll("-", "")}@auth.zysyr.invalid`;
  const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email, password, email_confirm: true,
      app_metadata: {
        zysyr_account_id: accountId, zysyr_company_id: companyId, zysyr_login_name: username,
        zysyr_role: "shareholder", zysyr_provisioning: "shareholder_self_registration",
      },
    }),
  });
  if (!authResponse.ok) throw new Error(`账号注册失败 (${authResponse.status})`);
  const authBody = await authResponse.json() as JsonRecord;
  const authUser = authBody.id ? authBody : (authBody.user && typeof authBody.user === "object" ? authBody.user as JsonRecord : {});
  const authUserId = cleanText(authUser.id, 40);
  if (!authUserId) throw new Error("账号注册未完成");
  const ins = await rest("zysyr_shareholder_registrations", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      id: accountId, company_id: companyId, login_name: username, display_name: displayName,
      auth_user_id: authUserId, scope_type: scopeType, store_id: scopeType === "store" ? storeId : null,
      status: "pending",
    }),
  });
  if (!ins.ok) throw new Error("注册申请保存失败");
  return { submitted: true, message: "注册申请已提交，等待老板审核" };
}

async function shareholderRegistrationList(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "finance_account.create")) throw new Error("只有老板或管理员可以审核股东注册");
  const companyId = cleanText(session.auth_company_id, 40);
  if (!companyId) throw new Error("无法确认公司范围");
  const rows = await restRowsAll(`zysyr_shareholder_registrations?select=id,company_id,login_name,display_name,scope_type,store_id,status,requested_at&company_id=eq.${companyId}&status=eq.pending&order=requested_at.desc&limit=500`, 500);
  return { registrations: rows };
}

async function shareholderRegistrationReview(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "finance_account.create")) throw new Error("只有老板或管理员可以审核股东注册");
  const companyId = cleanText(session.auth_company_id, 40);
  const registrationId = cleanText(payload.registration_id, 40);
  const decision = cleanText(payload.decision, 20);
  const reason = cleanText(payload.reason, 500);
  if (!/^[0-9a-f-]{36}$/i.test(registrationId) || !["approved", "rejected"].includes(decision)) throw new Error("审核参数无效");
  const rows = await restRows(`zysyr_shareholder_registrations?select=id,company_id,login_name,display_name,auth_user_id,scope_type,store_id,status&company_id=eq.${companyId}&id=eq.${registrationId}&status=eq.pending&limit=1`);
  const registration = rows[0];
  if (!registration) throw new Error("该注册申请不存在或已处理");
  if (decision === "rejected") {
    const authUserId = cleanText(registration.auth_user_id, 40);
    if (authUserId) {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${authUserId}`, {
        method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      });
    }
    const upd = await rest(`zysyr_shareholder_registrations?company_id=eq.${companyId}&id=eq.${registrationId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "rejected", reviewed_by_user_id: cleanText(session.auth_account_id, 40) || null, reviewed_at: new Date().toISOString(), review_reason: reason || null }),
    });
    if (!upd.ok) throw new Error("拒绝状态保存失败");
    return { reviewed: true, decision: "rejected" };
  }
  const accountId = crypto.randomUUID();
  const newAuthUserId = cleanText(registration.auth_user_id, 40);
  const actorAuthUserId = cleanText(session.auth_user_id, 40);
  const rpc = await financeRpcSaved("rpc/zysyr_admin_complete_shareholder_account", {
    p_actor_auth_user_id: actorAuthUserId, p_account_id: accountId, p_auth_user_id: newAuthUserId,
    p_login_name: cleanText(registration.login_name, 80), p_display_name: cleanText(registration.display_name, 80),
    p_scope_type: cleanText(registration.scope_type, 20), p_store_id: cleanText(registration.store_id, 40) || null,
    p_request_id: crypto.randomUUID(),
  });
  const upd = await rest(`zysyr_shareholder_registrations?company_id=eq.${companyId}&id=eq.${registrationId}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "approved", reviewed_by_user_id: cleanText(session.auth_account_id, 40) || null, reviewed_at: new Date().toISOString(), review_reason: reason || null }),
  });
  if (!upd.ok) throw new Error("通过状态保存失败");
  return { reviewed: true, decision: "approved", saved: rpc };
}

async function login(payload: JsonRecord): Promise<JsonRecord> {
  const username = cleanText(payload.username, 80);
  const password = cleanText(payload.password, 200);
  if (!username || !password) throw new Error("请输入账号和密码");
  const rows = await restRows(
    `staff?select=username,password_hash,role,position,store,active,employment_status&username=eq.${encodeURIComponent(username)}&limit=1`,
  );
  const staff = rows[0];
  const hashed = await sha256(password);
  const stored = cleanText(staff?.password_hash, 200);
  if (!staff || staff.active === false || cleanText(staff.employment_status, 40) !== "active" ||
      !stored || (stored !== hashed && stored !== `sha256:${hashed}` && stored !== password)) {
    throw new Error("账号或密码错误");
  }
  const operations_role = operationsRole(staff);
  if (operations_role !== "shareholder" && !cleanText(staff.store, 100)) throw new Error("该账号尚未绑定门店");

  rest(`zysyr_operations_sessions?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  }).catch(() => undefined);
  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  const response = await rest("zysyr_operations_sessions", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      token_hash: await sha256(token), username: staff.username, role: staff.role || "staff",
      position: staff.position || "", store: staff.store || "", expires_at: expiresAt,
    }),
  });
  if (!response.ok) throw new Error(`登录会话创建失败 (${response.status})`);
  const session = { ...staff, operations_role, expires_at: expiresAt };
  return { session_token: token, expires_at: expiresAt, user: await sessionUser(session) };
}

async function logout(payload: JsonRecord): Promise<JsonRecord> {
  const token = cleanText(payload.session_token, 200);
  if (!token) return { logged_out: true };
  const response = await rest(`zysyr_operations_sessions?token_hash=eq.${encodeURIComponent(await sha256(token))}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
  if (!response.ok) throw new Error(`退出失败 (${response.status})`);
  return { logged_out: true };
}

async function requireSession(payload: JsonRecord, request: Request): Promise<JsonRecord> {
  const authenticated = await authSession(request);
  if (authenticated) return authenticated;
  const token = cleanText(payload.session_token, 200);
  if (!token) throw new Error("请重新登录");
  const tokenHash = await sha256(token);
  const rows = await restRows(
    `zysyr_operations_sessions?select=username,role,position,store,expires_at&token_hash=eq.${encodeURIComponent(tokenHash)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
  );
  const saved = rows[0];
  if (!saved) throw new Error("登录已过期，请重新登录");
  const staffRows = await restRows(
    `staff?select=username,role,position,store,active,employment_status&username=eq.${encodeURIComponent(cleanText(saved.username, 80))}&limit=1`,
  );
  const staff = staffRows[0];
  if (!staff || staff.active === false || cleanText(staff.employment_status, 40) !== "active") {
    await rest(`zysyr_operations_sessions?token_hash=eq.${encodeURIComponent(tokenHash)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    throw new Error("账号已停用或离职，请重新登录");
  }
  const current = { ...staff, operations_role: operationsRole(staff), expires_at: saved.expires_at };
  await rest(`zysyr_operations_sessions?token_hash=eq.${encodeURIComponent(tokenHash)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      role: staff.role || "staff", position: staff.position || "", store: staff.store || "",
      last_used_at: new Date().toISOString(),
    }),
  });
  return current;
}

async function selectedStore(session: JsonRecord, payload: JsonRecord): Promise<string> {
  const stores = await availableStores(session);
  const requested = cleanText(payload.store, 100);
  const companyScope = cleanText(session.operations_role, 40) === "shareholder"
    || cleanText(session.auth_scope_type, 20) === "company";
  const store = companyScope ? (requested || stores[0] || "") : cleanText(session.store, 100);
  if (!store || !stores.includes(store)) throw new Error("请选择有效门店");
  return store;
}

async function selectedStoreInfo(session: JsonRecord, payload: JsonRecord): Promise<JsonRecord> {
  const name = await selectedStore(session, payload);
  const scoped = Array.isArray(session.auth_store_records) ? session.auth_store_records as JsonRecord[] : [];
  const matched = scoped.find((store) => cleanText(store.name, 100) === name);
  if (matched) {
    const companyId = cleanText(matched.company_id, 40) || cleanText(session.auth_company_id, 40);
    const storeId = cleanText(matched.id, 40);
    if (companyId && storeId) return { company_id: companyId, id: storeId, name };
  }
  const rows = await restRows(`zysyr_stores?select=id,company_id,name&name=eq.${encodeURIComponent(name)}&limit=2`);
  if (rows.length !== 1 || !cleanText(rows[0].company_id, 40)) throw new Error("门店尚未完成公司映射，不能读写财务报表");
  return rows[0];
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

function amountValue(value: unknown): number {
  const raw = cleanText(value, 40);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error("金额必须为非负数字，最多两位小数");
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > 9999999999.99) throw new Error("金额超出允许范围");
  return amount;
}

function signedAmountValue(value: unknown): number {
  const raw = cleanText(value, 40);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error("调整金额最多两位小数");
  const amount = Number(raw);
  if (!Number.isFinite(amount) || Math.abs(amount) > 9999999999.99) throw new Error("调整金额超出允许范围");
  return amount;
}

function rateValue(value: unknown): number {
  const raw = cleanText(value, 40);
  if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) throw new Error("提成比例必须为 0 至 1，最多四位小数");
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error("提成比例必须为 0 至 1");
  return rate;
}

function catalogCostValue(value: unknown): number | null {
  const raw = cleanText(value, 40);
  if (!raw) return null;
  if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) throw new Error("参考成本必须为非负数字，最多四位小数");
  const cost = Number(raw);
  if (!Number.isFinite(cost) || cost < 0 || cost >= 10000000000) throw new Error("参考成本超出允许范围");
  return cost;
}

function quantityValue(value: unknown): number | null {
  const raw = cleanText(value, 40);
  if (!raw) return null;
  if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) throw new Error("数量必须为非负数字，最多四位小数");
  const quantity = Number(raw);
  if (!Number.isFinite(quantity) || quantity < 0 || quantity >= 10000000000) throw new Error("数量超出允许范围");
  return quantity;
}

async function catalog(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const role = cleanText(session.operations_role, 40);
  if (role !== "shareholder" && role !== "finance" && role !== "store_manager") throw new Error("当前角色无权查看基础资料");
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  if (!companyId) throw new Error("基础资料公司范围无效");
  const [serviceItems, products, suppliers, employees, stores] = await Promise.all([
    restRowsAll(`zysyr_service_items?select=id,name,category,status,created_at,updated_at&company_id=eq.${companyId}&deleted_at=is.null&order=status.asc,category.asc,name.asc&limit=2000`, 2000),
    restRowsAll(`zysyr_products?select=id,name,category,unit,default_cost,status,created_at,updated_at&company_id=eq.${companyId}&deleted_at=is.null&order=status.asc,category.asc,name.asc&limit=5000`, 5000),
    restRowsAll(`zysyr_suppliers?select=id,name,category,contact,status,created_at,updated_at&company_id=eq.${companyId}&deleted_at=is.null&order=status.asc,name.asc&limit=2000`, 2000),
    restRowsAll(`zysyr_employees?select=id,store_id,employee_code,name,position,level,join_date,leave_date,employment_status,created_at,updated_at&company_id=eq.${companyId}&store_id=eq.${cleanText(store.id, 40)}&deleted_at=is.null&order=employment_status.asc,employee_code.asc,name.asc&limit=2000`, 2000),
    restRowsAll(`zysyr_stores?select=id,company_id,name,code,city,address,status,manager_employee_id,created_at,updated_at&company_id=eq.${companyId}&deleted_at=is.null&order=status.asc,name.asc&limit=500`, 500),
  ]);
  return {
    company_id: companyId,
    store_id: cleanText(store.id, 40),
    store: cleanText(store.name, 100),
    service_items: serviceItems,
    products,
    suppliers,
    employees,
    stores,
  };
}

async function rpcSaved(path: string, body: JsonRecord): Promise<JsonRecord> {
  const response = await rest(path, { method: "POST", body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data && typeof data === "object" ? data as JsonRecord : {};
    const code = cleanText(error.message, 120) || cleanText(error.code, 40);
    if (code === "CHANGE_REASON_REQUIRED") throw new Error("修改基础资料必须填写原因");
    if (/FORBIDDEN$/.test(code)) throw new Error("当前账号没有该基础资料维护权限");
    if (/_NOT_FOUND$/.test(code)) throw new Error("基础资料不存在或已归档");
    if (/_FIELDS_REQUIRED$|_NAME_REQUIRED$|_STATUS_INVALID$|_COST_INVALID$|_DATE_INVALID$|_CODE_INVALID$|_MANAGER.*INVALID$/.test(code)) throw new Error("基础资料字段无效");
    if (cleanText(error.code, 40) === "23505") throw new Error("编号或名称已存在，请更换后再保存");
    throw new Error(`基础资料保存失败 (${response.status})`);
  }
  const saved = Array.isArray(data) ? data[0] : data;
  if (!saved || typeof saved !== "object") throw new Error("基础资料保存结果无效");
  return saved as JsonRecord;
}

async function saveServiceItem(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "daily_report.write")) throw new Error("当前账号没有项目维护权限");
  const store = await selectedStoreInfo(session, payload);
  const actorId = cleanText(session.auth_account_id, 40);
  const id = cleanText(payload.id, 40);
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("服务项目ID无效");
  const saved = await rpcSaved("rpc/zysyr_upsert_service_item", {
    p_actor_user_id: actorId,
    p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40),
    p_id: id || null,
    p_name: cleanText(payload.name, 160),
    p_category: cleanText(payload.category, 100),
    p_status: cleanText(payload.status, 20) || "active",
    p_reason: cleanText(payload.reason, 500) || null,
  });
  return { saved };
}

async function saveProduct(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "inventory.write")) throw new Error("当前账号没有产品维护权限");
  const store = await selectedStoreInfo(session, payload);
  const actorId = cleanText(session.auth_account_id, 40);
  const id = cleanText(payload.id, 40);
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("产品ID无效");
  const saved = await rpcSaved("rpc/zysyr_upsert_product", {
    p_actor_user_id: actorId,
    p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40),
    p_id: id || null,
    p_name: cleanText(payload.name, 160),
    p_category: cleanText(payload.category, 100),
    p_unit: cleanText(payload.unit, 40),
    p_default_cost: catalogCostValue(payload.default_cost),
    p_status: cleanText(payload.status, 20) || "active",
    p_reason: cleanText(payload.reason, 500) || null,
  });
  return { saved };
}

async function saveSupplier(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "inventory.write")) throw new Error("当前账号没有供应商维护权限");
  const store = await selectedStoreInfo(session, payload);
  const actorId = cleanText(session.auth_account_id, 40);
  const id = cleanText(payload.id, 40);
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("供应商ID无效");
  const saved = await rpcSaved("rpc/zysyr_upsert_supplier", {
    p_actor_user_id: actorId,
    p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40),
    p_id: id || null,
    p_name: cleanText(payload.name, 160),
    p_category: cleanText(payload.category, 100) || null,
    p_contact: cleanText(payload.contact, 300) || null,
    p_status: cleanText(payload.status, 20) || "active",
    p_reason: cleanText(payload.reason, 500) || null,
  });
  return { saved };
}

async function saveEmployee(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "employee.write")) throw new Error("当前账号没有员工维护权限");
  const store = await selectedStoreInfo(session, payload);
  const actorId = cleanText(session.auth_account_id, 40);
  const id = cleanText(payload.id, 40);
  const joinDate = cleanText(payload.join_date, 10);
  const leaveDate = cleanText(payload.leave_date, 10);
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("员工ID无效");
  if (joinDate && !validDate(joinDate)) throw new Error("入职日期无效");
  if (leaveDate && !validDate(leaveDate)) throw new Error("离职日期无效");
  const saved = await rpcSaved("rpc/zysyr_upsert_employee", {
    p_actor_user_id: actorId,
    p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40),
    p_id: id || null,
    p_employee_code: cleanText(payload.employee_code, 80),
    p_name: cleanText(payload.name, 120),
    p_position: cleanText(payload.position, 120),
    p_level: cleanText(payload.level, 80) || null,
    p_join_date: joinDate || null,
    p_leave_date: leaveDate || null,
    p_employment_status: cleanText(payload.employment_status, 20) || "active",
    p_reason: cleanText(payload.reason, 500) || null,
  });
  return { saved };
}

async function saveStore(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "org.store.write") || cleanText(session.auth_scope_type, 20) !== "company") {
    throw new Error("当前账号没有门店维护权限");
  }
  const contextStore = await selectedStoreInfo(session, payload);
  const actorId = cleanText(session.auth_account_id, 40);
  const id = cleanText(payload.id, 40);
  const managerId = cleanText(payload.manager_employee_id, 40);
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("门店ID无效");
  if (managerId && !/^[0-9a-f-]{36}$/i.test(managerId)) throw new Error("负责人ID无效");
  const code = cleanText(payload.code, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(code)) throw new Error("门店编号仅支持小写字母、数字、横线和下划线");
  const saved = await rpcSaved("rpc/zysyr_upsert_store", {
    p_actor_user_id: actorId,
    p_company_id: cleanText(contextStore.company_id, 40),
    p_id: id || null,
    p_name: cleanText(payload.name, 100),
    p_code: code,
    p_city: cleanText(payload.city, 100),
    p_address: cleanText(payload.address, 300) || null,
    p_manager_employee_id: managerId || null,
    p_status: cleanText(payload.status, 20) || "active",
    p_reason: cleanText(payload.reason, 500) || null,
  });
  return { saved };
}

async function historyMonthEntries(companyId: string, storeId: string, month: string, entryType = ""): Promise<JsonRecord[]> {
  const typeFilter = entryType ? `&entry_type=eq.${encodeURIComponent(entryType)}` : "";
  return restRowsAll(`zysyr_history_ledger_entries?select=id,import_batch_id,import_row_id,entry_type,period_month,source_sheet,source_locator,posted_payload,current_payload,posted_validation_status,posted_validation_issues,posted_review_status,posted_with_warning,status,version,posted_by_user_id,posted_at,last_modified_by_user_id,last_modified_at&company_id=eq.${companyId}&store_id=eq.${storeId}&period_month=eq.${month}-01&status=eq.posted${typeFilter}&order=source_sheet.asc,source_locator.asc&limit=5000`, 5000);
}

async function historyEvidenceForEntries(companyId: string, storeId: string, entries: JsonRecord[]): Promise<JsonRecord> {
  const rowIds = entries.map((row) => row.import_row_id).filter(Boolean);
  const links = rowIds.length ? await restRowsAll(`zysyr_history_import_row_evidence?select=id,import_batch_id,import_row_id,evidence_id,source_locator,link_level,linked_at&company_id=eq.${companyId}&store_id=eq.${storeId}&import_row_id=in.${uuidIn(rowIds)}&limit=10000`, 10000) : [];
  const evidenceIds = Array.from(new Set(links.map((row) => row.evidence_id).filter(Boolean)));
  const evidence = evidenceIds.length ? await restRowsAll(`zysyr_history_import_evidence?select=id,import_batch_id,period_month,evidence_kind,original_filename,mime_type,size_bytes,sha256,embedded_asset_count,uploaded_by_user_id,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(evidenceIds)}&limit=1000`, 1000) : [];
  return { links, evidence };
}

function historyEvidenceWithScope(data: JsonRecord): JsonRecord[] {
  const links = Array.isArray(data.links) ? data.links as JsonRecord[] : [];
  const evidence = Array.isArray(data.evidence) ? data.evidence as JsonRecord[] : [];
  return evidence.map((item) => {
    const matching = links.filter((link) => cleanText(link.evidence_id, 40) === cleanText(item.id, 40));
    const exact = matching.filter((link) => cleanText(link.link_level, 30) !== "bundle_only");
    const exactRowIds = new Set(exact.map((link) => cleanText(link.import_row_id, 40)).filter(Boolean));
    const bundleRowIds = new Set(matching.filter((link) => cleanText(link.link_level, 30) === "bundle_only")
      .map((link) => cleanText(link.import_row_id, 40)).filter(Boolean));
    const exactLocators = Array.from(new Set(exact.map((link) => cleanText(link.source_locator, 160)).filter(Boolean)));
    const selected = exact[0] || matching[0] || {};
    return {
      ...item,
      trace_link_level: cleanText(selected.link_level, 30) || "unlinked",
      trace_source_locator: exactLocators[0] || cleanText(selected.source_locator, 160) || null,
      trace_source_locators: exactLocators,
      trace_missing_exact_count: Array.from(bundleRowIds).filter((rowId) => !exactRowIds.has(rowId)).length,
      trace_asset_count: Number(item.embedded_asset_count || 0),
    };
  });
}

const MONTHLY_EVIDENCE_POLICIES = new Set(["voucher_required", "source_report", "none"]);

function defaultMonthlyEvidencePolicy(cell: JsonRecord): string {
  const kind = cleanText(cell.cell_kind, 30);
  const label = cleanText(cell.label, 300).replace(/[\s/／·]/g, "");
  const amount = Number(cell.numeric_value);
  if (kind === "formula" || /小计|合计|总计|盈亏/.test(label) || (Number.isFinite(amount) && amount === 0)) return "none";
  if (/美发收入|营业收入|产品收入|其他收入|技术人员|后勤人员|人工|工资|底薪|提成|饭补|社保|奖金|补贴|扣款/.test(label)) {
    return "source_report";
  }
  if (/房租|物业|广告|空调|水费|电费|煤气|电话|宽带|采购|进货|产品成本|市场|备用金|保险|税|手续费|宿舍|培训|维修|聚餐|杂项|支出/.test(label)) {
    return "voucher_required";
  }
  return "source_report";
}

async function monthlyEvidenceRules(
  companyId: string,
  storeId: string,
  templateCode: string,
): Promise<JsonRecord[]> {
  if (!templateCode) return [];
  return restRowsAll(`zysyr_monthly_evidence_rules?select=id,template_code,cell_address,cell_label,evidence_policy,reason,updated_by_user_id,updated_at&company_id=eq.${companyId}&store_id=eq.${storeId}&template_code=eq.${encodeURIComponent(templateCode)}&order=cell_address.asc&limit=5000`, 5000);
}

function monthlyEvidencePolicyMap(cells: JsonRecord[], rules: JsonRecord[]): Record<string, string> {
  const overrides = new Map(rules.map((rule) => [cleanText(rule.cell_address, 20).toUpperCase(), cleanText(rule.evidence_policy, 30)]));
  const output: Record<string, string> = {};
  for (const cell of cells) {
    const address = cleanText(cell.cell_address, 20).toUpperCase();
    if (!address) continue;
    const override = overrides.get(address);
    output[address] = override && MONTHLY_EVIDENCE_POLICIES.has(override) ? override : defaultMonthlyEvidencePolicy(cell);
  }
  return output;
}

async function historicalMonthlyReport(companyId: string, storeId: string, month: string, storeName: string): Promise<JsonRecord | null> {
  const entries = effectiveHistoryMonthlyEntries(await historyMonthEntries(companyId, storeId, month, "monthly_profit_loss"));
  if (!entries.length) return null;
  const batchId = cleanText(entries[0].import_batch_id, 40);
  const batches = await restRows(`zysyr_history_import_batches?select=id,source_filename,source_mime_type,source_size_bytes,source_sha256,source_bucket_id,source_object_path,created_by_user_id,created_at,confirmed_by_user_id,confirmed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${batchId}&status=eq.completed&limit=1`);
  const batch = batches[0];
  if (!batch) return null;
  const sheetCounts = new Map<string, number>();
  for (const entry of entries) {
    const name = cleanText(entry.source_sheet, 120);
    if (name) sheetCounts.set(name, (sheetCounts.get(name) || 0) + 1);
  }
  const sheetName = Array.from(sheetCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${storagePath(cleanText(batch.source_bucket_id, 100))}/${storagePath(cleanText(batch.source_object_path, 500))}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!response.ok) throw new Error(`历史月报原件读取失败 (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const display = await workbookDisplay(bytes, "monthly_profit_loss", storeName, sheetName);
  const entryByAddress = new Map(entries.map((entry) => [cleanText((entry.current_payload as JsonRecord)?.cell_address, 20).toUpperCase(), entry]));
  const values = Array.isArray(display.values) ? display.values as unknown[][] : [];
  const cells = Array.isArray(display.cells) ? display.cells as JsonRecord[] : [];
  for (const cell of cells) {
    const address = cleanText(cell.cell_address, 20).toUpperCase();
    const entry = entryByAddress.get(address);
    if (!entry) continue;
    const current = entry.current_payload && typeof entry.current_payload === "object" ? entry.current_payload as JsonRecord : {};
    const amount = current.amount === null || current.amount === undefined || current.amount === "" ? null : Number(current.amount);
    cell.id = entry.id;
    cell.historical_ledger_entry_id = entry.id;
    cell.numeric_value = amount !== null && Number.isFinite(amount) ? amount : cell.numeric_value;
    cell.display_value = cell.numeric_value === null || cell.numeric_value === undefined ? cell.display_value : String(cell.numeric_value);
    cell.formula = cleanText(current.formula, 2000) || cell.formula || null;
    cell.cell_kind = cleanText(current.cell_kind, 30) || cell.cell_kind;
    cell.label = cleanText(current.label, 300) || cell.label;
    const rowIndex = Number(cell.row_number) - 1, columnIndex = Number(cell.column_number) - 1;
    if (Number.isFinite(amount) && Array.isArray(values[rowIndex])) values[rowIndex][columnIndex] = amount;
  }
  const evidenceData = await historyEvidenceForEntries(companyId, storeId, entries);
  const evidenceRules = await monthlyEvidenceRules(companyId, storeId, "history_original_v1");
  const evidencePolicies = monthlyEvidencePolicyMap(cells, evidenceRules);
  const linkCounts = new Map<string, number>();
  for (const link of evidenceData.links as JsonRecord[]) {
    const rowId = cleanText(link.import_row_id, 40);
    linkCounts.set(rowId, (linkCounts.get(rowId) || 0) + 1);
  }
  const traceStatus: Record<string, string> = {}, sourceCount: Record<string, number> = {};
  const summary = { total: 0, matched: 0, mismatch: 0, missing_evidence: 0, unlinked: 0, formula: 0, source_report: 0, not_required: 0 };
  for (const entry of entries) {
    const current = entry.current_payload as JsonRecord;
    const address = cleanText(current?.cell_address, 20).toUpperCase();
    if (!address) continue;
    const isFormula = cleanText(current?.cell_kind, 20) === "formula";
    const count = linkCounts.get(cleanText(entry.import_row_id, 40)) || 0;
    const policy = evidencePolicies[address] || defaultMonthlyEvidencePolicy(current || {});
    const status = isFormula ? "formula" : policy === "none" ? "not_required"
      : policy === "source_report" ? "source_report" : count ? "matched" : "missing_evidence";
    traceStatus[address] = status; sourceCount[address] = 0;
    summary.total += 1; (summary as Record<string, number>)[status] += 1;
  }
  const uploaderIds = Array.from(new Set([batch.created_by_user_id, batch.confirmed_by_user_id].filter(Boolean)));
  const uploaders = uploaderIds.length ? await restRowsAll(`zysyr_user_accounts?select=id,login_name,display_name&company_id=eq.${companyId}&id=in.${uuidIn(uploaderIds)}&limit=20`, 20) : [];
  const uploader = uploaders.find((row) => row.id === batch.confirmed_by_user_id) || uploaders[0] || null;
  return {
    id: batch.id, historical: true, history_batch_id: batch.id,
    report_type: "monthly_profit_loss", report_date: `${month}-01`, template_code: "history_original_v1",
    template_version: 1, version: Math.max(1, ...entries.map((row) => Number(row.version || 1))), status: "posted",
    original_filename: batch.source_filename, mime_type: batch.source_mime_type, size_bytes: batch.source_size_bytes,
    sha256: batch.source_sha256, display_data: display, uploaded_by_user_id: batch.confirmed_by_user_id || batch.created_by_user_id,
    uploaded_at: batch.confirmed_at || batch.created_at, uploaded_by: uploader, vouchers: evidenceData.evidence,
    history_entries: entries, history_evidence: evidenceData.evidence, history_evidence_links: evidenceData.links,
    cell_trace_status: traceStatus, cell_trace_source_count: sourceCount, trace_summary: summary,
    monthly_evidence_rules: evidenceRules, monthly_evidence_policy: evidencePolicies,
  };
}

async function overview(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const store = await selectedStoreInfo(session, payload);
  const month = cleanText(payload.month, 7);
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`)) throw new Error("月份无效");
  const start = `${month}-01`;
  const endDate = new Date(`${start}T00:00:00Z`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const end = endDate.toISOString().slice(0, 10);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const reportPath = `zysyr_report_uploads?select=id,report_type,report_date,template_code,template_version,version,status,original_filename,mime_type,size_bytes,sha256,display_data,uploaded_by_user_id,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&report_date=gte.${start}&report_date=lt.${end}&order=report_date.desc,version.desc&limit=500`;
  const voucherPath = `zysyr_voucher_attachments?select=id,record_id,original_filename,mime_type,note,uploaded_by,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&record_type=eq.report&order=uploaded_at.desc&limit=1000`;
  const [rawReports, vouchers] = await Promise.all([restRowsAll(reportPath), restRowsAll(voucherPath)]);
  const reports = rawReports.filter((row, index, list) => list.findIndex((item) => cleanText(item.report_type, 40) === cleanText(row.report_type, 40)
    && cleanText(item.report_date, 10) === cleanText(row.report_date, 10)) === index);
  const voucherMap = new Map<string, JsonRecord[]>();
  for (const voucher of vouchers) {
    const key = cleanText(voucher.record_id, 80);
    const list = voucherMap.get(key) || [];
    list.push(voucher);
    voucherMap.set(key, list);
  }
  const uploaderFilter = uuidIn(reports.map((report) => report.uploaded_by_user_id));
  const uploaders = uploaderFilter === "()" ? [] : await restRows(`zysyr_user_accounts?select=id,login_name,display_name&id=in.${uploaderFilter}&limit=500`);
  const uploaderMap = new Map(uploaders.map((account) => [cleanText(account.id, 40), {
    login_name: cleanText(account.login_name, 80), display_name: cleanText(account.display_name, 120),
  }]));
  const withEvidence: JsonRecord[] = reports.map((report) => ({
    ...report,
    uploaded_by: uploaderMap.get(cleanText(report.uploaded_by_user_id, 40)) || null,
    vouchers: voucherMap.get(cleanText(report.id, 80)) || [],
  }));
  let monthlyReport = withEvidence.find((report) => cleanText(report.report_type, 40) === "monthly_profit_loss"
    && cleanText(report.report_date, 10) === start) || null;
  const cellTraceStatus: Record<string, string> = {};
  const cellTraceSourceCount: Record<string, number> = {};
  const traceSummary = { total: 0, matched: 0, mismatch: 0, missing_evidence: 0, unlinked: 0, formula: 0, source_report: 0, not_required: 0 };
  let monthlyEvidenceRuleRows: JsonRecord[] = [];
  let monthlyEvidencePolicies: Record<string, string> = {};
  let monthlyCellRevisions: JsonRecord[] = [];
  let monthlyPeriodLocked = false;
  if (monthlyReport) {
    const reportId = cleanText(monthlyReport.id, 40);
    const cells = await restRowsAll(`zysyr_report_cells?select=id,cell_address,row_number,column_number,cell_kind,display_value,numeric_value,formula,precedent_addresses,label&company_id=eq.${companyId}&store_id=eq.${storeId}&report_id=eq.${reportId}&order=row_number.asc,column_number.asc`, 5000);
    monthlyEvidenceRuleRows = await monthlyEvidenceRules(companyId, storeId, cleanText(monthlyReport.template_code, 120));
    monthlyEvidencePolicies = monthlyEvidencePolicyMap(cells, monthlyEvidenceRuleRows);
    const cellFilter = uuidIn(cells.map((cell) => cell.id));
    const [revisions, amountRevisions, locks] = await Promise.all([
      cellFilter === "()" ? [] : restRowsAll(`zysyr_report_cell_trace_revisions?select=target_cell_id,revision,status,source_count&company_id=eq.${companyId}&target_cell_id=in.${cellFilter}&order=revision.desc`, 5000),
      cellFilter === "()" ? [] : restRowsAll(`zysyr_monthly_cell_revisions?select=id,source_cell_id,revision,revision_type,before_amount,after_amount,delta,reason,actor_user_id,voucher_count,created_at&company_id=eq.${companyId}&store_id=eq.${storeId}&report_id=eq.${reportId}&order=source_cell_id.asc,revision.desc`, 5000),
      restRowsAll(`zysyr_period_locks?select=id,scope_type,store_id,status,period_month&company_id=eq.${companyId}&period_month=eq.${start}&status=eq.locked&limit=20`, 20),
    ]);
    const latestAmountRevisionByCell = latestMonthlyCellRevisionMap(amountRevisions);
    monthlyCellRevisions = Array.from(latestAmountRevisionByCell.values());
    monthlyPeriodLocked = locks.some((lock) => cleanText(lock.scope_type, 20) === "company"
      || cleanText(lock.store_id, 40) === storeId);
    monthlyReport = {
      ...monthlyReport,
      display_data: effectiveMonthlyDisplay(monthlyReport.display_data, cells, amountRevisions),
    };
    const latest = new Map<string, string>();
    const latestSourceCount = new Map<string, number>();
    for (const revision of revisions) {
      const cellId = cleanText(revision.target_cell_id, 40);
      if (!latest.has(cellId)) {
        latest.set(cellId, cleanText(revision.status, 30));
        latestSourceCount.set(cellId, Number(revision.source_count || 0));
      }
    }
    const cellsByAddress = new Map(cells.map((cell) => [cleanText(cell.cell_address, 20), cell]));
    const resolved = new Map<string, string>();
    function resolveStatus(cell: JsonRecord, trail = new Set<string>()): string {
      const id = cleanText(cell.id, 40);
      if (resolved.has(id)) return resolved.get(id) as string;
      if (trail.has(id)) return "mismatch";
      if (cleanText(cell.cell_kind, 20) !== "formula") {
        const policy = monthlyEvidencePolicies[cleanText(cell.cell_address, 20).toUpperCase()] || defaultMonthlyEvidencePolicy(cell);
        const traced = latest.get(id) || "unlinked";
        const uploadedVoucherCount = Number(latestAmountRevisionByCell.get(id)?.voucher_count || 0);
        const status = policy === "none" ? "not_required"
          : policy === "source_report" ? (traced === "mismatch" ? "mismatch" : latestSourceCount.get(id) ? "source_report" : "unlinked")
            : traced === "unlinked" && uploadedVoucherCount > 0 ? "matched" : traced;
        resolved.set(id, status);
        return status;
      }
      const nextTrail = new Set(trail); nextTrail.add(id);
      const addresses = Array.isArray(cell.precedent_addresses) ? cell.precedent_addresses as unknown[] : [];
      const precedentStatuses = addresses.map((address) => cellsByAddress.get(cleanText(address, 20))).filter(Boolean)
        .map((precedent) => resolveStatus(precedent as JsonRecord, nextTrail));
      const status = precedentStatuses.includes("mismatch") ? "mismatch" : "formula";
      resolved.set(id, status);
      return status;
    }
    for (const cell of cells) {
      const address = cleanText(cell.cell_address, 20);
      const status = resolveStatus(cell);
      cellTraceStatus[address] = status;
      cellTraceSourceCount[address] = latestSourceCount.get(cleanText(cell.id, 40)) || 0;
      traceSummary.total += 1;
      if (Object.prototype.hasOwnProperty.call(traceSummary, status)) (traceSummary as Record<string, number>)[status] += 1;
    }
  }
  if (!monthlyReport) {
    const historical = await historicalMonthlyReport(companyId, storeId, month, cleanText(store.name, 120));
    if (historical) {
      monthlyReport = historical;
      Object.assign(cellTraceStatus, historical.cell_trace_status as Record<string, string> || {});
      Object.assign(cellTraceSourceCount, historical.cell_trace_source_count as Record<string, number> || {});
      Object.assign(traceSummary, historical.trace_summary as Record<string, number> || {});
      monthlyEvidenceRuleRows = historical.monthly_evidence_rules as JsonRecord[] || [];
      monthlyEvidencePolicies = historical.monthly_evidence_policy as Record<string, string> || {};
    }
  }
  const acknowledgements = await restRowsAll(`zysyr_report_acknowledgements?select=id,month,monthly_report_id,user_id,acknowledged_at&company_id=eq.${companyId}&store_id=eq.${storeId}&month=eq.${month}&order=acknowledged_at.desc&limit=500`, 500);
  const ackUserIds = Array.from(new Set(acknowledgements.map((row) => cleanText(row.user_id, 40)).filter(Boolean)));
  const ackUsers = ackUserIds.length ? await restRows(`zysyr_user_accounts?select=id,login_name,display_name&company_id=eq.${companyId}&id=in.${uuidIn(ackUserIds)}&limit=500`) : [];
  const ackUserMap = new Map(ackUsers.map((account) => [cleanText(account.id, 40), {
    login_name: cleanText(account.login_name, 80), display_name: cleanText(account.display_name, 120),
  }]));
  const acknowledgementsWithUsers = acknowledgements.map((row) => ({ ...row, user: ackUserMap.get(cleanText(row.user_id, 40)) || null }));
  let unlockRequests: JsonRecord[] = [];
  const actorId = cleanText(session.auth_account_id, 40);
  if (monthlyReport && (cleanText(session.operations_role, 40) === "finance" || hasAuthCapability(session, "finance_account.create"))) {
    const ownFilter = hasAuthCapability(session, "finance_account.create") ? "" : `&requested_by_user_id=eq.${actorId}`;
    unlockRequests = await restRowsAll(`zysyr_monthly_cell_unlock_requests?select=id,period_month,status,requested_by_user_id,request_reason,requested_at,decided_by_user_id,decision_reason,decided_at,consumed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&period_month=eq.${start}${ownFilter}&order=requested_at.desc&limit=100`, 100);
    const accountIds = Array.from(new Set(unlockRequests.flatMap((row) => [row.requested_by_user_id, row.decided_by_user_id]).filter(Boolean)));
    const accounts = accountIds.length ? await restRowsAll(`zysyr_user_accounts?select=id,login_name,display_name&company_id=eq.${companyId}&id=in.${uuidIn(accountIds)}&limit=200`, 200) : [];
    const accountMap = new Map(accounts.map((account) => [cleanText(account.id, 40), account]));
    unlockRequests = unlockRequests.map((row) => ({ ...row,
      requested_by: accountMap.get(cleanText(row.requested_by_user_id, 40)) || null,
      decided_by: accountMap.get(cleanText(row.decided_by_user_id, 40)) || null,
    }));
  }
  return {
    store: cleanText(store.name, 100), month, source_boundary: "finance_uploads_only",
    monthly_report: monthlyReport,
    reports: monthlyReport && monthlyReport.historical ? [...withEvidence, monthlyReport] : withEvidence,
    cell_trace_status: cellTraceStatus,
    cell_trace_source_count: cellTraceSourceCount,
    trace_summary: traceSummary,
    monthly_evidence_rules: monthlyEvidenceRuleRows,
    monthly_evidence_policy: monthlyEvidencePolicies,
    monthly_cell_revisions: monthlyCellRevisions,
    monthly_period_locked: monthlyPeriodLocked,
    monthly_unlock_requests: unlockRequests,
    acknowledgements: acknowledgementsWithUsers,
  };
}

async function reportAcknowledge(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (cleanText(session.operations_role, 40) !== "shareholder") throw new Error("只有股东账号可以确认已阅");
  const store = await selectedStoreInfo(session, payload);
  const month = cleanText(payload.month, 7);
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`)) throw new Error("月份无效");
  const saved = await financeRpcSaved("rpc/zysyr_acknowledge_report", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_month: month,
    p_monthly_report_id: uuidValue(payload.monthly_report_id, "月报编号无效", true),
  });
  return { saved };
}



// Derived values are computed on read; the immutable source and revisions stay intact.
function effectiveHistoryMonthlyEntries(entries: JsonRecord[]): JsonRecord[] {
  const rows = entries.map((entry) => ({ ...entry, current_payload: { ...(entry.current_payload as JsonRecord) } }));
  const byAddress = new Map(rows.map((row) => [cleanText(row.current_payload.cell_address, 20).toUpperCase(), row]));
  const values = new Map<string, number>();
  const visiting = new Set<string>();
  const changed = new Set<string>();
  function evaluate(address: string): number | null {
    if (values.has(address)) return values.get(address)!;
    if (visiting.has(address)) return null;
    const row = byAddress.get(address);
    if (!row) return 0; // Empty Excel cells contribute zero.
    const item = row.current_payload;
    if (item.cell_kind !== "formula") {
      const value = Number(item.amount);
      if (!Number.isFinite(value)) return null;
      if (Number((row.posted_payload as JsonRecord)?.amount) !== value) changed.add(address);
      values.set(address, value); return value;
    }
    visiting.add(address);
    const formula = cleanText(item.formula, 2000);
    const refs = formulaPrecedents(formula, cleanText(row.source_sheet, 120));
    let valid = !formula.includes("!") && !formula.includes("#REF!");
    for (const ref of refs) { const value = evaluate(ref); if (value === null) valid = false; else values.set(ref, value); }
    if (!refs.some((ref) => changed.has(ref))) {
      visiting.delete(address);
      const cached = Number(item.amount);
      if (Number.isFinite(cached)) { values.set(address, cached); return cached; }
      return null;
    }
    const value = valid ? safeFormulaValue(formula, refs, values) : null;
    visiting.delete(address);
    if (value !== null) { item.amount = value; values.set(address, value); changed.add(address); }
    return value;
  }
  for (const address of byAddress.keys()) evaluate(address);
  return rows;
}

function latestMonthlyCellRevisionMap(revisions: JsonRecord[]): Map<string, JsonRecord> {
  const latest = new Map<string, JsonRecord>();
  for (const revision of revisions) {
    const cellId = cleanText(revision.source_cell_id, 40);
    if (cellId && !latest.has(cellId)) latest.set(cellId, revision);
  }
  return latest;
}

function safeFormulaValue(formula: string, precedents: unknown[], values: Map<string, number>): number | null {
  const addresses = (Array.isArray(precedents) ? precedents : [])
    .map((item) => cleanText(item, 20).toUpperCase())
    .filter((item) => /^[A-Z]{1,3}[1-9][0-9]{0,3}$/.test(item));
  if (/^=?\s*SUM\s*\([^)]*\)\s*$/i.test(formula) && addresses.length) {
    return Number(addresses.reduce((sum, address) => sum + (values.get(address) || 0), 0).toFixed(4));
  }
  let expression = formula.replace(/^=/, "").replace(/\$?([A-Z]{1,3})\$?([1-9][0-9]{0,3})/g, (_match, letters, row) => {
    return String(values.get(`${letters}${row}`) || 0);
  });
  if (!/^[0-9+\-*/().\s]+$/.test(expression) || expression.length > 500) return null;
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/]/g) || [];
  let index = 0;
  function primary(): number {
    const token = tokens[index++];
    if (token === "(") {
      const value = addSubtract();
      if (tokens[index++] !== ")") throw new Error("formula");
      return value;
    }
    if (token === "+") return primary();
    if (token === "-") return -primary();
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error("formula");
    return value;
  }
  function multiplyDivide(): number {
    let value = primary();
    while (tokens[index] === "*" || tokens[index] === "/") {
      const operator = tokens[index++];
      const right = primary();
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  }
  function addSubtract(): number {
    let value = multiplyDivide();
    while (tokens[index] === "+" || tokens[index] === "-") {
      const operator = tokens[index++];
      const right = multiplyDivide();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }
  try {
    const result = addSubtract();
    return index === tokens.length && Number.isFinite(result) ? Number(result.toFixed(4)) : null;
  } catch {
    return null;
  }
}

function effectiveMonthlyDisplay(displayData: unknown, cells: JsonRecord[], revisions: JsonRecord[]): JsonRecord {
  const source = displayData && typeof displayData === "object" ? displayData as JsonRecord : {};
  const display = JSON.parse(JSON.stringify(source)) as JsonRecord;
  const values = Array.isArray(display.values) ? display.values as unknown[][] : [];
  const displayCells = Array.isArray(display.cells) ? display.cells as JsonRecord[] : [];
  const latest = latestMonthlyCellRevisionMap(revisions);
  const numericByAddress = new Map<string, number>();
  const cellByAddress = new Map<string, JsonRecord>();
  for (const cell of cells) {
    const address = cleanText(cell.cell_address, 20).toUpperCase();
    if (!address) continue;
    cellByAddress.set(address, cell);
    const original = Number(cell.numeric_value);
    const revision = latest.get(cleanText(cell.id, 40));
    const effective = revision ? Number(revision.after_amount) : original;
    if (Number.isFinite(effective)) numericByAddress.set(address, effective);
  }
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const cell of cells) {
      if (cleanText(cell.cell_kind, 20) !== "formula") continue;
      const address = cleanText(cell.cell_address, 20).toUpperCase();
      const calculated = safeFormulaValue(cleanText(cell.formula, 2000), cell.precedent_addresses as unknown[], numericByAddress);
      if (calculated !== null && numericByAddress.get(address) !== calculated) {
        numericByAddress.set(address, calculated); changed = true;
      }
    }
    if (!changed) break;
  }
  const effectiveCells: Record<string, JsonRecord> = {};
  for (const [address, cell] of cellByAddress.entries()) {
    const numeric = numericByAddress.get(address);
    const revision = latest.get(cleanText(cell.id, 40)) || null;
    const row = Number(cell.row_number) - 1;
    const column = Number(cell.column_number) - 1;
    if (numeric !== undefined && Array.isArray(values[row])) values[row][column] = numeric;
    const displayCell = displayCells.find((item) => cleanText(item.cell_address, 20).toUpperCase() === address);
    if (displayCell && numeric !== undefined) {
      displayCell.numeric_value = numeric;
      displayCell.display_value = String(numeric);
    }
    effectiveCells[address] = {
      source_cell_id: cell.id, original_amount: cell.numeric_value,
      effective_amount: numeric ?? cell.numeric_value, revision,
    };
  }
  display.values = values;
  display.cells = displayCells;
  display.effective_cells = effectiveCells;
  return display;
}

async function monthlyCellSave(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireFinanceCapability(session, "confirmed_finance.adjust", "只有具备已确认财务调整权限的财务账号可以修改月报金额");
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const month = cleanText(payload.month, 7);
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`)) throw new Error("月份无效");
  const reportId = uuidValue(payload.report_id, "月报编号无效");
  const reason = cleanText(payload.reason, 500);
  if (!reason) throw new Error("请填写本次金额修改原因");
  const cells = Array.isArray(payload.cells) ? payload.cells as JsonRecord[] : [];
  if (!cells.length || cells.length > 50) throw new Error("每次请选择 1 至 50 个有变化的金额保存");
  const changes = cells.map((cell) => {
    const address = cleanText(cell.address ?? cell.cell_address, 20).toUpperCase();
    const amount = cleanText(cell.value ?? cell.after_amount, 100);
    if (!/^[A-Z]{1,3}[1-9][0-9]{0,3}$/.test(address) || !/^-?\d{1,14}(?:\.\d{1,4})?$/.test(amount)) {
      throw new Error(`月报单元格 ${address || "未知"} 的金额格式无效`);
    }
    return { cell_address: address, after_amount: amount, cell_label: cleanText(cell.label, 300) };
  });
  const saved = await financeRpcSaved("rpc/zysyr_revise_monthly_cells", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: companyId,
    p_store_id: storeId, p_report_id: reportId, p_changes: changes,
    p_voucher_ids: uuidArray(Array.isArray(payload.voucher_ids) ? payload.voucher_ids : [], 20), p_reason: reason,
  });
  return { saved, report_id: reportId };
}

async function requestMonthlyCellUnlock(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireFinanceCapability(session, "confirmed_finance.adjust", "只有财务可以申请修改已锁账月份");
  const store = await selectedStoreInfo(session, payload);
  const month = cleanText(payload.month, 7);
  const reason = cleanText(payload.reason, 500);
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`) || !reason) throw new Error("请选择锁账月份并填写申请原因");
  const saved = await financeRpcSaved("rpc/zysyr_request_monthly_cell_unlock", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40), p_store_id: cleanText(store.id, 40),
    p_period_month: `${month}-01`, p_reason: reason,
  });
  return { saved };
}

async function decideMonthlyCellUnlock(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "finance_account.create") || cleanText(session.auth_scope_type, 20) !== "company") {
    throw new Error("只有公司范围管理员可以审批锁账修改申请");
  }
  const store = await selectedStoreInfo(session, payload);
  const decision = cleanText(payload.decision, 20);
  const reason = cleanText(payload.reason, 500);
  if (!["approved", "rejected"].includes(decision) || !reason) throw new Error("请选择审批结果并填写审批原因");
  const saved = await financeRpcSaved("rpc/zysyr_decide_monthly_cell_unlock", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40),
    p_request_id: uuidValue(payload.request_id, "锁账修改申请编号无效"),
    p_decision: decision, p_reason: reason,
  });
  return { saved };
}


async function monthlySummary(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const startMonth = cleanText(payload.start_month, 7);
  const endMonth = cleanText(payload.end_month, 7);
  if (!/^\d{4}-\d{2}$/.test(startMonth) || !/^\d{4}-\d{2}$/.test(endMonth) || startMonth > endMonth) throw new Error("月份范围无效");
  const months: string[] = [];
  const cursor = new Date(`${startMonth}-01T00:00:00Z`);
  const endCursor = new Date(`${endMonth}-01T00:00:00Z`);
  while (cursor <= endCursor) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const endDate = new Date(`${endMonth}-01T00:00:00Z`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const endStr = endDate.toISOString().slice(0, 10);
  const rows = await restRowsAll(`zysyr_report_uploads?select=id,report_date,version,display_data&company_id=eq.${companyId}&store_id=eq.${storeId}&report_type=eq.monthly_profit_loss&report_date=gte.${startMonth}-01&report_date=lt.${endStr}&order=report_date.desc,version.desc&limit=5000`, 5000);
  const latest = new Map<string, JsonRecord>();
  for (const row of rows) {
    const month = cleanText(row.report_date, 10).slice(0, 7);
    if (!latest.has(month)) latest.set(month, row);
  }
  const ordered = months.map((month) => latest.get(month)).filter(Boolean);
  if (!ordered.length) return { start_month: startMonth, end_month: endMonth, months: [], display_data: null };
  const reportIds = ordered.map((row) => row.id);
  const reportFilter = uuidIn(reportIds);
  const [allCells, allRevisions] = await Promise.all([
    restRowsAll(`zysyr_report_cells?select=id,report_id,cell_address,row_number,column_number,cell_kind,display_value,numeric_value,formula,precedent_addresses,label&company_id=eq.${companyId}&store_id=eq.${storeId}&report_id=in.${reportFilter}&limit=10000`, 10000),
    restRowsAll(`zysyr_monthly_cell_revisions?select=id,report_id,source_cell_id,revision,revision_type,before_amount,after_amount,delta,reason,actor_user_id,voucher_count,created_at&company_id=eq.${companyId}&store_id=eq.${storeId}&report_id=in.${reportFilter}&order=source_cell_id.asc,revision.desc&limit=10000`, 10000),
  ]);
  const effectiveReports = ordered.map((row) => ({ ...row,
    display_data: effectiveMonthlyDisplay(row.display_data,
      allCells.filter((cell) => cleanText(cell.report_id, 40) === cleanText(row.id, 40)),
      allRevisions.filter((revision) => cleanText(revision.report_id, 40) === cleanText(row.id, 40))),
  }));
  const baseDisplay = effectiveReports[0].display_data && typeof effectiveReports[0].display_data === "object" ? effectiveReports[0].display_data as JsonRecord : {};
  const baseValues = Array.isArray(baseDisplay.values) ? (baseDisplay.values as unknown[]).map((row) => Array.isArray(row) ? row.slice() : []) : [];
  for (let i = 1; i < effectiveReports.length; i += 1) {
    const display = effectiveReports[i].display_data && typeof effectiveReports[i].display_data === "object" ? effectiveReports[i].display_data as JsonRecord : {};
    const values = Array.isArray(display.values) ? display.values as unknown[] : [];
    for (let r = 0; r < baseValues.length; r += 1) {
      const rowArr = baseValues[r] as unknown[];
      for (let c = 0; c < rowArr.length; c += 1) {
        const cur = rowArr[c];
        const other = Array.isArray(values[r]) ? (values[r] as unknown[])[c] : null;
        const nCur = Number(cur);
        const nOther = Number(other);
        if (cur !== null && cur !== "" && other !== null && other !== "" && !Number.isNaN(nCur) && !Number.isNaN(nOther)) {
          rowArr[c] = nCur + nOther;
        }
      }
    }
  }
  return {
    start_month: startMonth, end_month: endMonth,
    months: effectiveReports.map((row) => cleanText(row.report_date, 10).slice(0, 7)),
    display_data: { ...baseDisplay, values: baseValues },
  };
}


function requireFinanceCapability(session: JsonRecord, capability: string, message: string): void {
  if (cleanText(session.operations_role, 40) !== "finance" || !hasAuthCapability(session, capability)) {
    throw new Error(message);
  }
}

function uuidValue(value: unknown, message: string, optional = false): string | null {
  const id = cleanText(value, 40);
  if (!id && optional) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(message);
  return id;
}

function voucherIdValues(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error("每笔财务记录必须选择 1 至 20 份已审核凭证");
  return Array.from(new Set(value.map((id) => uuidValue(id, "凭证编号无效") as string)));
}

async function financeWorkbench(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (cleanText(session.operations_role, 40) !== "finance") throw new Error("只有财务账号可以进入财务录入区");
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const month = cleanText(payload.month, 7);
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`)) throw new Error("月份无效");
  const start = `${month}-01`;
  const endDate = new Date(`${start}T00:00:00Z`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const end = endDate.toISOString().slice(0, 10);
  const [categories, expenses, pettyCash, payments, monthlyReports, vouchers, uploadedMonthlyReports, employees] = await Promise.all([
    restRowsAll(`zysyr_expense_categories?select=id,code,name,report_section,sort_order,status&company_id=eq.${companyId}&order=status.asc,sort_order.asc,name.asc&limit=1000`, 1000),
    restRowsAll(`zysyr_expense_records?select=id,expense_date,expense_category_id,category,counterparty,summary,amount,payment_method,workflow_status,submitted_at,approved_at,paid_at,daily_report_line_id&company_id=eq.${companyId}&store_id=eq.${storeId}&deleted_at=is.null&expense_date=gte.${start}&expense_date=lt.${end}&order=expense_date.desc,created_at.desc&limit=3000`, 3000),
    restRowsAll(`zysyr_petty_cash_records?select=id,transaction_date,direction,category,summary,amount,status,daily_report_line_id,confirmed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&transaction_date=gte.${start}&transaction_date=lt.${end}&order=transaction_date.desc,created_at.desc&limit=3000`, 3000),
    restRowsAll(`zysyr_payment_records?select=id,payment_date,business_type,business_id,payee,amount,payment_method,payment_reference,status,confirmed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&payment_date=gte.${start}&payment_date=lt.${end}&order=payment_date.desc,created_at.desc&limit=3000`, 3000),
    restRowsAll(`zysyr_monthly_reports?select=id,period_month,version,source_report_id,status,generated_at,reviewed_at,locked_at,reverse_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&period_month=eq.${start}&order=version.desc&limit=100`, 100),
    restRowsAll(`zysyr_voucher_attachments?select=id,original_filename,document_type,audit_status,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&audit_status=eq.approved&order=uploaded_at.desc&limit=2000`, 2000),
    restRowsAll(`zysyr_report_uploads?select=id,report_date,version,original_filename&company_id=eq.${companyId}&store_id=eq.${storeId}&report_type=eq.monthly_profit_loss&status=eq.active&report_date=eq.${start}&order=version.desc&limit=100`, 100),
    restRowsAll(`zysyr_employees?select=id,employee_code,name,position,employment_status&company_id=eq.${companyId}&store_id=eq.${storeId}&deleted_at=is.null&order=employment_status.asc,employee_code.asc&limit=1000`, 1000),
  ]);
  const reportIds = monthlyReports.map((report) => cleanText(report.id, 40));
  const monthlyLines = reportIds.length
    ? await restRowsAll(`zysyr_monthly_report_lines?select=id,monthly_report_id,line_number,metric_code,metric_name,amount,calculation_method,calculation_expression,source_count&company_id=eq.${companyId}&store_id=eq.${storeId}&monthly_report_id=in.${uuidIn(reportIds)}&order=monthly_report_id,line_number.asc&limit=5000`, 5000)
    : [];
  const paidByExpense: Record<string, number> = {};
  for (const payment of payments) {
    if (cleanText(payment.business_type, 30) === "expense" && cleanText(payment.status, 20) === "confirmed") {
      const id = cleanText(payment.business_id, 40);
      paidByExpense[id] = (paidByExpense[id] || 0) + Number(payment.amount || 0);
    }
  }
  return {
    company_id: companyId, store_id: storeId, store: cleanText(store.name, 100), month,
    categories, expenses, petty_cash: pettyCash, payments, monthly_reports: monthlyReports,
    monthly_lines: monthlyLines, approved_vouchers: vouchers,
    uploaded_monthly_reports: uploadedMonthlyReports, employees, paid_by_expense: paidByExpense,
    permissions: {
      create_expense: hasAuthCapability(session, "expense.create_submit"),
      approve_expense: hasAuthCapability(session, "expense.approve"),
      confirm_payment: hasAuthCapability(session, "payment.confirm"),
      lock_report: hasAuthCapability(session, "report.lock"),
      reverse: hasAuthCapability(session, "confirmed_finance.adjust"),
    },
    source_boundary: "finance_uploads_only", meiguanjia_used: false,
  };
}

async function pettyCashReport(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "dashboard.store.read")) throw new Error("当前账号没有备用金明细查看权限");
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const month = cleanText(payload.month, 7);
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`)) throw new Error("月份无效");
  const start = `${month}-01`;
  const endDate = new Date(`${start}T00:00:00Z`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const end = endDate.toISOString().slice(0, 10);
  const records = await restRowsAll(
    `zysyr_petty_cash_records?select=id,transaction_date,direction,category,summary,amount,voucher_number,recipient,daily_report_id,daily_report_line_id,source_report_cell_id,status,confirmed_by_user_id,confirmed_at,reversed_at,reverse_reason,created_at&company_id=eq.${companyId}&store_id=eq.${storeId}&transaction_date=gte.${start}&transaction_date=lt.${end}&order=transaction_date.desc,created_at.desc&limit=5000`,
    5000,
  );
  const recordIds = records.map((row) => cleanText(row.id, 40)).filter(Boolean);
  const dailyReportIds = Array.from(new Set(records.map((row) => cleanText(row.daily_report_id, 40)).filter(Boolean)));
  const dailyLineIds = Array.from(new Set(records.map((row) => cleanText(row.daily_report_line_id, 40)).filter(Boolean)));
  const sourceCellIds = Array.from(new Set(records.map((row) => cleanText(row.source_report_cell_id, 40)).filter(Boolean)));
  const confirmerIds = Array.from(new Set(records.map((row) => cleanText(row.confirmed_by_user_id, 40)).filter(Boolean)));
  const [voucherLinks, dailyReports, dailyLines, sourceCells, users] = await Promise.all([
    recordIds.length ? restRowsAll(`zysyr_voucher_links?select=voucher_id,business_type,business_id,relation_type,linked_at&company_id=eq.${companyId}&store_id=eq.${storeId}&business_type=eq.petty_cash_record&business_id=in.${uuidIn(recordIds)}&unlinked_at=is.null&limit=10000`, 10000) : [],
    dailyReportIds.length ? restRowsAll(`zysyr_daily_reports?select=id,report_date,version,status,source_report_id,reviewed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(dailyReportIds)}&limit=5000`, 5000) : [],
    dailyLineIds.length ? restRowsAll(`zysyr_daily_report_lines?select=id,daily_report_id,line_number,line_type,metric_code,description,amount,source_report_cell_id&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(dailyLineIds)}&limit=10000`, 10000) : [],
    sourceCellIds.length ? restRowsAll(`zysyr_report_cells?select=id,report_id,sheet_name,cell_address,row_number,column_number,display_value,numeric_value,label&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(sourceCellIds)}&limit=10000`, 10000) : [],
    confirmerIds.length ? restRowsAll(`zysyr_user_accounts?select=id,login_name,display_name&company_id=eq.${companyId}&id=in.${uuidIn(confirmerIds)}&limit=5000`, 5000) : [],
  ]);
  const voucherIds = Array.from(new Set(voucherLinks.map((link) => cleanText(link.voucher_id, 40)).filter(Boolean)));
  const vouchers = voucherIds.length ? await restRowsAll(`zysyr_voucher_attachments?select=id,original_filename,document_type,audit_status,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(voucherIds)}&limit=5000`, 5000) : [];
  const reviewRows = voucherIds.length ? await restRowsAll(`zysyr_voucher_reviews?select=voucher_id,review_version,corrected_fields&company_id=eq.${companyId}&store_id=eq.${storeId}&voucher_id=in.${uuidIn(voucherIds)}&order=review_version.desc&limit=10000`, 10000) : [];
  const voucherNumberByVoucher = new Map<string, string>();
  for (const review of reviewRows) {
    const reviewVoucherId = cleanText(review.voucher_id, 40);
    const corrected: Record<string, unknown> = (review.corrected_fields && typeof review.corrected_fields === "object")
      ? review.corrected_fields as Record<string, unknown> : {};
    const docNo = corrected.document_number ? String(corrected.document_number) : "";
    if (docNo && !voucherNumberByVoucher.has(reviewVoucherId)) voucherNumberByVoucher.set(reviewVoucherId, docNo);
  }
  for (const voucher of vouchers) voucher.document_number = voucherNumberByVoucher.get(cleanText(voucher.id, 40)) || "";
  const reportIds = Array.from(new Set([
    ...dailyReports.map((row) => cleanText(row.source_report_id, 40)),
    ...sourceCells.map((row) => cleanText(row.report_id, 40)),
  ].filter(Boolean)));
  const sourceReports = reportIds.length ? await restRowsAll(`zysyr_report_uploads?select=id,report_type,report_date,version,original_filename,uploaded_by_user_id,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(reportIds)}&limit=5000`, 5000) : [];
  const openingRows = await restRowsAll(`zysyr_cash_opening_balances?select=amount&company_id=eq.${companyId}&store_id=eq.${storeId}&month=eq.${month}&limit=1`, 1);
  const openingBalance = openingRows.length ? Number(openingRows[0].amount || 0) : 0;
  const historyEntries = await historyMonthEntries(companyId, storeId, month, "petty_cash");
  const historyEvidence = await historyEvidenceForEntries(companyId, storeId, historyEntries);
  const historyRecords = historyEntries.map((entry) => {
    const current = entry.current_payload as JsonRecord;
    return {
      id: entry.id, history_ledger_entry_id: entry.id, import_row_id: entry.import_row_id,
      transaction_date: current.transaction_date, direction: current.direction || "outflow",
      category: current.category || "未分类", summary: current.summary || "历史备用金明细",
      amount: current.amount, voucher_number: current.source_sequence || null,
      recipient: current.handled_by_name || null, status: "confirmed", confirmed_by_user_id: entry.posted_by_user_id,
      confirmed_at: entry.posted_at, source_locator: entry.source_locator, version: entry.version,
      historical: true,
    };
  });
  return {
    company_id: companyId, store_id: storeId, store: cleanText(store.name, 100), month,
    records, daily_reports: dailyReports, daily_lines: dailyLines, source_cells: sourceCells,
    source_reports: sourceReports, voucher_links: voucherLinks, vouchers, users,
    history_records: historyRecords, history_evidence: historyEvidence.evidence,
    history_evidence_links: historyEvidence.links,
    opening_balance: openingBalance,
    permissions: { read: true }, source_boundary: "finance_confirmed_records_only", meiguanjia_used: false,
  };
}

async function saveExpenseCategory(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireFinanceCapability(session, "expense.create_submit", "当前账号没有支出分类维护权限");
  const store = await selectedStoreInfo(session, payload);
  const id = uuidValue(payload.id, "支出分类编号无效", true);
  const reason = cleanText(payload.reason, 500);
  const saved = await financeRpcSaved("rpc/zysyr_upsert_expense_category", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_id: id, p_code: cleanText(payload.code, 64).toUpperCase(),
    p_name: cleanText(payload.name, 120), p_report_section: cleanText(payload.report_section, 120),
    p_sort_order: Number.isInteger(Number(payload.sort_order)) ? Number(payload.sort_order) : 0,
    p_status: cleanText(payload.status, 20) || "active", p_reason: reason || null,
  });
  return { saved };
}

async function submitExpense(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireFinanceCapability(session, "expense.create_submit", "只有财务账号可以提交正式支出");
  const store = await selectedStoreInfo(session, payload);
  const expenseDate = cleanText(payload.expense_date, 10);
  const reason = cleanText(payload.reason, 500);
  if (!validDate(expenseDate) || !reason || !cleanText(payload.summary, 500)) throw new Error("请完整填写支出日期、摘要和提交原因");
  const saved = await financeRpcSaved("rpc/zysyr_submit_expense", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_expense_date: expenseDate,
    p_expense_category_id: uuidValue(payload.expense_category_id, "请选择支出分类"),
    p_counterparty: cleanText(payload.counterparty, 160), p_summary: cleanText(payload.summary, 500),
    p_amount: amountValue(payload.amount), p_payment_method: cleanText(payload.payment_method, 80),
    p_operator_employee_id: uuidValue(payload.operator_employee_id, "经办员工无效", true),
    p_daily_report_line_id: uuidValue(payload.daily_report_line_id, "日报明细无效", true),
    p_voucher_ids: voucherIdValues(payload.voucher_ids), p_reason: reason,
  });
  return { saved, formal_source: "finance_submitted_expense", cashier_untouched: true, meiguanjia_used: false };
}

async function reviewExpense(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireFinanceCapability(session, "expense.approve", "当前账号没有支出审核权限");
  const store = await selectedStoreInfo(session, payload);
  const decision = cleanText(payload.decision, 20);
  const reason = cleanText(payload.reason, 500);
  if (!["approved", "rejected"].includes(decision) || !reason) throw new Error("请填写支出审核决定和原因");
  const saved = await financeRpcSaved("rpc/zysyr_review_expense", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_expense_id: uuidValue(payload.expense_id, "支出编号无效"),
    p_decision: decision, p_reason: reason,
  });
  return { saved };
}

async function recordPettyCash(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireFinanceCapability(session, "expense.create_submit", "只有财务账号可以登记备用金");
  const store = await selectedStoreInfo(session, payload);
  const date = cleanText(payload.transaction_date, 10);
  const direction = cleanText(payload.direction, 20);
  const reason = cleanText(payload.reason, 500);
  if (!validDate(date) || !["inflow", "outflow"].includes(direction) || !reason) throw new Error("请完整填写备用金日期、方向和原因");
  const saved = await financeRpcSaved("rpc/zysyr_record_petty_cash", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_transaction_date: date, p_direction: direction,
    p_category: cleanText(payload.category, 120), p_summary: cleanText(payload.summary, 500),
    p_amount: amountValue(payload.amount), p_daily_report_line_id: uuidValue(payload.daily_report_line_id, "日报明细无效", true),
    p_voucher_ids: voucherIdValues(payload.voucher_ids), p_reason: reason,
    p_voucher_number: cleanText(payload.voucher_number, 160) || null, p_recipient: cleanText(payload.recipient, 120) || null,
  });
  return { saved };
}

async function saveCashOpeningBalance(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireFinanceCapability(session, "expense.create_submit", "只有财务账号可以登记上月结余");
  const store = await selectedStoreInfo(session, payload);
  const month = cleanText(payload.month, 7);
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`)) throw new Error("月份无效");
  const saved = await financeRpcSaved("rpc/zysyr_upsert_cash_opening_balance", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_month: month, p_amount: amountValue(payload.amount),
  });
  return { saved };
}

async function confirmExpensePayment(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireFinanceCapability(session, "payment.confirm", "当前账号没有付款确认权限");
  const store = await selectedStoreInfo(session, payload);
  const date = cleanText(payload.payment_date, 10);
  const reason = cleanText(payload.reason, 500);
  if (!validDate(date) || !reason) throw new Error("请完整填写付款日期和确认原因");
  const saved = await financeRpcSaved("rpc/zysyr_confirm_expense_payment", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_expense_id: uuidValue(payload.expense_id, "支出编号无效"),
    p_payment_date: date, p_payee: cleanText(payload.payee, 160), p_amount: amountValue(payload.amount),
    p_payment_method: cleanText(payload.payment_method, 80), p_payment_reference: cleanText(payload.payment_reference, 100) || null,
    p_voucher_ids: voucherIdValues(payload.voucher_ids), p_reason: reason,
  });
  return { saved };
}

async function reverseFinanceRecord(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireFinanceCapability(session, "confirmed_finance.adjust", "当前账号没有已确认财务记录冲销权限");
  const store = await selectedStoreInfo(session, payload);
  const recordType = cleanText(payload.record_type, 40);
  const reason = cleanText(payload.reason, 500);
  if (!["income_record", "expense_record", "petty_cash_record", "payment_record"].includes(recordType) || !reason) throw new Error("冲销类型或原因无效");
  const saved = await financeRpcSaved("rpc/zysyr_reverse_finance_record", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_record_type: recordType,
    p_record_id: uuidValue(payload.record_id, "财务记录编号无效"), p_reason: reason,
  });
  return { saved };
}

async function generateMonthlyReport(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireFinanceCapability(session, "report.lock", "当前账号没有月报生成或锁账权限");
  const store = await selectedStoreInfo(session, payload);
  const month = cleanText(payload.month, 7);
  const reason = cleanText(payload.reason, 500);
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`) || !reason) throw new Error("请选择月份并填写生成原因");
  const saved = await financeRpcSaved("rpc/zysyr_generate_monthly_report", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_period_month: `${month}-01`,
    p_source_report_id: uuidValue(payload.source_report_id, "月报原件编号无效", true), p_reason: reason,
  });
  return { saved, meiguanjia_used: false };
}

async function transitionMonthlyReport(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const action = cleanText(payload.action, 20);
  requireFinanceCapability(session, action === "reverse" ? "confirmed_finance.adjust" : "report.lock", "当前账号没有月报审核、锁账或冲销权限");
  const store = await selectedStoreInfo(session, payload);
  const reason = cleanText(payload.reason, 500);
  if (!["review", "lock", "reverse"].includes(action) || !reason) throw new Error("请选择月报操作并填写原因");
  const saved = await financeRpcSaved("rpc/zysyr_transition_monthly_report", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_monthly_report_id: uuidValue(payload.monthly_report_id, "月报编号无效"),
    p_action: action, p_reason: reason,
  });
  return { saved };
}

async function importExpenses(_payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireFinanceCapability(session, "expense.create_submit", "当前账号没有支出录入权限");
  throw new Error("历史支出不能无凭证批量写入；请在财务录入区逐笔选择已审核凭证后提交");
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function excelCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "object") return cleanText(value, 500);
  const record = value as JsonRecord;
  if (record.result !== undefined) return excelCellText(record.result);
  if (record.formula !== undefined) return `=${cleanText(record.formula, 490)}`;
  if (Array.isArray(record.richText)) return cleanText(record.richText.map((part) => cleanText((part as JsonRecord).text, 500)).join(""), 500);
  if (record.text !== undefined) return cleanText(record.text, 500);
  if (record.hyperlink !== undefined) return cleanText(record.hyperlink, 500);
  if (record.error !== undefined) return cleanText(record.error, 500);
  return cleanText(value, 500);
}

function mergeCoordinates(text: string): JsonRecord {
  const parts = text.split(":");
  function cell(value: string): { row: number; column: number } {
    const match = value.match(/^([A-Z]+)(\d+)$/i);
    if (!match) return { row: 1, column: 1 };
    let column = 0;
    for (const letter of match[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
    return { row: Number(match[2]), column };
  }
  const from = cell(parts[0]);
  const to = cell(parts[1] || parts[0]);
  return { start_row: from.row - 1, start_col: from.column - 1, end_row: to.row - 1, end_col: to.column - 1 };
}

function columnLetters(column: number): string {
  let value = column;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function numericCellValue(value: unknown): number | null {
  const resolved = value && typeof value === "object" && (value as JsonRecord).result !== undefined
    ? (value as JsonRecord).result
    : value;
  if (typeof resolved === "number" && Number.isFinite(resolved)) return Number(resolved.toFixed(4));
  return null;
}

function formulaCellText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as JsonRecord;
  return cleanText(record.formula ?? record.sharedFormula, 2000);
}

function formulaPrecedents(formula: string, sheetName: string): string[] {
  if (!formula || formula.includes("#REF!")) return [];
  const found = new Set<string>();
  const pattern = /(?:(?:'([^']+)'|([A-Za-z0-9_\u4e00-\u9fff]+))!)?\$?([A-Z]{1,3})\$?([1-9][0-9]{0,3})(?::\$?([A-Z]{1,3})\$?([1-9][0-9]{0,3}))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(formula.toUpperCase())) !== null) {
    if (formula.slice(match.index + match[0].length).startsWith("(")) continue;
    const referencedSheet = cleanText(match[1] || match[2], 120);
    if (referencedSheet && referencedSheet !== sheetName.toUpperCase()) continue;
    const start = mergeCoordinates(`${match[3]}${match[4]}:${match[5] || match[3]}${match[6] || match[4]}`);
    const startRow = Number(start.start_row) + 1;
    const endRow = Number(start.end_row) + 1;
    const startColumn = Number(start.start_col) + 1;
    const endColumn = Number(start.end_col) + 1;
    if ((endRow - startRow + 1) * (endColumn - startColumn + 1) > 500) continue;
    for (let row = startRow; row <= endRow; row += 1) {
      for (let column = startColumn; column <= endColumn; column += 1) found.add(`${columnLetters(column)}${row}`);
    }
  }
  return Array.from(found);
}

function reportCellLabel(values: string[][], row: number, column: number): string {
  const parts: string[] = [];
  for (let cursor = column - 1; cursor >= Math.max(1, column - 6); cursor -= 1) {
    const value = cleanText(values[row - 1]?.[cursor - 1], 120);
    if (value && !/^-?\d+(?:\.\d+)?$/.test(value) && !parts.includes(value)) parts.unshift(value);
    if (parts.length >= 2) break;
  }
  for (let cursor = row - 1; cursor >= Math.max(1, row - 15); cursor -= 1) {
    const value = cleanText(values[cursor - 1]?.[column - 1], 120);
    if (value && !/^-?\d+(?:\.\d+)?$/.test(value) && !parts.includes(value)) {
      parts.push(value);
      break;
    }
  }
  return cleanText(parts.join(" / "), 300);
}

function worksheetByCleanName(workbook: ExcelJS.Workbook, requestedName: string): ExcelJS.Worksheet | undefined {
  const target = cleanText(requestedName, 120).toLocaleLowerCase();
  if (!target) return undefined;
  return workbook.worksheets.find((item) => cleanText(item.name, 120).toLocaleLowerCase() === target);
}

async function workbookDisplay(bytes: Uint8Array, reportType: string, storeName = "", requestedSheet = ""): Promise<JsonRecord> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(exactArrayBuffer(bytes));
  } catch {
    throw new Error("Excel 文件无法识别，请确认文件未损坏且为 XLSX 格式");
  }
  const preferred = reportType === "monthly_profit_loss"
    ? ["模版", "模板", "月盈亏统计"]
    : reportType === "salary"
      ? ["工资", "工资表", "工资明细"]
    : reportType === "performance"
      ? (/向里/.test(storeName) ? ["向里业绩报表", "业绩报表"] : ["业绩报表", "向里业绩报表"])
      : ["日报", "日报表"];
  const sheet = (requestedSheet ? worksheetByCleanName(workbook, requestedSheet) : undefined)
    || preferred.map((name) => worksheetByCleanName(workbook, name)).find(Boolean) || workbook.worksheets[0];
  if (!sheet) throw new Error("Excel 文件中没有可读取的工作表");
  const sheetName = cleanText(sheet.name, 120);
  const rowCount = sheet.actualRowCount || sheet.rowCount || 1;
  const columnCount = sheet.actualColumnCount || sheet.columnCount || 1;
  if (rowCount > 120 || columnCount > 30) throw new Error("报表范围过大，最多支持 120 行、30 列");
  const values = Array.from({ length: rowCount }, () => Array(columnCount).fill(""));
  for (let row = 1; row <= rowCount; row += 1) {
    for (let column = 1; column <= columnCount; column += 1) {
      values[row - 1][column - 1] = excelCellText(sheet.getCell(row, column).value);
    }
  }
  const cells: JsonRecord[] = [];
  for (let row = 1; row <= rowCount; row += 1) {
    for (let column = 1; column <= columnCount; column += 1) {
      const source = sheet.getCell(row, column).value;
      const formula = formulaCellText(source);
      const numericValue = numericCellValue(source);
      if (numericValue === null && !formula) continue;
      const address = `${columnLetters(column)}${row}`;
      const label = reportCellLabel(values, row, column);
      const numberFormat = cleanText(sheet.getCell(row, column).numFmt, 80).toLowerCase();
      if (!formula && (/(编号|序号|员工号|日期)/.test(label) || /(^|[^a-z])[ymdhis]+([^a-z]|$)/.test(numberFormat))) continue;
      cells.push({
        sheet_name: sheetName,
        cell_address: address,
        row_number: row,
        column_number: column,
        cell_kind: formula ? "formula" : "input",
        display_value: values[row - 1][column - 1],
        numeric_value: numericValue,
        formula: formula || null,
        precedent_addresses: formulaPrecedents(formula, sheetName),
        label,
      });
    }
  }
  if (!cells.length) throw new Error("Excel 中没有可追溯的数字或公式单元格");
  const model = sheet.model as unknown as JsonRecord;
  const merges = (Array.isArray(model.merges) ? model.merges : []).map((merge) => mergeCoordinates(cleanText(merge, 40)));
  const columnWidths = Array.from({ length: columnCount }, (_item, index) =>
    Math.max(2, Math.min(80, Number(sheet.getColumn(index + 1).width || 10))));
  const rowHeights = Array.from({ length: rowCount }, (_item, index) =>
    Math.max(12, Math.min(120, Number(sheet.getRow(index + 1).height || 20))));
  const cellStyles: JsonRecord[] = [];
  for (let row = 1; row <= rowCount; row += 1) {
    for (let column = 1; column <= columnCount; column += 1) {
      const cell = sheet.getCell(row, column);
      const fill = cell.fill as unknown as { fgColor?: { argb?: string } };
      const fillArgb = cleanText(fill?.fgColor?.argb, 8);
      const horizontal = cleanText(cell.alignment?.horizontal, 30);
      const vertical = cleanText(cell.alignment?.vertical, 30);
      const bold = cell.font?.bold === true;
      const wrapText = cell.alignment?.wrapText === true;
      if (!fillArgb && !horizontal && !vertical && !bold && !wrapText) continue;
      cellStyles.push({
        cell_address: `${columnLetters(column)}${row}`,
        fill: /^[0-9A-F]{8}$/i.test(fillArgb) ? fillArgb : null,
        horizontal: horizontal || null,
        vertical: vertical || null,
        bold,
        wrap_text: wrapText,
      });
    }
  }
  const rangeText = `A1:${sheet.getCell(rowCount, columnCount).address}`;
  return {
    sheet_name: sheetName, range: rangeText, rows: rowCount, columns: columnCount,
    values, merges, cells, column_widths: columnWidths, row_heights: rowHeights,
    cell_styles: cellStyles,
  };
}

function xmlText(value: string): string {
  return value
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/[\t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

function docxNumericValue(value: string): number | null {
  const compact = value.replace(/[\s,，]/g, "");
  if (!compact || /\d{4}[-/.年]\d{1,2}/.test(compact)) return null;
  const negative = /^\(.*\)$/.test(compact);
  const normalized = compact.replace(/[()￥¥元]/g, "");
  const percent = normalized.endsWith("%");
  const numberText = percent ? normalized.slice(0, -1) : normalized;
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(numberText)) return null;
  let numeric = Number(numberText);
  if (!Number.isFinite(numeric)) return null;
  if (negative) numeric = -Math.abs(numeric);
  if (percent) numeric /= 100;
  return Math.round(numeric * 10000) / 10000;
}

async function docxDisplay(bytes: Uint8Array): Promise<JsonRecord> {
  let documentXml = "";
  try {
    const archive = await JSZip.loadAsync(exactArrayBuffer(bytes));
    const entry = archive.file("word/document.xml");
    if (!entry) throw new Error("missing word/document.xml");
    documentXml = await entry.async("string");
  } catch {
    throw new Error("Word 文件无法识别，请确认文件未损坏且为 DOCX 格式");
  }
  const tables = documentXml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>/g) || [];
  if (!tables.length) throw new Error("Word 文档中没有表格；请上传含可编辑表格的 DOCX，扫描图片只能作为凭证留底");
  const matrix: string[][] = [];
  const merges: JsonRecord[] = [];
  tables.forEach((table, tableIndex) => {
    if (tableIndex && matrix.length < 120) matrix.push([]);
    const rows = table.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
    rows.forEach((rowXml) => {
      if (matrix.length >= 120) return;
      const output: string[] = [];
      const cells = rowXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || [];
      cells.forEach((cellXml) => {
        if (output.length >= 30) return;
        const spanMatch = cellXml.match(/<w:gridSpan\b[^>]*w:val="(\d+)"[^>]*\/?\s*>/);
        const span = Math.max(1, Math.min(30 - output.length, Number(spanMatch?.[1] || 1)));
        const paragraphs = cellXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
        const text = paragraphs.map(xmlText).filter(Boolean).join("\n");
        const startColumn = output.length + 1;
        output.push(text);
        for (let index = 1; index < span; index += 1) output.push("");
        if (span > 1) merges.push({
          start_row: matrix.length, start_col: startColumn - 1,
          end_row: matrix.length, end_col: startColumn + span - 2,
        });
      });
      matrix.push(output.slice(0, 30));
    });
  });
  const rowCount = matrix.length;
  const columnCount = Math.max(1, ...matrix.map((row) => row.length));
  if (!rowCount || rowCount > 120 || columnCount > 30) throw new Error("Word 表格范围过大，最多支持 120 行、30 列");
  const values = matrix.map((row) => Array.from({ length: columnCount }, (_item, index) => row[index] || ""));
  const cells: JsonRecord[] = [];
  for (let row = 1; row <= rowCount; row += 1) {
    for (let column = 1; column <= columnCount; column += 1) {
      const displayValue = values[row - 1][column - 1];
      const numericValue = docxNumericValue(displayValue);
      if (numericValue === null) continue;
      cells.push({
        sheet_name: "Word表格", cell_address: `${columnLetters(column)}${row}`,
        row_number: row, column_number: column, cell_kind: "input",
        display_value: displayValue, numeric_value: numericValue, formula: null,
        precedent_addresses: [], label: reportCellLabel(values, row, column),
      });
    }
  }
  if (!cells.length) throw new Error("Word 表格中没有可追溯的数字；请确认金额位于可编辑表格单元格中");
  return {
    sheet_name: "Word表格", range: `A1:${columnLetters(columnCount)}${rowCount}`,
    rows: rowCount, columns: columnCount, values, merges, cells,
    source_format: "docx", table_count: tables.length,
  };
}

function reportDateValue(payload: JsonRecord, reportType: string): string {
  const raw = cleanText(payload.report_date, 10);
  if (reportType === "monthly_profit_loss" || reportType === "salary") {
    const month = /^\d{4}-\d{2}$/.test(raw) ? raw : cleanText(payload.month, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("请选择月报月份");
    return `${month}-01`;
  }
  if (!validDate(raw)) throw new Error("请选择报表日期");
  return raw;
}

async function uploadReport(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!canUploadReports(session)) throw new Error("只有财务账号可以上传门店报表");
  const store = await selectedStoreInfo(session, payload);
  const reportType = cleanText(payload.report_type, 40);
  if (!["daily", "performance", "salary", "monthly_profit_loss"].includes(reportType)) throw new Error("报表类型无效");
  const reportDate = reportDateValue(payload, reportType);
  const filename = cleanText(payload.filename, 200);
  const mime = cleanText(payload.mime_type, 120);
  const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (![xlsxMime, docxMime].includes(mime)) throw new Error("日报、业绩表、工资表和月度盈亏表请上传 XLSX 或 DOCX 文件");
  if (mime === xlsxMime && !/\.xlsx$/i.test(filename)) throw new Error("文件扩展名与 XLSX 格式不一致");
  if (mime === docxMime && !/\.docx$/i.test(filename)) throw new Error("文件扩展名与 DOCX 格式不一致；旧版 DOC 文件请先另存为 DOCX");
  let bytes: Uint8Array;
  try { bytes = decodeBase64(cleanText(payload.base64, 15000000)); } catch { throw new Error("报表文件内容无效"); }
  if (!bytes.length || bytes.length > MAX_REPORT_BYTES) throw new Error("报表文件必须小于 10MB");
  const displayData = mime === docxMime
    ? await docxDisplay(bytes)
    : await workbookDisplay(bytes, reportType, cleanText(store.name, 100));
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const accountId = cleanText(session.auth_account_id, 40);
  if (!companyId || !storeId || !accountId) throw new Error("财务账号公司、门店或身份范围无效");
  const extension = mime === docxMime ? "docx" : "xlsx";
  const objectPath = `${companyId}/${storeId}/${reportType}/${reportDate}/${crypto.randomUUID()}.${extension}`;
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${REPORT_BUCKET}/${storagePath(objectPath)}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": mime, "x-upsert": "false" },
    body: exactArrayBuffer(bytes),
  });
  if (!upload.ok) throw new Error(`报表原件上传失败 (${upload.status})`);
  const metadata = await rest("rpc/zysyr_register_report_upload", {
    method: "POST",
    body: JSON.stringify({
      p_report: {
        company_id: companyId, store_id: storeId, report_type: reportType, report_date: reportDate,
        template_code: reportType === "monthly_profit_loss" ? "zysyr_monthly_profit_loss_original" : `zysyr_${reportType}_original`,
        template_version: 1, original_filename: filename || `report.${extension}`, mime_type: mime,
        size_bytes: bytes.length, sha256: await sha256Bytes(bytes), bucket_id: REPORT_BUCKET,
        object_path: objectPath, display_data: displayData, uploaded_by_user_id: accountId,
      },
      p_cells: Array.isArray(displayData.cells) ? displayData.cells : [],
    }),
  });
  if (!metadata.ok) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${REPORT_BUCKET}/${storagePath(objectPath)}`, {
      method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    throw new Error(`报表登记失败 (${metadata.status})`);
  }
  const saved = await metadata.json() as JsonRecord;
  return { saved, source_boundary: "finance_uploads_only", original_private: true };
}

function uuidArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("追溯选择数量无效");
  const items = value.map((item) => cleanText(item, 40));
  if (items.some((item) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item))) {
    throw new Error("追溯记录标识无效");
  }
  return Array.from(new Set(items));
}

async function reportCells(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const reportId = cleanText(payload.report_id, 40);
  const reports = await restRows(`zysyr_report_uploads?select=id,report_type,report_date,version,original_filename,uploaded_by_user_id,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${encodeURIComponent(reportId)}&limit=1`);
  const report = reports[0];
  if (!report) throw new Error("报表不存在或无权访问");
  const [cells, vouchers, uploaders] = await Promise.all([
    restRowsAll(`zysyr_report_cells?select=id,sheet_name,cell_address,row_number,column_number,cell_kind,display_value,numeric_value,formula,label&company_id=eq.${companyId}&store_id=eq.${storeId}&report_id=eq.${reportId}&order=row_number.asc,column_number.asc`, 5000),
    restRowsAll(`zysyr_voucher_attachments?select=id,original_filename,mime_type,note,uploaded_by,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&record_type=eq.report&record_id=eq.${reportId}&order=uploaded_at.asc`, 1000),
    restRows(`zysyr_user_accounts?select=id,login_name,display_name&id=eq.${cleanText(report.uploaded_by_user_id, 40)}&limit=1`),
  ]);
  return { report: { ...report, uploaded_by: uploaders[0] || null }, cells, vouchers };
}

async function businessEvidenceRulesForDetails(
  companyId: string,
  storeId: string,
  details: JsonRecord[],
): Promise<JsonRecord[]> {
  const ids = Array.from(new Set(details.map((row) => cleanText(row.business_id, 40)).filter(Boolean)));
  if (!ids.length) return details;
  const rules = await restRowsAll(`zysyr_business_evidence_rules?select=id,business_type,business_id,evidence_policy,reason,updated_by_user_id,updated_at&company_id=eq.${companyId}&store_id=eq.${storeId}&business_id=in.${uuidIn(ids)}&limit=10000`, 10000);
  const ruleMap = new Map(rules.map((rule) => [
    `${cleanText(rule.business_type, 60)}:${cleanText(rule.business_id, 40)}`, rule,
  ]));
  return details.map((detail) => {
    const rule = ruleMap.get(`${cleanText(detail.business_type, 60)}:${cleanText(detail.business_id, 40)}`) || null;
    return { ...detail, evidence_policy: cleanText(rule?.evidence_policy, 30) || "voucher_required", evidence_rule: rule };
  });
}

async function monthlyCellBusinessDetails(
  companyId: string,
  storeId: string,
  periodMonth: string,
  labelValue: unknown,
): Promise<JsonRecord[]> {
  const label = cleanText(labelValue, 300);
  const compactLabel = label.replace(/[\s/／·]/g, "");
  const start = `${periodMonth.slice(0, 7)}-01`;
  const endDate = new Date(`${start}T00:00:00Z`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const end = endDate.toISOString().slice(0, 10);
  const details: JsonRecord[] = [];

  if (/(美发收入|普通美发产品|产品收入|零售收入|其他收入)/.test(label)) {
    const rows = await restRowsAll(`zysyr_income_records?select=id,income_date,category_code,summary,amount,payment_method,daily_report_id,daily_report_line_id,status,approved_at&company_id=eq.${companyId}&store_id=eq.${storeId}&income_date=gte.${start}&income_date=lt.${end}&status=eq.approved&order=income_date.asc,created_at.asc&limit=5000`, 5000);
    const matched = rows.filter((row) => {
      const code = cleanText(row.category_code, 80).toUpperCase();
      const summary = cleanText(row.summary, 200);
      if (/美发收入/.test(label)) return code === "INCOME_SERVICE" || /美发|服务/.test(summary);
      if (/(普通美发产品|产品收入|零售收入)/.test(label)) return /RETAIL|PRODUCT/.test(code) || /产品|零售/.test(summary);
      return /OTHER/.test(code) || /其他/.test(summary);
    });
    for (const row of matched) details.push({
      business_type: "income_record", business_id: row.id, business_date: row.income_date,
      category: row.summary, description: [row.category_code, row.payment_method].filter(Boolean).join(" · "),
      amount: row.amount, status: row.status, raw: row,
      voucher_targets: [
        { business_type: "income_record", business_id: row.id },
        { business_type: "daily_report", business_id: row.daily_report_id },
        { business_type: "daily_report_line", business_id: row.daily_report_line_id },
      ],
    });
  }

  const categories = await restRowsAll(`zysyr_expense_categories?select=id,name,report_section&company_id=eq.${companyId}&status=eq.active&limit=1000`, 1000);
  const matchedCategoryIds = categories.filter((category) => {
    const name = cleanText(category.name, 120).replace(/\s/g, "");
    const section = cleanText(category.report_section, 120).replace(/\s/g, "");
    return (name.length >= 2 && compactLabel.includes(name)) || (section.length >= 2 && compactLabel.includes(section));
  }).map((category) => category.id);
  if (matchedCategoryIds.length) {
    const expenses = await restRowsAll(`zysyr_expense_records?select=id,expense_date,category,counterparty,summary,amount,payment_method,workflow_status,submitted_at,approved_at,paid_at&company_id=eq.${companyId}&store_id=eq.${storeId}&deleted_at=is.null&workflow_status=in.(approved,paid)&expense_category_id=in.${uuidIn(matchedCategoryIds)}&expense_date=gte.${start}&expense_date=lt.${end}&order=expense_date.asc,created_at.asc&limit=3000`, 3000);
    for (const row of expenses) details.push({
      business_type: "expense_record", business_id: row.id, business_date: row.expense_date,
      category: row.category, description: [row.counterparty, row.summary].filter(Boolean).join(" · "),
      amount: row.amount, status: row.workflow_status, raw: row,
    });
  }
  if (/备用金/.test(label)) {
    const rows = await restRowsAll(`zysyr_petty_cash_records?select=id,transaction_date,direction,category,summary,amount,voucher_number,recipient,status,confirmed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&transaction_date=gte.${start}&transaction_date=lt.${end}&direction=eq.outflow&status=eq.confirmed&order=transaction_date.asc,created_at.asc&limit=3000`, 3000);
    for (const row of rows) details.push({
      business_type: "petty_cash_record", business_id: row.id, business_date: row.transaction_date,
      category: row.category, description: [row.summary, row.recipient].filter(Boolean).join(" · "),
      amount: row.amount, status: row.status, raw: row,
    });
  }
  if (/(人工|技术人员|后勤人员|工资|社保|底薪|提成)/.test(label)) {
    const salaries = await restRowsAll(`zysyr_salaries?select=id,employee_id,salary_month,version,status,base_salary,commission_amount,bonus_amount,deduction_amount,social_security,other_adjustment,final_salary,source_report_id,approved_at,paid_at&company_id=eq.${companyId}&store_id=eq.${storeId}&salary_month=eq.${start}&status=in.(approved,paid)&order=employee_id.asc,version.desc&limit=3000`, 3000);
    const employeeIds = Array.from(new Set(salaries.map((row) => row.employee_id)));
    const employees = employeeIds.length ? await restRowsAll(`zysyr_employees?select=id,employee_code,name,position&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(employeeIds)}&limit=3000`, 3000) : [];
    const employeeMap = new Map(employees.map((row) => [cleanText(row.id, 40), row]));
    const matchedEmployeeIds = new Set(employees
      .filter((employee) => {
        const employeeName = cleanText(employee.name, 120).replace(/\s/g, "");
        return employeeName.length >= 2 && compactLabel.includes(employeeName);
      })
      .map((employee) => cleanText(employee.id, 40)));
    const technicalPosition = (employee: JsonRecord): boolean => /发型师|技师|助理/.test(cleanText(employee.position, 120));
    for (const row of salaries) {
      const employee = employeeMap.get(cleanText(row.employee_id, 40)) || {};
      if (matchedEmployeeIds.size && !matchedEmployeeIds.has(cleanText(row.employee_id, 40))) continue;
      if (!matchedEmployeeIds.size && /技术人员/.test(label) && !technicalPosition(employee)) continue;
      if (!matchedEmployeeIds.size && /后勤人员/.test(label) && technicalPosition(employee)) continue;
      const amount = /社保/.test(label) ? row.social_security
        : /底薪/.test(label) ? row.base_salary
          : /提成/.test(label) ? row.commission_amount : row.final_salary;
      details.push({
        business_type: "salary", business_id: row.id, business_date: row.salary_month,
        category: "工资", description: `${cleanText(employee.employee_code, 40)} ${cleanText(employee.name, 120)} · ${cleanText(employee.position, 120)}`.trim(),
        amount, status: row.status, raw: row,
      });
    }
  }
  if (/(产品进货|采购|进货)/.test(label)) {
    const rows = await restRowsAll(`zysyr_goods_receipts?select=id,purchase_order_id,receipt_number,receipt_date,status,total_amount,posted_at&company_id=eq.${companyId}&store_id=eq.${storeId}&receipt_date=gte.${start}&receipt_date=lt.${end}&status=eq.posted&order=receipt_date.asc,created_at.asc&limit=3000`, 3000);
    const orderIds = Array.from(new Set(rows.map((row) => row.purchase_order_id)));
    const orders = orderIds.length ? await restRowsAll(`zysyr_purchase_orders?select=id,supplier_id,order_number&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(orderIds)}&limit=3000`, 3000) : [];
    const orderMap = new Map(orders.map((row) => [cleanText(row.id, 40), row]));
    const supplierIds = Array.from(new Set(orders.map((row) => row.supplier_id)));
    const suppliers = supplierIds.length ? await restRowsAll(`zysyr_suppliers?select=id,name&company_id=eq.${companyId}&id=in.${uuidIn(supplierIds)}&limit=3000`, 3000) : [];
    const supplierMap = new Map(suppliers.map((row) => [cleanText(row.id, 40), row]));
    for (const row of rows) {
      const order = orderMap.get(cleanText(row.purchase_order_id, 40)) || {};
      details.push({
      business_type: "goods_receipt", business_id: row.id, business_date: row.receipt_date,
      category: "产品进货", description: `${cleanText(supplierMap.get(cleanText(order.supplier_id, 40))?.name, 120)} · ${cleanText(order.order_number, 120)} · 入库 ${cleanText(row.receipt_number, 120)}`,
      amount: row.total_amount, status: row.status, raw: row,
    });
    }
  }
  if (/(产品成本|消耗品|消耗成本|美发消耗|日用消耗|食品成本)/.test(label)) {
    const rows = await restRowsAll(`zysyr_usage_records?select=id,product_id,employee_id,usage_date,usage_type,quantity,unit_cost,total_cost,notes,status,confirmed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&usage_date=gte.${start}&usage_date=lt.${end}&status=eq.confirmed&order=usage_date.asc,created_at.asc&limit=5000`, 5000);
    const productIds = Array.from(new Set(rows.map((row) => row.product_id)));
    const products = productIds.length ? await restRowsAll(`zysyr_products?select=id,name,category,unit&company_id=eq.${companyId}&id=in.${uuidIn(productIds)}&limit=5000`, 5000) : [];
    const productMap = new Map(products.map((row) => [cleanText(row.id, 40), row]));
    for (const row of rows) {
      const product = productMap.get(cleanText(row.product_id, 40)) || {};
      details.push({
        business_type: "usage_record", business_id: row.id, business_date: row.usage_date,
        category: cleanText(product.category, 120) || "产品消耗", description: `${cleanText(product.name, 160)} · 数量 ${row.quantity} ${cleanText(product.unit, 40)}`.trim(),
        amount: row.total_cost, status: row.status, raw: row,
      });
    }
  }
  if (/(员工自购|自购)/.test(label)) {
    const rows = await restRowsAll(`zysyr_employee_purchases?select=id,employee_id,product_id,purchase_date,quantity,unit_price,amount,inventory_cost,payment_status,paid_amount,status,approved_at&company_id=eq.${companyId}&store_id=eq.${storeId}&purchase_date=gte.${start}&purchase_date=lt.${end}&status=eq.approved&order=purchase_date.asc,created_at.asc&limit=3000`, 3000);
    for (const row of rows) details.push({
      business_type: "employee_purchase", business_id: row.id, business_date: row.purchase_date,
      category: "员工自购", description: `数量 ${row.quantity} · 已收 ${row.paid_amount}`,
      amount: row.amount, status: row.payment_status, raw: row,
    });
  }
  const unique = Array.from(new Map(details.map((row) => [`${row.business_type}:${row.business_id}`, row])).values());
  const linkTargets = unique.flatMap((row) => Array.isArray(row.voucher_targets) && row.voucher_targets.length
    ? row.voucher_targets as JsonRecord[]
    : [{ business_type: row.business_type, business_id: row.business_id }]);
  const ids = linkTargets.map((row) => row.business_id);
  const links = ids.length ? await restRowsAll(`zysyr_voucher_links?select=voucher_id,business_type,business_id,relation_type,linked_at&company_id=eq.${companyId}&store_id=eq.${storeId}&business_id=in.${uuidIn(ids)}&unlinked_at=is.null&limit=10000`, 10000) : [];
  const pendingRequests = ids.length ? await restRowsAll(`zysyr_business_voucher_link_requests?select=id,voucher_id,business_type,business_id,relation_type,status,reason,requested_by_user_id,requested_at&company_id=eq.${companyId}&store_id=eq.${storeId}&business_id=in.${uuidIn(ids)}&status=eq.pending&limit=10000`, 10000) : [];
  const voucherIds = Array.from(new Set([...links, ...pendingRequests].map((row) => row.voucher_id)));
  const vouchers = voucherIds.length ? await restRowsAll(`zysyr_voucher_attachments?select=id,original_filename,mime_type,document_type,audit_status,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(voucherIds)}&limit=10000`, 10000) : [];
  const voucherMap = new Map(vouchers.map((row) => [cleanText(row.id, 40), row]));
  const withVouchers = unique.map((detail) => {
    const detailTargets = Array.isArray(detail.voucher_targets) && detail.voucher_targets.length
      ? detail.voucher_targets as JsonRecord[]
      : [{ business_type: detail.business_type, business_id: detail.business_id }];
    const detailVoucherMap = new Map<string, JsonRecord>();
    for (const link of links.filter((link) => detailTargets.some((target) =>
        cleanText(link.business_type, 60) === cleanText(target.business_type, 60)
        && cleanText(link.business_id, 40) === cleanText(target.business_id, 40)))) {
      const voucher = voucherMap.get(cleanText(link.voucher_id, 40));
      if (voucher) detailVoucherMap.set(cleanText(voucher.id, 40), voucher);
    }
    const detailPending = pendingRequests.filter((request) => detailTargets.some((target) =>
      cleanText(request.business_type, 60) === cleanText(target.business_type, 60)
      && cleanText(request.business_id, 40) === cleanText(target.business_id, 40)))
      .map((request) => ({ ...request, voucher: voucherMap.get(cleanText(request.voucher_id, 40)) || null }));
    return { ...detail, vouchers: Array.from(detailVoucherMap.values()), pending_vouchers: detailPending };
  });
  return businessEvidenceRulesForDetails(companyId, storeId, withVouchers);
}

function historyBusinessAmount(entry: JsonRecord, monthlyLabel: string): number | null {
  const current = entry.current_payload && typeof entry.current_payload === "object" ? entry.current_payload as JsonRecord : {};
  const label = monthlyLabel.replace(/\s+/g, "");
  if (entry.entry_type === "salary") {
    const employee = cleanText(current.employee_name, 120).replace(/\s+/g, "");
    if (employee && !label.includes(employee) && !/(人工|工资|技术人员|后勤)/.test(label)) return null;
    const field = /社保/.test(label) ? "social_security"
      : /成本/.test(label) ? "product_cost"
        : /底薪/.test(label) ? "base_salary"
          : /提成/.test(label) ? "performance_commission"
            : /扣款|成长|迟到|请假/.test(label) ? "total_deduction" : "net_pay";
    const value = Number(current[field]);
    return Number.isFinite(value) ? value : null;
  }
  if (entry.entry_type === "petty_cash") {
    const category = cleanText(current.category, 120).replace(/\s+/g, "");
    const summary = cleanText(current.summary, 200).replace(/\s+/g, "");
    if (category && !label.includes(category) && !category.includes(label) && !label.includes("备用金") && !summary.includes(label)) return null;
    const value = Number(current.amount); return Number.isFinite(value) ? value : null;
  }
  if (entry.entry_type === "employee_purchase") {
    const employee = cleanText(current.employee_name, 120).replace(/\s+/g, "");
    const product = cleanText(current.product_name, 160).replace(/\s+/g, "");
    if (!/自购|外卖/.test(label) && !(employee && label.includes(employee)) && !(product && label.includes(product))) return null;
    const value = Number(current.employee_purchase_price); return Number.isFinite(value) ? value : null;
  }
  return null;
}

async function historicalDailyIncomeSources(companyId: string, storeId: string, month: string, monthlyLabel: string): Promise<JsonRecord> {
  if (!/(美发收入|营业收入)/.test(monthlyLabel.replace(/\s+/g, ""))) return { details: [], evidence: [], total: 0 };
  const start = `${month}-01`;
  const next = new Date(`${start}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const end = next.toISOString().slice(0, 10);
  const drafts = await restRowsAll(`zysyr_daily_sheet_drafts?select=id,source_voucher_id,report_date,status,validation_result,edit_revision,confirmed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&report_date=gte.${start}&report_date=lt.${end}&source_voucher_id=not.is.null&order=report_date.asc&limit=100`, 100);
  const draftIds = drafts.map((row) => cleanText(row.id, 40)).filter(Boolean);
  if (!draftIds.length) return { details: [], evidence: [], total: 0 };
  const cells = await restRowsAll(`zysyr_daily_sheet_cells?select=draft_id,corrected_numeric,manual_override&company_id=eq.${companyId}&store_id=eq.${storeId}&draft_id=in.${uuidIn(draftIds)}&section_code=eq.summary&row_key=eq.summary&column_code=eq.actual_total&cell_role=eq.summary_actual&manual_override=eq.true&limit=100`, 100);
  const amountByDraft = new Map(cells.map((cell) => [cleanText(cell.draft_id, 40), Number(cell.corrected_numeric)]));
  const verifiedDrafts = drafts.filter((draft) => Number.isFinite(amountByDraft.get(cleanText(draft.id, 40))));
  const voucherIds = Array.from(new Set(verifiedDrafts.map((draft) => cleanText(draft.source_voucher_id, 40)).filter(Boolean)));
  const vouchers = voucherIds.length ? await restRowsAll(`zysyr_voucher_attachments?select=id,original_filename,mime_type,size_bytes,uploaded_at,document_type,audit_status&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(voucherIds)}&audit_status=eq.approved&limit=100`, 100) : [];
  const voucherMap = new Map(vouchers.map((voucher) => [cleanText(voucher.id, 40), voucher]));
  const details = verifiedDrafts.map((draft) => ({
    business_type: "daily_sheet", business_id: draft.id, daily_sheet_id: draft.id,
    date: draft.report_date, title: `${draft.report_date} 日报`, description: "原始日报人工录入总额",
    amount: amountByDraft.get(cleanText(draft.id, 40)), source_voucher_id: draft.source_voucher_id,
    source_locator: `日报/${draft.report_date}`, status: draft.status, validation_result: draft.validation_result,
  }));
  const evidence = verifiedDrafts.map((draft) => {
    const voucher = voucherMap.get(cleanText(draft.source_voucher_id, 40));
    return voucher ? {
      ...voucher, evidence_source: "voucher_attachment", trace_link_level: "page_confirmed",
      trace_source_locator: `日报/${draft.report_date}`, trace_source_locators: [`日报/${draft.report_date}`],
      trace_missing_exact_count: 0, trace_asset_count: 1, daily_sheet_id: draft.id, report_date: draft.report_date,
    } : null;
  }).filter(Boolean) as JsonRecord[];
  return { details, evidence, total: Number(details.reduce((sum, row) => sum + Number(row.amount || 0), 0).toFixed(4)) };
}

async function historicalCellTrace(companyId: string, storeId: string, reportId: string, address: string, session: JsonRecord): Promise<JsonRecord> {
  const batches = await restRows(`zysyr_history_import_batches?select=id,source_filename,created_by_user_id,created_at,confirmed_by_user_id,confirmed_at,period_start,period_end&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${reportId}&import_type=eq.monthly_profit_loss&status=eq.completed&limit=1`);
  const batch = batches[0];
  if (!batch) throw new Error("月报不存在或无权访问");
  const month = cleanText((session as JsonRecord).__trace_month, 7);
  const entries = effectiveHistoryMonthlyEntries(await historyMonthEntries(companyId, storeId, month, "monthly_profit_loss"));
  const entry = entries.find((row) => cleanText((row.current_payload as JsonRecord)?.cell_address, 20).toUpperCase() === address);
  if (!entry) throw new Error("该位置不是可追溯的历史金额或公式单元格");
  const current = entry.current_payload as JsonRecord;
  const locator = cleanText(entry.source_locator, 120);
  const rowMatch = address.match(/(\d+)$/), columnMatch = address.match(/^([A-Z]+)/);
  const columnNumber = columnMatch ? columnMatch[1].split("").reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) : 0;
  const revisionRows = await restRowsAll(`zysyr_history_ledger_revisions?select=id,version,action,before_payload,after_payload,reason,actor_user_id,created_at&company_id=eq.${companyId}&store_id=eq.${storeId}&ledger_entry_id=eq.${cleanText(entry.id, 40)}&order=version.desc&limit=500`, 500);
  const actorIds = Array.from(new Set(revisionRows.map((row) => row.actor_user_id).filter(Boolean)));
  const actors = actorIds.length ? await restRowsAll(`zysyr_user_accounts?select=id,login_name,display_name&company_id=eq.${companyId}&id=in.${uuidIn(actorIds)}&limit=500`, 500) : [];
  const actorMap = new Map(actors.map((row) => [cleanText(row.id, 40), row]));
  const evidenceData = await historyEvidenceForEntries(companyId, storeId, [entry]);
  const target = {
    id: entry.id, historical_ledger_entry_id: entry.id, sheet_name: entry.source_sheet,
    cell_address: address, row_number: Number(rowMatch?.[1] || 0), column_number: columnNumber,
    cell_kind: current.cell_kind, display_value: current.amount, numeric_value: current.amount,
    original_numeric_value: (entry.posted_payload as JsonRecord)?.amount, formula: current.formula,
    precedent_addresses: formulaPrecedents(cleanText(current.formula, 2000), cleanText(entry.source_sheet, 120)),
    label: current.label, source_locator: locator,
  };
  const ruleRows = await monthlyEvidenceRules(companyId, storeId, "history_original_v1");
  const evidencePolicy = monthlyEvidencePolicyMap([target], ruleRows)[address] || defaultMonthlyEvidencePolicy(target);
  const report = {
    id: batch.id, historical: true, report_type: "monthly_profit_loss", report_date: `${month}-01`,
    version: entry.version, original_filename: batch.source_filename,
    uploaded_by_user_id: batch.confirmed_by_user_id || batch.created_by_user_id,
    uploaded_at: batch.confirmed_at || batch.created_at,
  };
  const result: JsonRecord = {
    target, report, historical: true,
    can_edit: cleanText(session.operations_role, 40) === "finance" && hasAuthCapability(session, "confirmed_finance.adjust"),
    can_upload_vouchers: cleanText(session.operations_role, 40) === "finance" && canWriteExpense(session),
    can_manage_business_evidence_rules: cleanText(session.operations_role, 40) === "finance" && hasAuthCapability(session, "confirmed_finance.adjust"),
    can_manage_evidence_rules: hasAuthCapability(session, "finance_account.create"),
    evidence_policy: evidencePolicy,
    evidence_rule: ruleRows.find((rule) => cleanText(rule.cell_address, 20).toUpperCase() === address) || null,
    amount_history: revisionRows.map((row) => ({
      id: row.id, revision: row.version, revision_type: row.action,
      before_amount: (row.before_payload as JsonRecord)?.amount,
      after_amount: (row.after_payload as JsonRecord)?.amount,
      delta: Number((row.after_payload as JsonRecord)?.amount || 0) - Number((row.before_payload as JsonRecord)?.amount || 0),
      reason: row.reason, actor_user_id: row.actor_user_id, actor: actorMap.get(cleanText(row.actor_user_id, 40)) || null,
      created_at: row.created_at,
    })),
    evidence: historyEvidenceWithScope(evidenceData),
    history_evidence_links: evidenceData.links,
  };
  if (cleanText(current.cell_kind, 20) === "formula") {
    const precedents = target.precedent_addresses as string[];
    result.mode = "formula";
    result.precedents = entries.filter((row) => precedents.includes(cleanText((row.current_payload as JsonRecord)?.cell_address, 20).toUpperCase())).map((row) => {
      const item = row.current_payload as JsonRecord;
      return { id: row.id, historical_ledger_entry_id: row.id, cell_address: item.cell_address, cell_kind: item.cell_kind,
        display_value: item.amount, numeric_value: item.amount, formula: item.formula, label: item.label, source_locator: row.source_locator };
    });
    const byAddress = new Map(entries.map((row) => [cleanText((row.current_payload as JsonRecord)?.cell_address, 20).toUpperCase(), row]));
    const seen = new Set<string>();
    const leaves: JsonRecord[] = [];
    function visit(ref: string): void {
      if (seen.has(ref)) return;
      seen.add(ref);
      const row = byAddress.get(ref);
      if (!row) return;
      const item = row.current_payload as JsonRecord;
      if (item.cell_kind === "formula") {
        formulaPrecedents(cleanText(item.formula, 2000), cleanText(row.source_sheet, 120)).forEach(visit);
      } else if (item.amount !== null && item.amount !== "" && Number.isFinite(Number(item.amount))) {
        leaves.push({ id: row.id, historical_ledger_entry_id: row.id, cell_address: ref,
          cell_kind: item.cell_kind, numeric_value: item.amount, label: item.label });
      }
    }
    precedents.forEach(visit);
    result.editable_components = leaves;
    return result;
  }
  const moduleEntries = await historyMonthEntries(companyId, storeId, month);
  const ledgerMatched = moduleEntries.filter((row) => row.entry_type !== "monthly_profit_loss").map((row) => {
    const amount = historyBusinessAmount(row, cleanText(current.label, 300));
    return amount === null ? null : { business_type: `history_${row.entry_type}`, business_id: row.id, history_ledger_entry_id: row.id,
      date: (row.current_payload as JsonRecord)?.transaction_date || row.period_month,
      title: (row.current_payload as JsonRecord)?.employee_name || (row.current_payload as JsonRecord)?.summary || (row.current_payload as JsonRecord)?.product_name || row.entry_type,
      description: row.source_locator, amount, source_locator: row.source_locator, import_row_id: row.import_row_id };
  }).filter(Boolean) as JsonRecord[];
  const dailyIncome = await historicalDailyIncomeSources(companyId, storeId, month, cleanText(current.label, 300));
  const dailyReconciled = (dailyIncome.details as JsonRecord[]).length > 0
    && Math.abs(Number(dailyIncome.total || 0) - Number(current.amount || 0)) <= 0.01;
  const matched = dailyReconciled ? dailyIncome.details as JsonRecord[] : ledgerMatched.length ? ledgerMatched : [{
    business_type: "history_monthly_profit_loss", business_id: entry.id,
    history_ledger_entry_id: entry.id, date: `${month}-01`, title: cleanText(current.label, 300) || address,
    description: `月报直接录入 · ${locator}`, amount: current.amount,
    source_locator: locator, import_row_id: entry.import_row_id,
  }];
  const detailEvidence = ledgerMatched.length ? await historyEvidenceForEntries(companyId, storeId, moduleEntries.filter((row) => ledgerMatched.some((detail) => detail.business_id === row.id))) : { links: [], evidence: [] };
  const detailLinks = detailEvidence.links as JsonRecord[];
  const matchedWithEvidence = matched.map((detail) => ({ ...detail,
    has_evidence: cleanText(detail.business_type, 60) === "daily_sheet"
      ? Boolean(detail.source_voucher_id)
      : cleanText(detail.business_type, 60) === "history_monthly_profit_loss"
        ? Boolean((evidenceData.evidence as JsonRecord[]).length)
      : detailLinks.some((link) => cleanText(link.import_row_id, 40) === cleanText(detail.import_row_id, 40)),
  }));
  const matchedWithRules = await businessEvidenceRulesForDetails(companyId, storeId, matchedWithEvidence);
  result.mode = "input";
  result.revision = { status: (evidenceData.evidence as JsonRecord[]).length ? "matched" : "missing_evidence", source_amount: current.amount, delta: 0 };
  result.sources = [];
  result.business_details = matchedWithRules;
  result.business_total = Number(matchedWithRules.reduce((sum, row) => sum + Number(row.amount || 0), 0).toFixed(4));
  const allEvidence = Array.from(new Map([
    ...(dailyReconciled ? dailyIncome.evidence as JsonRecord[] : []),
    ...historyEvidenceWithScope(detailEvidence),
    ...historyEvidenceWithScope(evidenceData),
  ].map((row) => [cleanText(row.id, 40), row])).values());
  result.evidence = allEvidence;
  const missingRequiredDetails = matchedWithRules.filter((detail) => cleanText(detail.evidence_policy, 30) !== "none" && !detail.has_evidence);
  const allDetailsNotRequired = matchedWithRules.length > 0 && matchedWithRules.every((detail) => cleanText(detail.evidence_policy, 30) === "none");
  result.revision = { status: matchedWithRules.length
    ? allDetailsNotRequired ? "not_required" : missingRequiredDetails.length ? "missing_evidence" : "matched"
    : evidencePolicy === "none" ? "not_required"
      : evidencePolicy === "source_report" ? "source_report"
        : allEvidence.length ? "matched" : "missing_evidence", source_amount: current.amount, delta: 0 };
  result.history_evidence_links = [...(evidenceData.links as JsonRecord[]), ...(detailEvidence.links as JsonRecord[])];
  result.daily_source_count = (dailyIncome.details as JsonRecord[]).length;
  result.daily_source_total = dailyIncome.total;
  result.daily_source_reconciled = dailyReconciled;
  result.anomalies = missingRequiredDetails.length || (!matchedWithRules.length && evidencePolicy === "voucher_required" && !allEvidence.length) ? ["missing_voucher"] : [];
  return result;
}

async function cellTrace(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const reportId = cleanText(payload.report_id, 40);
  const address = cleanText(payload.cell_address, 20).toUpperCase();
  const reports = await restRows(`zysyr_report_uploads?select=id,report_type,report_date,template_code,version,original_filename,uploaded_by_user_id,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${reportId}&limit=1`);
  const report = reports[0];
  if (!report) {
    (session as JsonRecord).__trace_month = parseMonth(cleanText(payload.month, 7));
    return historicalCellTrace(companyId, storeId, reportId, address, session);
  }
  const cells = await restRows(`zysyr_report_cells?select=id,sheet_name,cell_address,row_number,column_number,cell_kind,display_value,numeric_value,formula,precedent_addresses,label&company_id=eq.${companyId}&store_id=eq.${storeId}&report_id=eq.${reportId}&cell_address=eq.${encodeURIComponent(address)}&limit=1`);
  const target = cells[0];
  if (!target) throw new Error("该位置不是可追溯的金额或公式单元格");
  const [uploaderRows, amountRevisions] = await Promise.all([
    restRows(`zysyr_user_accounts?select=id,login_name,display_name&id=eq.${cleanText(report.uploaded_by_user_id, 40)}&limit=1`),
    restRowsAll(`zysyr_monthly_cell_revisions?select=id,revision,revision_type,before_amount,after_amount,delta,reason,actor_user_id,unlock_request_id,voucher_count,created_at&company_id=eq.${companyId}&store_id=eq.${storeId}&source_cell_id=eq.${cleanText(target.id, 40)}&order=revision.desc&limit=500`, 500),
  ]);
  const latestAmountRevision = amountRevisions[0] || null;
  const actorIds = Array.from(new Set(amountRevisions.map((row) => cleanText(row.actor_user_id, 40)).filter(Boolean)));
  const actors = actorIds.length ? await restRowsAll(`zysyr_user_accounts?select=id,login_name,display_name&company_id=eq.${companyId}&id=in.${uuidIn(actorIds)}&limit=500`, 500) : [];
  const actorMap = new Map(actors.map((actor) => [cleanText(actor.id, 40), actor]));
  const amountHistory = amountRevisions.map((revision) => ({ ...revision,
    actor: actorMap.get(cleanText(revision.actor_user_id, 40)) || null,
  }));
  const effectiveTarget = { ...target,
    original_numeric_value: target.numeric_value,
    numeric_value: latestAmountRevision ? latestAmountRevision.after_amount : target.numeric_value,
    latest_amount_revision: latestAmountRevision,
  };
  const ruleRows = await monthlyEvidenceRules(companyId, storeId, cleanText(report.template_code, 120));
  const evidencePolicy = monthlyEvidencePolicyMap([effectiveTarget], ruleRows)[address] || defaultMonthlyEvidencePolicy(effectiveTarget);
  const result: JsonRecord = {
    target: effectiveTarget,
    report: { ...report, uploaded_by: uploaderRows[0] || null },
    can_edit: cleanText(session.operations_role, 40) === "finance" && hasAuthCapability(session, "confirmed_finance.adjust"),
    can_upload_vouchers: canUploadVouchers(session),
    can_manage_business_evidence_rules: cleanText(session.operations_role, 40) === "finance" && hasAuthCapability(session, "confirmed_finance.adjust"),
    can_manage_evidence_rules: hasAuthCapability(session, "finance_account.create"),
    evidence_policy: evidencePolicy,
    evidence_rule: ruleRows.find((rule) => cleanText(rule.cell_address, 20).toUpperCase() === address) || null,
    amount_history: amountHistory,
  };

  if (cleanText(target.cell_kind, 20) === "formula") {
    const precedents = Array.isArray(target.precedent_addresses) ? target.precedent_addresses as unknown[] : [];
    const addresses = precedents.map((item) => cleanText(item, 20)).filter((item) => /^[A-Z]{1,3}[1-9][0-9]{0,3}$/.test(item));
    const addressFilter = addresses.length ? `(${addresses.join(",")})` : "()";
    const sourceCells = addressFilter === "()" ? [] : await restRowsAll(`zysyr_report_cells?select=id,cell_address,cell_kind,display_value,numeric_value,formula,label&company_id=eq.${companyId}&report_id=eq.${reportId}&cell_address=in.${addressFilter}&order=row_number.asc,column_number.asc`, 1000);
    const sourceFilter = uuidIn(sourceCells.map((cell) => cell.id));
    const revisions = sourceFilter === "()" ? [] : await restRowsAll(`zysyr_report_cell_trace_revisions?select=target_cell_id,revision,status,source_amount,delta,evidence_count&company_id=eq.${companyId}&target_cell_id=in.${sourceFilter}&order=revision.desc`, 2000);
    const sourceAmountRevisions = sourceFilter === "()" ? [] : await restRowsAll(`zysyr_monthly_cell_revisions?select=source_cell_id,revision,after_amount&company_id=eq.${companyId}&store_id=eq.${storeId}&source_cell_id=in.${sourceFilter}&order=source_cell_id.asc,revision.desc`, 2000);
    const sourceAmountMap = latestMonthlyCellRevisionMap(sourceAmountRevisions);
    const revisionMap = new Map<string, JsonRecord>();
    for (const revision of revisions) {
      const key = cleanText(revision.target_cell_id, 40);
      if (!revisionMap.has(key)) revisionMap.set(key, revision);
    }
    result.mode = "formula";
    result.precedents = sourceCells.map((cell) => ({ ...cell,
      numeric_value: sourceAmountMap.get(cleanText(cell.id, 40))?.after_amount ?? cell.numeric_value,
      original_numeric_value: cell.numeric_value,
      trace: revisionMap.get(cleanText(cell.id, 40)) || null,
    }));
    return result;
  }

  const revisions = await restRows(`zysyr_report_cell_trace_revisions?select=id,revision,expected_amount,source_amount,delta,status,source_count,evidence_count,created_by_user_id,created_at&company_id=eq.${companyId}&target_cell_id=eq.${cleanText(target.id, 40)}&order=revision.desc&limit=1`);
  const revision = revisions[0] || null;
  const sources: JsonRecord[] = [];
  let evidence: JsonRecord[] = [];
  if (revision) {
    const [sourceLinks, evidenceLinks] = await Promise.all([
      restRowsAll(`zysyr_report_cell_trace_sources?select=source_cell_id,source_amount&company_id=eq.${companyId}&trace_revision_id=eq.${cleanText(revision.id, 40)}&limit=500`, 500),
      restRowsAll(`zysyr_report_cell_trace_evidence?select=voucher_id&company_id=eq.${companyId}&trace_revision_id=eq.${cleanText(revision.id, 40)}&limit=200`, 200),
    ]);
    const sourceFilter = uuidIn(sourceLinks.map((link) => link.source_cell_id));
    const sourceCells = sourceFilter === "()" ? [] : await restRowsAll(`zysyr_report_cells?select=id,report_id,sheet_name,cell_address,row_number,column_number,cell_kind,display_value,numeric_value,formula,label&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${sourceFilter}&limit=500`, 500);
    const sourceReportFilter = uuidIn(sourceCells.map((cell) => cell.report_id));
    const sourceReports = sourceReportFilter === "()" ? [] : await restRowsAll(`zysyr_report_uploads?select=id,report_type,report_date,version,original_filename,uploaded_by_user_id,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${sourceReportFilter}&limit=500`, 500);
    const sourceUploaderFilter = uuidIn(sourceReports.map((item) => item.uploaded_by_user_id));
    const sourceUploaders = sourceUploaderFilter === "()" ? [] : await restRowsAll(`zysyr_user_accounts?select=id,login_name,display_name&id=in.${sourceUploaderFilter}&limit=500`, 500);
    const reportMap = new Map(sourceReports.map((item) => [cleanText(item.id, 40), item]));
    const accountMap = new Map(sourceUploaders.map((item) => [cleanText(item.id, 40), item]));
    for (const cell of sourceCells) {
      const sourceReport = reportMap.get(cleanText(cell.report_id, 40)) || {};
      sources.push({ ...cell, report: { ...sourceReport, uploaded_by: accountMap.get(cleanText(sourceReport.uploaded_by_user_id, 40)) || null } });
    }
    const evidenceFilter = uuidIn(evidenceLinks.map((link) => link.voucher_id));
    evidence = evidenceFilter === "()" ? [] : await restRowsAll(`zysyr_voucher_attachments?select=id,record_id,original_filename,mime_type,note,uploaded_by,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${evidenceFilter}&limit=200`, 200);
  }
  if (latestAmountRevision) {
    const revisionLinks = await restRowsAll(`zysyr_monthly_cell_revision_vouchers?select=voucher_id,linked_at&company_id=eq.${companyId}&store_id=eq.${storeId}&revision_id=eq.${cleanText(latestAmountRevision.id, 40)}&limit=200`, 200);
    const revisionVoucherIds = uuidIn(revisionLinks.map((link) => link.voucher_id));
    const revisionEvidence = revisionVoucherIds === "()" ? [] : await restRowsAll(`zysyr_voucher_attachments?select=id,record_id,original_filename,mime_type,note,uploaded_by,uploaded_at,audit_status,document_type&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${revisionVoucherIds}&limit=200`, 200);
    evidence = Array.from(new Map([...evidence, ...revisionEvidence].map((voucher) => [cleanText(voucher.id, 40), voucher])).values());
  }
  result.mode = "input";
  result.revision = revision;
  result.sources = sources;
  result.evidence = evidence;
  let businessDetails = await monthlyCellBusinessDetails(
    companyId, storeId, cleanText(report.report_date, 10), target.label,
  );
  if (!businessDetails.length && !sources.length) {
    businessDetails = await businessEvidenceRulesForDetails(companyId, storeId, [{
      business_type: "report_cell", business_id: target.id,
      business_date: cleanText(report.report_date, 10), category: cleanText(target.label, 300) || address,
      description: `月报直接录入 · ${address}`, amount: effectiveTarget.numeric_value,
      status: "confirmed", vouchers: evidence, pending_vouchers: [], has_evidence: Boolean(evidence.length),
    }]);
  }
  result.business_details = businessDetails;
  result.business_total = Number(businessDetails.reduce((sum, row) => sum + Number(row.amount || 0), 0).toFixed(4));
  const missingRequiredDetails = businessDetails.filter((detail) => cleanText(detail.evidence_policy, 30) !== "none"
    && !(detail.vouchers as JsonRecord[] || []).length && !(detail.pending_vouchers as JsonRecord[] || []).length);
  const allDetailsNotRequired = businessDetails.length > 0
    && businessDetails.every((detail) => cleanText(detail.evidence_policy, 30) === "none");
  if (businessDetails.length) result.revision = { ...(revision || {}),
    status: allDetailsNotRequired ? "not_required" : missingRequiredDetails.length ? "missing_evidence" : "matched" };
  if (!businessDetails.length && evidencePolicy === "none") result.revision = { ...(revision || {}), status: "not_required" };
  if (!businessDetails.length && evidencePolicy === "source_report") result.revision = { ...(revision || {}),
    status: revision && cleanText(revision.status, 30) === "mismatch" ? "mismatch" : sources.length ? "source_report" : "unlinked" };
  const anomalies: string[] = [];
  if (missingRequiredDetails.length || (!businessDetails.length && evidencePolicy === "voucher_required" && !evidence.length)) anomalies.push("missing_voucher");
  if (evidencePolicy === "source_report" && !sources.length) anomalies.push("missing_source_report");
  if (revision && cleanText(revision.status, 30) === "mismatch") anomalies.push("detail_total_mismatch");
  if (businessDetails.length && Math.abs(Number(result.business_total) - Number(effectiveTarget.numeric_value || 0)) > 0.01) {
    anomalies.push("business_total_mismatch");
  }
  if (latestAmountRevision && Number(latestAmountRevision.after_amount) !== Number(target.numeric_value)) {
    anomalies.push("amount_revised");
    const before = Math.abs(Number(latestAmountRevision.before_amount || 0));
    const delta = Math.abs(Number(latestAmountRevision.delta || 0));
    if (delta >= Math.max(1000, before * 0.5)) anomalies.push("unusual_adjustment");
  }
  result.anomalies = anomalies;
  return result;
}

async function saveCellTrace(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!canUploadReports(session)) throw new Error("只有财务账号可以设置月报数字追溯");
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const targetCellId = cleanText(payload.target_cell_id, 40);
  const actorId = cleanText(session.auth_account_id, 40);
  const target = await restRows(`zysyr_report_cells?select=id&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${targetCellId}&limit=1`);
  if (!target.length || !actorId) throw new Error("目标单元格或财务身份无效");
  const response = await rest("rpc/zysyr_save_report_cell_trace", {
    method: "POST",
    body: JSON.stringify({
      p_target_cell_id: targetCellId,
      p_source_cell_ids: uuidArray(payload.source_cell_ids, 500),
      p_voucher_ids: uuidArray(payload.voucher_ids, 200),
      p_actor_user_id: actorId,
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as JsonRecord;
    throw new Error(cleanText(error.message ?? error.error, 500) || `追溯保存失败 (${response.status})`);
  }
  const saved = await response.json();
  return { saved };
}

async function saveMonthlyEvidenceRule(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "finance_account.create")) throw new Error("只有管理员可以修改凭证要求");
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const reportId = uuidValue(payload.report_id, "月报编号无效") as string;
  const address = cleanText(payload.cell_address, 20).toUpperCase();
  const policy = cleanText(payload.evidence_policy, 30);
  const reason = cleanText(payload.reason, 500);
  if (!/^[A-Z]{1,3}[1-9][0-9]{0,3}$/.test(address)
      || !MONTHLY_EVIDENCE_POLICIES.has(policy) || !reason) {
    throw new Error("请选择凭证规则并填写修改原因");
  }

  const reports = await restRows(`zysyr_report_uploads?select=id,template_code&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${reportId}&report_type=eq.monthly_profit_loss&limit=1`);
  let templateCode = cleanText(reports[0]?.template_code, 120);
  let label = cleanText(payload.cell_label, 300);
  if (reports[0]) {
    const cells = await restRows(`zysyr_report_cells?select=cell_address,label&company_id=eq.${companyId}&store_id=eq.${storeId}&report_id=eq.${reportId}&cell_address=eq.${encodeURIComponent(address)}&limit=1`);
    if (!cells[0]) throw new Error("该月报金额不存在或不属于当前门店");
    label = cleanText(cells[0].label, 300) || label;
  } else {
    const batches = await restRows(`zysyr_history_import_batches?select=id&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${reportId}&import_type=eq.monthly_profit_loss&status=eq.completed&limit=1`);
    if (!batches[0]) throw new Error("月报不存在或不属于当前门店");
    templateCode = "history_original_v1";
  }
  if (!templateCode) throw new Error("月报模板信息缺失，不能保存凭证规则");

  const response = await rest("rpc/zysyr_save_monthly_evidence_rule", {
    method: "POST",
    body: JSON.stringify({
      p_actor_user_id: cleanText(session.auth_account_id, 40),
      p_company_id: companyId,
      p_store_id: storeId,
      p_template_code: templateCode,
      p_cell_address: address,
      p_cell_label: label,
      p_evidence_policy: policy,
      p_reason: reason,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data && typeof data === "object" ? data as JsonRecord : {};
    const code = cleanText(error.message ?? error.code, 160);
    if (code === "MONTHLY_EVIDENCE_RULE_ADMIN_REQUIRED") throw new Error("只有管理员可以修改凭证要求");
    if (code === "MONTHLY_EVIDENCE_RULE_STORE_INVALID") throw new Error("当前门店无效或已停用");
    if (code === "MONTHLY_EVIDENCE_RULE_INVALID") throw new Error("凭证规则或修改原因无效");
    throw new Error(`凭证规则保存失败 (${response.status})`);
  }
  const saved = Array.isArray(data) ? data[0] : data;
  return { saved };
}

async function saveBusinessEvidenceRule(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireFinanceCapability(session, "confirmed_finance.adjust", "只有财务账号可以修改单笔凭证要求");
  const store = await selectedStoreInfo(session, payload);
  const reason = cleanText(payload.reason, 500);
  if (!reason || typeof payload.evidence_required !== "boolean") {
    throw new Error("请选择这笔记录是否需要凭证并填写原因");
  }
  const saved = await rpcSaved("rpc/zysyr_save_business_evidence_rule", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40),
    p_business_type: cleanText(payload.business_type, 60),
    p_business_id: uuidValue(payload.business_id, "业务记录编号无效"),
    p_evidence_required: payload.evidence_required,
    p_reason: reason,
  });
  return { saved };
}

async function historyMonthlyCellSave(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireFinanceCapability(session, "confirmed_finance.adjust", "只有具备已确认财务调整权限的财务账号可以修改月报金额");
  const store = await selectedStoreInfo(session, payload);
  const amountText = cleanText(payload.after_amount, 100);
  const reason = cleanText(payload.reason, 500);
  if (!/^-?\d{1,14}(?:\.\d{1,4})?$/.test(amountText) || !reason) {
    throw new Error("请填写有效金额和本次修改原因");
  }
  const saved = await rpcSaved("rpc/zysyr_revise_history_monthly_cell", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40),
    p_ledger_entry_id: uuidValue(payload.ledger_entry_id, "历史月报金额编号无效"),
    p_after_amount: amountText,
    p_reason: reason,
  });
  return { saved, formal_ledger_written: true };
}

async function reportUrl(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const store = await selectedStoreInfo(session, payload);
  const reportId = cleanText(payload.report_id, 80);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const rows = await restRows(`zysyr_report_uploads?select=id,object_path,original_filename&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${encodeURIComponent(reportId)}&limit=1`);
  let report = rows[0];
  let bucket = REPORT_BUCKET;
  if (!report) {
    const batches = await restRows(`zysyr_history_import_batches?select=id,source_bucket_id,source_object_path,source_filename&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${encodeURIComponent(reportId)}&status=eq.completed&limit=1`);
    const batch = batches[0];
    if (!batch) throw new Error("报表不存在或无权访问");
    bucket = cleanText(batch.source_bucket_id, 100);
    report = { object_path: batch.source_object_path, original_filename: batch.source_filename };
  }
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${storagePath(bucket)}/${storagePath(cleanText(report.object_path, 500))}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  if (!response.ok) throw new Error(`报表链接生成失败 (${response.status})`);
  const signed = await response.json();
  const signedPath = cleanText(signed.signedURL ?? signed.signedUrl, 2000);
  if (!signedPath) throw new Error("报表链接生成失败");
  return { url: signedPath.startsWith("http") ? signedPath : `${SUPABASE_URL}/storage/v1${signedPath}`, expires_in: 300, filename: report.original_filename };
}

async function reportLineage(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40), storeId = cleanText(store.id, 40);
  const reportId = uuidValue(payload.report_id, "报表标识无效");
  const reports = await restRows(`zysyr_report_uploads?select=id,report_type,report_date,version,original_filename,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${reportId}&limit=1`);
  const report = reports[0];
  if (!report) throw new Error("报表不存在或无权访问");
  const cells = await restRowsAll(`zysyr_report_cells?select=id&company_id=eq.${companyId}&store_id=eq.${storeId}&report_id=eq.${reportId}&limit=5000`, 5000);
  const cellIds = cells.map((cell) => cell.id);
  const sourceLinks = cellIds.length
    ? await restRowsAll(`zysyr_report_cell_trace_sources?select=trace_revision_id,source_cell_id,source_amount&company_id=eq.${companyId}&store_id=eq.${storeId}&source_cell_id=in.${uuidIn(cellIds)}&limit=5000`, 5000)
    : [];
  const linkedRevisionIds = Array.from(new Set(sourceLinks.map((link) => cleanText(link.trace_revision_id, 40))));
  const linkedRevisions = linkedRevisionIds.length
    ? await restRowsAll(`zysyr_report_cell_trace_revisions?select=id,target_cell_id,revision,status,expected_amount,source_amount,delta,created_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(linkedRevisionIds)}&limit=5000`, 5000)
    : [];
  const targetIds = Array.from(new Set(linkedRevisions.map((revision) => revision.target_cell_id)));
  const allTargetRevisions = targetIds.length
    ? await restRowsAll(`zysyr_report_cell_trace_revisions?select=id,target_cell_id,revision&company_id=eq.${companyId}&store_id=eq.${storeId}&target_cell_id=in.${uuidIn(targetIds)}&order=revision.desc&limit=5000`, 5000)
    : [];
  const latestRevisionByTarget = new Map<string, string>();
  for (const revision of allTargetRevisions) {
    const targetId = cleanText(revision.target_cell_id, 40);
    if (!latestRevisionByTarget.has(targetId)) latestRevisionByTarget.set(targetId, cleanText(revision.id, 40));
  }
  const activeRevisions = linkedRevisions.filter((revision) => latestRevisionByTarget.get(cleanText(revision.target_cell_id, 40)) === cleanText(revision.id, 40));
  const activeTargetIds = Array.from(new Set(activeRevisions.map((revision) => revision.target_cell_id)));
  const targetCells = activeTargetIds.length
    ? await restRowsAll(`zysyr_report_cells?select=id,report_id,sheet_name,cell_address,row_number,column_number,display_value,numeric_value,label&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(activeTargetIds)}&limit=5000`, 5000)
    : [];
  const targetReportIds = Array.from(new Set(targetCells.map((cell) => cell.report_id)));
  const targetReports = targetReportIds.length
    ? await restRowsAll(`zysyr_report_uploads?select=id,report_type,report_date,version,original_filename&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(targetReportIds)}&limit=5000`, 5000)
    : [];
  const targetReportMap = new Map(targetReports.map((item) => [cleanText(item.id, 40), item]));
  const revisionMap = new Map(activeRevisions.map((item) => [cleanText(item.target_cell_id, 40), item]));

  const directSalaries = await restRowsAll(`zysyr_salaries?select=id,employee_id,salary_month,version,status,final_salary,source_report_id&company_id=eq.${companyId}&store_id=eq.${storeId}&source_report_id=eq.${reportId}&limit=3000`, 3000);
  const detailRows = cellIds.length
    ? await restRowsAll(`zysyr_salary_details?select=salary_id,source_report_cell_id,line_type,amount&company_id=eq.${companyId}&store_id=eq.${storeId}&source_report_cell_id=in.${uuidIn(cellIds)}&limit=10000`, 10000)
    : [];
  const detailSalaryIds = Array.from(new Set(detailRows.map((detail) => detail.salary_id)));
  const detailSalaries = detailSalaryIds.length
    ? await restRowsAll(`zysyr_salaries?select=id,employee_id,salary_month,version,status,final_salary,source_report_id&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(detailSalaryIds)}&limit=3000`, 3000)
    : [];
  const salaries = Array.from(new Map([...directSalaries, ...detailSalaries].map((salary) => [cleanText(salary.id, 40), salary])).values());
  const employeeIds = Array.from(new Set(salaries.map((salary) => salary.employee_id)));
  const employees = employeeIds.length
    ? await restRowsAll(`zysyr_employees?select=id,employee_code,name,position&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(employeeIds)}&limit=3000`, 3000)
    : [];
  const employeeMap = new Map(employees.map((employee) => [cleanText(employee.id, 40), employee]));
  return {
    report,
    monthly_targets: targetCells.map((cell) => ({ ...cell,
      report: targetReportMap.get(cleanText(cell.report_id, 40)) || null,
      trace: revisionMap.get(cleanText(cell.id, 40)) || null,
    })),
    salaries: salaries.map((salary) => ({ ...salary,
      employee: employeeMap.get(cleanText(salary.employee_id, 40)) || null,
      source_details: detailRows.filter((detail) => cleanText(detail.salary_id, 40) === cleanText(salary.id, 40)),
    })),
  };
}

function storagePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function rasterMime(path: string): string {
  const extension = cleanText(path, 500).split(".").pop()?.toLowerCase();
  return extension === "jpg" || extension === "jpeg" ? "image/jpeg"
    : extension === "png" ? "image/png"
    : extension === "webp" ? "image/webp"
    : extension === "gif" ? "image/gif" : "";
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunk, bytes.length)));
  }
  return btoa(binary);
}

async function assertBusinessVoucherTarget(
  companyId: string,
  storeId: string,
  businessType: string,
  businessId: string,
): Promise<void> {
  const specs: Record<string, { table: string; state: string }> = {
    income_record: { table: "zysyr_income_records", state: "status=eq.approved" },
    expense_record: { table: "zysyr_expense_records", state: "workflow_status=in.(approved,paid)&deleted_at=is.null" },
    petty_cash_record: { table: "zysyr_petty_cash_records", state: "status=eq.confirmed" },
    salary: { table: "zysyr_salaries", state: "status=in.(approved,paid)" },
    goods_receipt: { table: "zysyr_goods_receipts", state: "status=eq.posted" },
    usage_record: { table: "zysyr_usage_records", state: "status=eq.confirmed" },
    employee_purchase: { table: "zysyr_employee_purchases", state: "status=eq.approved" },
  };
  const spec = specs[businessType];
  if (!spec || !/^[0-9a-f-]{36}$/i.test(businessId)) throw new Error("凭证关联的业务记录无效");
  const rows = await restRows(`${spec.table}?select=id&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${businessId}&${spec.state}&limit=1`);
  if (!rows.length) throw new Error("业务记录不存在、已冲销或不属于当前门店");
}

async function uploadVoucher(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const store = await selectedStoreInfo(session, payload);
  const recordType = cleanText(payload.record_type, 20) || "unassigned";
  const recordId = cleanText(payload.record_id, 100);
  const filename = cleanText(payload.filename, 200);
  const mime = cleanText(payload.mime_type, 80);
  const skipOcr = payload.skip_ocr === true;
  const monthlyCellId = uuidValue(payload.monthly_cell_id, "月报单元格编号无效", true);
  const monthlyCellReason = cleanText(payload.monthly_cell_reason ?? payload.note, 500);
  const businessType = cleanText(payload.business_type, 40);
  const businessId = cleanText(payload.business_id, 40);
  const businessLinkReason = cleanText(payload.business_link_reason ?? payload.note, 500);
  if (!canUploadVouchers(session)) throw new Error("只有财务账号可以上传凭证");
  if (!["unassigned", "report"].includes(recordType)
    || (recordType === "report" && !/^[0-9a-f-]{36}$/i.test(recordId))
    || (recordType === "unassigned" && recordId)) throw new Error("凭证关联记录无效");
  if (!["image/jpeg", "image/png", "application/pdf"].includes(mime)) throw new Error("凭证仅支持 JPG、PNG 或 PDF");
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  if (businessType || businessId) {
    if (recordType !== "unassigned" || !businessType || !businessId || !businessLinkReason) {
      throw new Error("补传业务凭证时必须指定当前业务记录和补传原因");
    }
    await assertBusinessVoucherTarget(companyId, storeId, businessType, businessId);
  }
  if (recordType === "report") {
    const reports = await restRows(`zysyr_report_uploads?select=id&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${encodeURIComponent(recordId)}&limit=1`);
    if (!reports.length) throw new Error("报表不存在或无权关联消费凭证");
  }
  if (monthlyCellId) {
    if (recordType !== "report" || !recordId || !monthlyCellReason) throw new Error("补传月报单元格凭证时必须填写关联报表和补传原因");
    const cells = await restRows(`zysyr_report_cells?select=id&company_id=eq.${companyId}&store_id=eq.${storeId}&report_id=eq.${recordId}&id=eq.${monthlyCellId}&limit=1`);
    if (!cells.length) throw new Error("月报单元格不存在或不属于当前报表");
  }
  let bytes: Uint8Array;
  try { bytes = decodeBase64(cleanText(payload.base64, 15000000)); } catch { throw new Error("凭证文件内容无效"); }
  if (!bytes.length || bytes.length > MAX_VOUCHER_BYTES) throw new Error("凭证文件必须小于 10MB");
  const digest = await sha256Bytes(bytes);
  const duplicates = await restRows(`zysyr_voucher_attachments?select=id,original_filename&company_id=eq.${companyId}&sha256=eq.${digest}&limit=1`);
  if (duplicates.length) throw new Error(`该文件已上传：${cleanText(duplicates[0].original_filename, 200) || "同一凭证"}`);
  const extension = mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : "jpg";
  const voucherId = crypto.randomUUID();
  const objectPath = `${companyId}/${storeId}/voucher-center/${new Date().toISOString().slice(0, 10)}/${voucherId}.${extension}`;
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${VOUCHER_BUCKET}/${storagePath(objectPath)}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": mime, "x-upsert": "false" },
    body: exactArrayBuffer(bytes),
  });
  if (!upload.ok) throw new Error(`凭证上传失败 (${upload.status})`);
  const metadata = await rest("rpc/zysyr_register_voucher", {
    method: "POST",
    body: JSON.stringify({
      p_actor_user_id: cleanText(session.auth_account_id, 40),
      p_company_id: companyId,
      p_store_id: storeId,
      p_id: voucherId,
      p_record_type: recordType,
      p_record_id: recordId || null,
      p_object_path: objectPath,
      p_original_filename: filename || `voucher.${extension}`,
      p_mime_type: mime,
      p_size_bytes: bytes.length,
      p_sha256: digest,
      p_note: cleanText(payload.note, 500),
    }),
  });
  if (!metadata.ok) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${VOUCHER_BUCKET}/${storagePath(objectPath)}`, {
      method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    const error = await metadata.json().catch(() => ({})) as JsonRecord;
    const code = cleanText(error.message ?? error.code, 120);
    if (code === "VOUCHER_DUPLICATE_FILE" || cleanText(error.code, 20) === "23505") throw new Error("相同凭证已经上传，请直接关联已有凭证");
    if (code === "VOUCHER_UPLOAD_FORBIDDEN") throw new Error("当前账号没有凭证上传权限");
    throw new Error(`凭证登记失败 (${metadata.status})`);
  }
  const result = await metadata.json();
  const saved = Array.isArray(result) ? result[0] : result;
  let cellLinked = false;
  let cellLinkError = "";
  let businessLinkRequest: JsonRecord | null = null;
  if (monthlyCellId) {
    try {
      await financeRpcSaved("rpc/zysyr_attach_monthly_cell_voucher", {
        p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: companyId,
        p_store_id: storeId, p_source_cell_id: monthlyCellId,
        p_voucher_id: voucherId, p_reason: monthlyCellReason,
      });
      cellLinked = true;
    } catch (error) {
      cellLinkError = error instanceof Error ? error.message : "凭证已上传，但单元格关联失败";
    }
  }
  if (businessType && businessId) {
    businessLinkRequest = await financeRpcSaved("rpc/zysyr_request_business_voucher_link", {
      p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: companyId,
      p_store_id: storeId, p_voucher_id: voucherId, p_business_type: businessType,
      p_business_id: businessId, p_relation_type: "evidence", p_reason: businessLinkReason,
    });
  }
  if (!skipOcr) wakeVoucherOcrInBackground(3);
  return { saved, private: true, ocr_candidate_only: true, ocr_worker_wake_requested: !skipOcr,
    manual_review_only: skipOcr, cell_linked: cellLinked, cell_link_error: cellLinkError || null,
    business_link_request: businessLinkRequest };
}

async function voucherCenter(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "voucher.read")) throw new Error("当前账号没有凭证查看权限");
  const store = await selectedStoreInfo(session, payload);
  const month = cleanText(payload.month, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("月份无效");
  const start = `${month}-01`;
  const endDate = new Date(`${start}T00:00:00Z`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const end = endDate.toISOString().slice(0, 10);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const vouchers = await restRowsAll(`zysyr_voucher_attachments?select=id,record_type,record_id,original_filename,mime_type,size_bytes,note,sha256,ocr_status,audit_status,document_type,uploaded_by_user_id,uploaded_at,reviewed_by_user_id,reviewed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&uploaded_at=gte.${start}T00:00:00Z&uploaded_at=lt.${end}T00:00:00Z&order=uploaded_at.desc&limit=2000`, 2000);
  const voucherFilter = uuidIn(vouchers.map((voucher) => voucher.id));
  const [tasks, reviews, links, reports] = await Promise.all([
    voucherFilter === "()" ? [] : restRowsAll(`zysyr_voucher_ocr_tasks?select=id,voucher_id,provider,status,attempt,candidate_fields,field_confidences,error_message,queued_at,started_at,completed_at&company_id=eq.${companyId}&voucher_id=in.${voucherFilter}&order=attempt.desc&limit=4000`, 4000),
    voucherFilter === "()" ? [] : restRowsAll(`zysyr_voucher_reviews?select=id,voucher_id,review_version,decision,document_type,candidate_fields,corrected_fields,field_confidences,reason,reviewer_user_id,reviewed_at&company_id=eq.${companyId}&voucher_id=in.${voucherFilter}&order=review_version.desc&limit=4000`, 4000),
    voucherFilter === "()" ? [] : restRowsAll(`zysyr_voucher_links?select=id,voucher_id,business_type,business_id,relation_type,linked_by_user_id,linked_at&company_id=eq.${companyId}&store_id=eq.${storeId}&voucher_id=in.${voucherFilter}&unlinked_at=is.null&limit=4000`, 4000),
    restRowsAll(`zysyr_report_uploads?select=id,report_type,report_date,version,original_filename&company_id=eq.${companyId}&store_id=eq.${storeId}&report_date=gte.${start}&report_date=lt.${end}&order=report_date.desc,version.desc&limit=1000`, 1000),
  ]);
  const accountFilter = uuidIn(vouchers.flatMap((voucher) => [voucher.uploaded_by_user_id, voucher.reviewed_by_user_id]));
  const accounts = accountFilter === "()" ? [] : await restRowsAll(`zysyr_user_accounts?select=id,login_name,display_name&company_id=eq.${companyId}&id=in.${accountFilter}&limit=1000`, 1000);
  const accountMap = new Map(accounts.map((account) => [cleanText(account.id, 40), account]));
  const latestTask = new Map<string, JsonRecord>();
  for (const task of tasks) if (!latestTask.has(cleanText(task.voucher_id, 40))) latestTask.set(cleanText(task.voucher_id, 40), task);
  const latestReview = new Map<string, JsonRecord>();
  for (const review of reviews) if (!latestReview.has(cleanText(review.voucher_id, 40))) latestReview.set(cleanText(review.voucher_id, 40), review);
  const linkMap = new Map<string, JsonRecord[]>();
  for (const link of links) {
    const key = cleanText(link.voucher_id, 40);
    linkMap.set(key, [...(linkMap.get(key) || []), link]);
  }
  const cellVoucherLinks = voucherFilter === "()" ? [] : await restRowsAll(`zysyr_monthly_cell_revision_vouchers?select=voucher_id,revision_id,linked_at&company_id=eq.${companyId}&store_id=eq.${storeId}&voucher_id=in.${voucherFilter}&limit=10000`, 10000);
  const cellRevisionFilter = uuidIn(cellVoucherLinks.map((link) => link.revision_id));
  const cellRevisions = cellRevisionFilter === "()" ? [] : await restRowsAll(`zysyr_monthly_cell_revisions?select=id,source_cell_id,report_id,period_month,cell_address,cell_label,revision,revision_type,after_amount,reason,created_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${cellRevisionFilter}&limit=10000`, 10000);
  const cellRevisionMap = new Map(cellRevisions.map((revision) => [cleanText(revision.id, 40), revision]));
  const cellLinkMap = new Map<string, JsonRecord[]>();
  for (const link of cellVoucherLinks) {
    const revision = cellRevisionMap.get(cleanText(link.revision_id, 40));
    if (!revision) continue;
    const key = cleanText(link.voucher_id, 40);
    const existing = cellLinkMap.get(key) || [];
    const sourceCellId = cleanText(revision.source_cell_id, 40);
    const foundIndex = existing.findIndex((item) => cleanText(item.source_cell_id, 40) === sourceCellId);
    if (foundIndex < 0 || Number(existing[foundIndex].revision || 0) < Number(revision.revision || 0)) {
      if (foundIndex >= 0) existing.splice(foundIndex, 1);
      existing.push(revision);
    }
    cellLinkMap.set(key, existing);
  }
  return {
    vouchers: vouchers.map((voucher) => ({
      ...voucher,
      uploaded_by: accountMap.get(cleanText(voucher.uploaded_by_user_id, 40)) || null,
      reviewed_by: accountMap.get(cleanText(voucher.reviewed_by_user_id, 40)) || null,
      latest_ocr_task: latestTask.get(cleanText(voucher.id, 40)) || null,
      latest_review: latestReview.get(cleanText(voucher.id, 40)) || null,
      links: linkMap.get(cleanText(voucher.id, 40)) || [],
      monthly_cells: cellLinkMap.get(cleanText(voucher.id, 40)) || [],
    })),
    reports,
    can_upload: canUploadVouchers(session),
    can_review: canReviewVouchers(session),
    ocr_provider_configured: Boolean(Deno.env.get("SILICONFLOW_API_KEY")),
  };
}

async function retryVoucherOcr(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!canReviewVouchers(session)) throw new Error("只有当前门店财务账号可以重新发起 OCR");
  const store = await selectedStoreInfo(session, payload);
  const voucherId = uuidValue(payload.voucher_id, "凭证无效");
  const reason = cleanText(payload.reason, 500);
  if (!reason) throw new Error("请填写重新识别原因");
  const saved = await financeRpcSaved("rpc/zysyr_retry_voucher_ocr", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40),
    p_voucher_id: voucherId,
    p_reason: reason,
  });
  wakeVoucherOcrInBackground(3);
  return { saved, candidate_only: true, human_review_required: true, ocr_worker_wake_requested: true };
}

async function wakeVoucherOcr(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!canReviewVouchers(session)) throw new Error("只有财务账号可以启动 OCR 队列");
  await selectedStoreInfo(session, payload);
  const result = await invokeVoucherOcrWorker(Number(payload.limit || 3));
  return { ...result, manual_wake: true, human_review_required: true };
}

async function reviewVoucher(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!canReviewVouchers(session)) throw new Error("只有财务账号可以审核凭证");
  const store = await selectedStoreInfo(session, payload);
  const voucherId = cleanText(payload.voucher_id, 40);
  const decision = cleanText(payload.decision, 20);
  const documentType = cleanText(payload.document_type, 40);
  const reportIds = uuidArray(payload.report_ids ?? [], 100);
  const reason = cleanText(payload.reason, 500);
  if (!/^[0-9a-f-]{36}$/i.test(voucherId) || !["approved", "rejected"].includes(decision) || !reason) throw new Error("请完整填写审核决定和原因");
  const corrected = payload.corrected_fields && typeof payload.corrected_fields === "object" && !Array.isArray(payload.corrected_fields)
    ? payload.corrected_fields as JsonRecord : {};
  const confidences = payload.field_confidences && typeof payload.field_confidences === "object" && !Array.isArray(payload.field_confidences)
    ? payload.field_confidences as JsonRecord : {};
  const response = await rest("rpc/zysyr_review_voucher_and_resolve_links", {
    method: "POST",
    body: JSON.stringify({
      p_actor_user_id: cleanText(session.auth_account_id, 40),
      p_company_id: cleanText(store.company_id, 40),
      p_store_id: cleanText(store.id, 40),
      p_voucher_id: voucherId,
      p_decision: decision,
      p_document_type: documentType,
      p_corrected_fields: corrected,
      p_field_confidences: confidences,
      p_report_ids: reportIds,
      p_reason: reason,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = result && typeof result === "object" ? result as JsonRecord : {};
    const code = cleanText(error.message ?? error.code, 120);
    if (code === "VOUCHER_REVIEW_FORBIDDEN") throw new Error("当前账号没有凭证审核权限");
    if (code === "REPORT_NOT_FOUND") throw new Error("关联报表不存在或不属于当前门店");
    if (/_INVALID$/.test(code)) throw new Error("凭证审核字段无效");
    throw new Error(`凭证审核失败 (${response.status})`);
  }
  const normalized = Array.isArray(result) ? result[0] : result;
  return { saved: normalized.voucher ?? normalized, business_links: normalized.business_links ?? null };
}

async function financeRpcSaved(path: string, body: JsonRecord): Promise<JsonRecord> {
  const response = await rest(path, { method: "POST", body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data && typeof data === "object" ? data as JsonRecord : {};
    const code = cleanText(error.message ?? error.code, 160);
    const sqlState = cleanText(error.code, 20);
    console.error("finance rpc failed", path, response.status, sqlState);
    if (code === "FINANCE_SCOPE_FORBIDDEN") throw new Error("只有当前门店财务账号可以维护正式财务记录");
    if (code === "FINANCE_PERIOD_LOCKED") throw new Error("该月份已锁账，不能继续修改");
    if (code === "APPROVED_DAILY_REPORT_REQUIRES_REVERSAL") throw new Error("已审核日报不能覆盖，必须先走冲销流程");
    if (code === "DAILY_SOURCE_REPORT_NOT_FOUND") throw new Error("日报原件不存在、已被替代或不属于当前门店");
    if (code === "DAILY_REPORT_SOURCE_CELL_NOT_FOUND") throw new Error("日报数字没有对应到当前原表单元格");
    if (code === "DAILY_SHEET_CONTROL_MISMATCH") throw new Error("员工行、项目列、实做或支付合计不一致，已禁止入账");
    if (code === "EXISTING_DAILY_REPORT_REQUIRES_REVERSAL") throw new Error("当天已有正式日报，必须先冲销后再确认新版本");
    if (code === "DAILY_SHEET_ALREADY_CONFIRMED") throw new Error("这张电子日报已经最终确认，不能重复入账");
    if (code === "DAILY_SHEET_DRAFT_NOT_EDITABLE") throw new Error("这张电子日报已确认或已取消，不能继续修改");
    if (code === "DAILY_SHEET_IMPORT_CONFLICT") throw new Error("当天已有日报或来源冲突，系统没有覆盖任何数据");
    if (code === "DAILY_SHEET_SOURCE_CELL_MAPPING_FAILED" || code === "DAILY_SHEET_RECONCILIATION_FAILED") throw new Error("电子表格单元格与正式日报明细未能逐项匹配，系统已回滚");
    if (path === "rpc/zysyr_create_daily_sheet_draft" && sqlState === "22003") throw new Error("图片中存在超出单元格允许范围的数字，已停止保存候选草稿");
    if (path === "rpc/zysyr_create_daily_sheet_draft" && sqlState === "23514") {
      const constraint = code.match(/constraint \"([a-z0-9_]+)\"/i)?.[1] || "unknown_check";
      throw new Error(`图片候选单元格未通过数据库格式校验（${constraint}），已停止保存草稿`);
    }
    if (path === "rpc/zysyr_create_daily_sheet_draft" && sqlState === "23505") throw new Error("图片候选中存在重复单元格，已停止保存草稿");
    if (code === "APPROVED_VOUCHER_NOT_FOUND") throw new Error("凭证尚未人工审核通过或不属于当前门店");
    if (code === "APPROVED_VOUCHER_REQUIRED") throw new Error("每笔正式财务记录必须关联已审核凭证");
    if (code === "PAYMENT_EXCEEDS_EXPENSE") throw new Error("本次付款会超过支出金额");
    if (code === "EXPENSE_HAS_CONFIRMED_PAYMENT") throw new Error("该支出已有确认付款，请先冲销付款记录");
    if (code === "MONTHLY_TRANSITION_NOT_ALLOWED") throw new Error("月报当前状态不允许执行此操作");
    if (code === "CURRENT_MONTHLY_REPORT_EXISTS") throw new Error("本月已有未冲销的正式月报，请先完成或冲销现有版本");
    if (code === "MONTHLY_FORMULA_EDIT_FORBIDDEN") throw new Error("小计、合计、盈亏和公式金额由系统自动计算，不能直接修改");
    if (code === "MONTHLY_CELL_AGGREGATE_EDIT_FORBIDDEN") throw new Error("该金额由二级明细自动汇总，请进入二级明细修改具体记录");
    if (code === "MONTHLY_IDENTIFIER_EDIT_FORBIDDEN") throw new Error("编号、序号和员工号是固定标识，不能作为金额修改");
    if (code === "MONTHLY_CELL_AMOUNT_UNCHANGED") throw new Error("填写的金额与当前金额相同，无需保存");
    if (code === "MONTHLY_UNLOCK_APPROVAL_REQUIRED") throw new Error("该月份已锁账，请先提交修改申请并等待管理员授权");
    if (code === "MONTHLY_PERIOD_NOT_LOCKED") throw new Error("该月份尚未锁账，不需要申请解锁修改");
    if (code === "MONTHLY_UNLOCK_APPROVER_REQUIRED") throw new Error("只有公司范围管理员可以审批锁账修改申请");
    if (code === "MONTHLY_UNLOCK_SELF_APPROVAL_FORBIDDEN") throw new Error("申请人不能审批自己的锁账修改申请");
    if (code === "MONTHLY_UNLOCK_REQUEST_ALREADY_DECIDED") throw new Error("该锁账修改申请已处理，不能重复审批");
    if (code === "MONTHLY_CELL_HISTORY_IMMUTABLE") throw new Error("历史修订记录不可覆盖或删除");
    if (code === "FINANCE_BUSINESS_RECORD_NOT_FOUND") throw new Error("正式财务记录不存在或不属于当前门店");
    if (code === "PERFORMANCE_HAIRSTYLIST_ONLY") throw new Error("只有岗位为发型师的员工才能计入业绩和提成");
    if (code === "COMMISSION_RULE_REQUIRED") throw new Error("该员工本月业绩没有可用的提成规则，请先维护规则");
    if (code === "COMMISSION_RULE_AMBIGUOUS") throw new Error("同一业绩匹配到多条提成规则，请先停用重复规则");
    if (code === "SALARY_CONFIRMED_REVERSE_REQUIRED") throw new Error("已审核或已支付工资不能覆盖，必须先冲销");
    if (code === "SALARY_REVERSE_REQUIRED") throw new Error("该记录已进入已确认工资，请先冲销工资");
    if (code === "PAYROLL_DEPENDENCY_REVERSE_FIRST") throw new Error("该考勤已关联奖罚，请先冲销奖罚记录");
    if (code === "SALARY_TRANSITION_NOT_ALLOWED") throw new Error("工资当前状态不允许执行此操作");
    if (code === "SALARY_SHEET_LOCKED" || code === "SALARY_SHEET_NOT_DRAFT") throw new Error("工资表已确认锁定，不能直接修改");
    if (code === "SALARY_ORIGINAL_REPORT_REQUIRED") throw new Error("确认工资前必须先上传并保留原始工资报表");
    if (code === "SALARY_SHEET_EMPLOYEE_OR_TOTAL_INVALID") throw new Error("工资表存在未绑定员工或实发工资小于零的行，请先核对");
    if (code === "SALARY_SHEET_DUPLICATE_EMPLOYEE") throw new Error("同一名员工不能在本月工资表中重复出现");
    if (code === "SALARY_PAID_REVERSAL_REQUIRED") throw new Error("工资已支付，不能直接重开；请先按正式冲销流程处理");
    if (code === "SALARY_UNLOCK_APPROVER_REQUIRED") throw new Error("只有公司范围管理员可以审批工资修改申请");
    if (code === "SALARY_UNLOCK_SELF_APPROVAL_FORBIDDEN") throw new Error("申请人不能审批自己的工资修改申请");
    if (code === "SALARY_UNLOCK_REQUEST_ALREADY_DECIDED") throw new Error("该工资修改申请已处理，不能重复审批");
    if (code === "SALARY_REVISION_APPROVAL_REQUIRED") throw new Error("请先提交工资修改申请，并等待管理员批准");
    if (code === "SALARY_SHEET_HISTORY_IMMUTABLE") throw new Error("工资修改历史不可覆盖或删除");
    if (code === "INVENTORY_SCOPE_FORBIDDEN") throw new Error("当前账号没有该门店采购和库存维护权限");
    if (code === "INSUFFICIENT_INVENTORY") throw new Error("当前结存不足，不能消耗、报损或员工自购");
    if (code === "RECEIPT_EXCEEDS_ORDER") throw new Error("累计到货数量不能超过采购数量");
    if (code === "PURCHASE_ORDER_NOT_APPROVED") throw new Error("采购单尚未批准，不能办理入库");
    if (code === "PURCHASE_ORDER_TRANSITION_INVALID") throw new Error("采购单当前状态不允许执行此操作");
    if (code === "PAYMENT_EXCEEDS_PURCHASE_ORDER") throw new Error("本次付款会超过采购单金额");
    if (code === "PAYMENT_EXCEEDS_EMPLOYEE_PURCHASE") throw new Error("本次收款会超过员工自购应收金额");
    if (code === "INVENTORY_REVERSAL_REQUIRES_LATEST_TRANSACTION") throw new Error("该产品之后已有库存变动，请从最新一笔开始冲销");
    if (code === "EMPLOYEE_PURCHASE_HAS_PAYMENT") throw new Error("员工自购已有确认收款，请先冲销收款记录");
    if (/_INVALID$|_REQUIRED$/.test(code)) throw new Error("正式财务记录字段不完整或格式无效");
    if (/_NOT_FOUND$/.test(code)) throw new Error("正式财务记录不存在或不属于当前门店");
    throw new Error(`正式财务记录保存失败 (${response.status})`);
  }
  const saved = Array.isArray(data) ? data[0] : data;
  if (!saved || typeof saved !== "object") throw new Error("正式财务记录保存结果无效");
  return saved as JsonRecord;
}

async function saveDailyReport(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (cleanText(session.operations_role, 40) !== "finance" || !hasAuthCapability(session, "daily_report.write")) {
    throw new Error("只有财务账号可以提交正式日报");
  }
  const store = await selectedStoreInfo(session, payload);
  const sourceReportId = cleanText(payload.source_report_id, 40);
  const reason = cleanText(payload.reason, 500);
  if (!/^[0-9a-f-]{36}$/i.test(sourceReportId) || !reason) throw new Error("请选择日报原件并填写提交原因");
  if (!Array.isArray(payload.lines) || !payload.lines.length || payload.lines.length > 500) throw new Error("日报明细必须为 1 至 500 行");
  const lines = (payload.lines as JsonRecord[]).map((line) => {
    const lineType = cleanText(line.line_type, 30);
    const metricCode = cleanText(line.metric_code, 64).toUpperCase();
    const description = cleanText(line.description, 300);
    const sourceCellId = cleanText(line.source_report_cell_id, 40);
    if (!["income", "expense", "petty_cash", "payment", "note"].includes(lineType)
      || !/^[A-Z][A-Z0-9_]{1,63}$/.test(metricCode) || !description) throw new Error("日报明细类型、指标或说明无效");
    if (lineType === "note") return { line_type: lineType, metric_code: metricCode, description };
    if (!/^[0-9a-f-]{36}$/i.test(sourceCellId)) throw new Error("每个日报数字都必须选择原表单元格");
    return {
      line_type: lineType,
      metric_code: metricCode,
      description,
      amount: amountValue(line.amount),
      quantity: quantityValue(line.quantity),
      source_report_cell_id: sourceCellId,
    };
  });
  const businessDay = typeof payload.is_business_day === "boolean" ? payload.is_business_day : null;
  const saved = await financeRpcSaved("rpc/zysyr_save_daily_report", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40),
    p_source_report_id: sourceReportId,
    p_is_business_day: businessDay,
    p_lines: lines,
    p_reason: reason,
  });
  return { saved, formal_source: "finance_uploaded_daily_report", meiguanjia_used: false };
}

async function reviewDailyReport(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (cleanText(session.operations_role, 40) !== "finance" || !hasAuthCapability(session, "daily_report.write")) {
    throw new Error("只有财务账号可以审核正式日报");
  }
  const store = await selectedStoreInfo(session, payload);
  const reportId = cleanText(payload.daily_report_id, 40);
  const decision = cleanText(payload.decision, 20);
  const reason = cleanText(payload.reason, 500);
  if (!/^[0-9a-f-]{36}$/i.test(reportId) || !["approved", "rejected"].includes(decision) || !reason) {
    throw new Error("请完整填写日报审核决定和原因");
  }
  const saved = await financeRpcSaved("rpc/zysyr_review_daily_report", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40),
    p_daily_report_id: reportId,
    p_decision: decision,
    p_reason: reason,
  });
  return { saved, approved_income_materialized: decision === "approved", meiguanjia_used: false };
}

async function linkFinanceVoucher(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (cleanText(session.operations_role, 40) !== "finance" || !hasAuthCapability(session, "voucher.review")) {
    throw new Error("只有财务账号可以关联正式记录与凭证");
  }
  const store = await selectedStoreInfo(session, payload);
  const voucherId = cleanText(payload.voucher_id, 40);
  const businessId = cleanText(payload.business_id, 40);
  const businessType = cleanText(payload.business_type, 40);
  const relationType = cleanText(payload.relation_type, 30) || "evidence";
  const reason = cleanText(payload.reason, 500);
  if (!/^[0-9a-f-]{36}$/i.test(voucherId) || !/^[0-9a-f-]{36}$/i.test(businessId) || !reason) {
    throw new Error("请选择凭证、正式记录并填写关联原因");
  }
  const saved = await financeRpcSaved("rpc/zysyr_link_finance_voucher", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40),
    p_voucher_id: voucherId,
    p_business_type: businessType,
    p_business_id: businessId,
    p_relation_type: relationType,
    p_reason: reason,
  });
  return { saved };
}

function requirePayrollRead(session: JsonRecord): void {
  const role = cleanText(session.operations_role, 40);
  const selfEmployee = role === "employee" && /^[0-9a-f-]{36}$/i.test(cleanText(session.auth_employee_id, 40));
  if (!selfEmployee && !hasAuthCapability(session, "salary.read")) {
    throw new Error("当前账号没有工资查看权限");
  }
}

function requirePayrollWrite(session: JsonRecord): void {
  requireFinanceCapability(session, "salary.write_approve", "只有财务账号可以维护、审核和支付工资");
}

async function payrollCenter(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requirePayrollRead(session);
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const month = cleanText(payload.month, 7);
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`)) throw new Error("月份无效");
  const start = `${month}-01`;
  const endDate = new Date(`${start}T00:00:00Z`); endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const end = endDate.toISOString().slice(0, 10);
  const employeeId = cleanText(session.operations_role, 40) === "employee"
    ? cleanText(session.auth_employee_id, 40) : cleanText(payload.employee_id, 40);
  const employeeFilter = employeeId ? `&employee_id=eq.${employeeId}` : "";
  const [employees, salaries, attendance, checks, penaltyRewards, performance, rules] = await Promise.all([
    restRowsAll(`zysyr_employees?select=id,employee_code,name,position,employment_status&company_id=eq.${companyId}&store_id=eq.${storeId}&deleted_at=is.null${employeeId ? `&id=eq.${employeeId}` : ""}&order=employee_code.asc&limit=1000`, 1000),
    restRowsAll(`zysyr_salaries?select=id,employee_id,salary_month,version,source_report_id,source_salary_sheet_id,source_salary_sheet_row_id,base_salary,commission_amount,bonus_amount,deduction_amount,social_security,other_adjustment,final_salary,status,generated_at,approved_at,paid_at,reverse_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&salary_month=eq.${start}${employeeFilter}&order=employee_id.asc,version.desc&limit=3000`, 3000),
    restRowsAll(`zysyr_attendance_records?select=id,employee_id,attendance_date,attendance_type,minutes,note,status,confirmed_at,reverse_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&attendance_date=gte.${start}&attendance_date=lt.${end}${employeeFilter}&order=attendance_date.desc,created_at.desc&limit=5000`, 5000),
    restRowsAll(`zysyr_check_records?select=id,employee_id,check_date,check_type,item_name,result,note,status,confirmed_at,reverse_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&check_date=gte.${start}&check_date=lt.${end}${employeeFilter}&order=check_date.desc,created_at.desc&limit=5000`, 5000),
    restRowsAll(`zysyr_penalty_reward_records?select=id,employee_id,record_date,record_type,reason,amount,source_type,source_id,status,confirmed_at,reverse_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&record_date=gte.${start}&record_date=lt.${end}${employeeFilter}&order=record_date.desc,created_at.desc&limit=5000`, 5000),
    restRowsAll(`zysyr_performance_records?select=id,employee_id,business_date,service_item_code,revenue_amount,customer_count,source_type,source_report_cell_id,status,confirmed_at,reverse_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&business_date=gte.${start}&business_date=lt.${end}${employeeFilter}&order=business_date.desc,created_at.desc&limit=5000`, 5000),
    cleanText(session.operations_role, 40) === "employee" ? Promise.resolve([]) : restRowsAll(`zysyr_commission_rules?select=id,store_id,position,service_item_code,rate,effective_from,effective_to,status,updated_at&company_id=eq.${companyId}&or=(store_id.is.null,store_id.eq.${storeId})&order=status.asc,effective_from.desc&limit=1000`, 1000),
  ]);
  const salaryIds = salaries.map((salary) => salary.id);
  const details = salaryIds.length ? await restRowsAll(`zysyr_salary_details?select=id,salary_id,line_number,line_type,source_type,source_id,commission_rule_id,source_report_cell_id,amount,note&company_id=eq.${companyId}&store_id=eq.${storeId}&salary_id=in.${uuidIn(salaryIds)}&order=salary_id,line_number.asc&limit=10000`, 10000) : [];
  const sourceCellIds = Array.from(new Set([
    ...performance.map((item) => item.source_report_cell_id),
    ...details.map((item) => item.source_report_cell_id),
  ].map((value) => cleanText(value, 40)).filter(Boolean)));
  const sourceCells = sourceCellIds.length ? await restRowsAll(`zysyr_report_cells?select=id,report_id,sheet_name,cell_address,row_number,column_number,display_value,numeric_value,label&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(sourceCellIds)}&limit=10000`, 10000) : [];
  const entityIds = Array.from(new Set([
    ...salaries.map((item) => item.id), ...attendance.map((item) => item.id), ...checks.map((item) => item.id),
    ...penaltyRewards.map((item) => item.id), ...performance.map((item) => item.id),
  ]));
  const voucherLinks = entityIds.length ? await restRowsAll(`zysyr_voucher_links?select=voucher_id,business_type,business_id,relation_type,linked_at&company_id=eq.${companyId}&store_id=eq.${storeId}&business_id=in.${uuidIn(entityIds)}&unlinked_at=is.null&limit=10000`, 10000) : [];
  const voucherIds = Array.from(new Set(voucherLinks.map((link) => link.voucher_id)));
  const vouchers = voucherIds.length ? await restRowsAll(`zysyr_voucher_attachments?select=id,original_filename,document_type,audit_status,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(voucherIds)}&limit=5000`, 5000) : [];
  const writable = cleanText(session.operations_role, 40) === "finance" && hasAuthCapability(session, "salary.write_approve");
  const approvedVouchers = writable ? await restRowsAll(`zysyr_voucher_attachments?select=id,original_filename,document_type,audit_status,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&audit_status=eq.approved&order=uploaded_at.desc&limit=2000`, 2000) : [];
  const salaryReports = writable ? await restRowsAll(`zysyr_report_uploads?select=id,report_type,report_date,version,original_filename&company_id=eq.${companyId}&store_id=eq.${storeId}&report_type=in.(salary,performance)&status=eq.active&report_date=gte.${start}&report_date=lt.${end}&order=report_date.desc,version.desc&limit=1000`, 1000) : [];
  return {
    company_id: companyId, store_id: storeId, store: cleanText(store.name, 100), month,
    employees, salaries, salary_details: details, attendance, checks,
    penalty_rewards: penaltyRewards, performance, commission_rules: rules,
    source_cells: sourceCells, voucher_links: voucherLinks, vouchers,
    approved_vouchers: approvedVouchers, salary_reports: salaryReports,
    personal_scope: cleanText(session.operations_role, 40) === "employee",
    permissions: { read: true, write: writable },
    performance_rule: "hairstylist_only", source_boundary: "finance_uploads_only",
    meiguanjia_used: false,
  };
}

const SALARY_SHEET_ROW_SELECT = [
  "id", "sheet_id", "row_number", "employee_id", "position", "employee_name",
  "base_salary", "seniority_salary", "position_salary", "meal_allowance",
  "performance_commission", "delivery_card_commission", "overtime_activity_allowance",
  "supplemental_adjustment", "gross_pay", "product_cost", "late_early_deduction",
  "shooting_deduction", "leave_deduction", "growth_deduction", "employee_purchase",
  "employee_social_security", "total_deductions", "net_pay", "notes", "updated_at",
].join(",");

async function salarySheetData(companyId: string, storeId: string, sheetId: string): Promise<JsonRecord> {
  const sheets = await restRows(`zysyr_salary_sheet_drafts?select=id,salary_month,version,supersedes_sheet_id,revision_request_id,status,edit_revision,confirmed_by_user_id,confirmed_at,confirmation_reason,locked_by_user_id,locked_at,lock_reason,reversed_by_user_id,reversed_at,reverse_reason,created_by_user_id,updated_by_user_id,created_at,updated_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${sheetId}&limit=1`);
  const sheet = sheets[0];
  if (!sheet) throw new Error("工资电子表不存在或不属于当前门店");
  const [rows, links, changes, unlockRequests, formalSalaries] = await Promise.all([
    restRowsAll(`zysyr_salary_sheet_rows?select=${SALARY_SHEET_ROW_SELECT}&company_id=eq.${companyId}&store_id=eq.${storeId}&sheet_id=eq.${sheetId}&order=row_number.asc&limit=300`, 300),
    restRowsAll(`zysyr_salary_sheet_attachments?select=id,voucher_id,attachment_kind,note,linked_by_user_id,linked_at&company_id=eq.${companyId}&store_id=eq.${storeId}&sheet_id=eq.${sheetId}&order=linked_at.desc&limit=300`, 300),
    restRowsAll(`zysyr_salary_sheet_changes?select=id,row_id,revision,field_code,before_text,after_text,before_amount,after_amount,changed_by_user_id,changed_at,reason&company_id=eq.${companyId}&store_id=eq.${storeId}&sheet_id=eq.${sheetId}&order=changed_at.desc,id.desc&limit=2000`, 2000),
    restRowsAll(`zysyr_salary_sheet_unlock_requests?select=id,sheet_id,requested_by_user_id,request_reason,requested_at,status,decided_by_user_id,decision_reason,decided_at,consumed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&sheet_id=eq.${sheetId}&order=requested_at.desc&limit=200`, 200),
    restRowsAll(`zysyr_salaries?select=id,employee_id,salary_month,version,source_salary_sheet_id,source_salary_sheet_row_id,base_salary,commission_amount,bonus_amount,deduction_amount,social_security,other_adjustment,final_salary,status,approved_at,paid_at,reverse_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&source_salary_sheet_id=eq.${sheetId}&order=employee_id.asc,version.desc&limit=1000`, 1000),
  ]);
  const voucherIds = [...new Set(links.map((link) => cleanText(link.voucher_id, 40)).filter(Boolean))];
  const vouchers = voucherIds.length ? await restRowsAll(`zysyr_voucher_attachments?select=id,object_path,original_filename,mime_type,size_bytes,sha256,audit_status,document_type,uploaded_by,uploaded_by_user_id,uploaded_at,reviewed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(voucherIds)}&limit=300`, 300) : [];
  const actorIds = [...new Set([
    ...changes.map((change) => cleanText(change.changed_by_user_id, 40)),
    ...links.map((link) => cleanText(link.linked_by_user_id, 40)),
    ...unlockRequests.flatMap((request) => [cleanText(request.requested_by_user_id, 40), cleanText(request.decided_by_user_id, 40)]),
    cleanText(sheet.created_by_user_id, 40), cleanText(sheet.updated_by_user_id, 40),
    cleanText(sheet.confirmed_by_user_id, 40), cleanText(sheet.locked_by_user_id, 40),
  ].filter(Boolean))];
  const actors = actorIds.length ? await restRowsAll(`zysyr_user_accounts?select=id,login_name,display_name&company_id=eq.${companyId}&id=in.${uuidIn(actorIds)}&limit=500`, 500) : [];
  const actorMap = new Map(actors.map((actor) => [cleanText(actor.id, 40), cleanText(actor.display_name ?? actor.login_name, 120)]));
  const linkMap = new Map(links.map((link) => [cleanText(link.voucher_id, 40), link]));
  const attachments = await Promise.all(vouchers.map(async (voucher) => ({
    ...voucher, ...(linkMap.get(cleanText(voucher.id, 40)) || {}),
    uploaded_by_name: actorMap.get(cleanText(voucher.uploaded_by_user_id, 40)) || cleanText(voucher.uploaded_by, 120) || "已授权账号",
    private_url: await signedStorageUrl(VOUCHER_BUCKET, cleanText(voucher.object_path, 500)), url_expires_in: 300,
  })));
  const formalSalaryIds = formalSalaries.map((salary) => cleanText(salary.id, 40)).filter(Boolean);
  const salaryDetails = formalSalaryIds.length ? await restRowsAll(`zysyr_salary_details?select=id,salary_id,line_number,line_type,source_type,source_id,commission_rule_id,source_report_cell_id,amount,note&company_id=eq.${companyId}&store_id=eq.${storeId}&salary_id=in.${uuidIn(formalSalaryIds)}&order=salary_id.asc,line_number.asc&limit=5000`, 5000) : [];
  const rowMap = new Map(rows.map((row) => [cleanText(row.id, 40), row]));
  return {
    sheet, rows, attachments, formal_salaries: formalSalaries, salary_details: salaryDetails,
    history: changes.map((change) => ({
      ...change, row_number: rowMap.get(cleanText(change.row_id, 40))?.row_number ?? null,
      employee_name: rowMap.get(cleanText(change.row_id, 40))?.employee_name ?? "",
      changed_by_name: actorMap.get(cleanText(change.changed_by_user_id, 40)) || "已授权账号",
    })),
    unlock_requests: unlockRequests.map((request) => ({
      ...request,
      requested_by_name: actorMap.get(cleanText(request.requested_by_user_id, 40)) || "已授权账号",
      decided_by_name: actorMap.get(cleanText(request.decided_by_user_id, 40)) || null,
    })),
    original_count: attachments.filter((item) => cleanText(item.attachment_kind, 40) === "original_report").length,
    template_code: "自由手艺人工资表-21列", manual_entry_only: true,
    ai_recognition_enabled: false, meiguanjia_used: false,
  };
}

function salarySheetPayloadRows(value: unknown): JsonRecord[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 300) throw new Error("工资表行数无效");
  return value.map((raw) => {
    const row = raw && typeof raw === "object" ? raw as JsonRecord : {};
    return {
      id: uuidValue(row.id, "工资表行编号无效"),
      employee_id: uuidValue(row.employee_id, "员工编号无效", true),
      position: cleanText(row.position, 120), employee_name: cleanText(row.employee_name, 160),
      base_salary: amountValue(row.base_salary ?? 0), seniority_salary: amountValue(row.seniority_salary ?? 0),
      position_salary: amountValue(row.position_salary ?? 0), meal_allowance: amountValue(row.meal_allowance ?? 0),
      performance_commission: amountValue(row.performance_commission ?? 0),
      delivery_card_commission: amountValue(row.delivery_card_commission ?? 0),
      overtime_activity_allowance: amountValue(row.overtime_activity_allowance ?? 0),
      supplemental_adjustment: signedAmountValue(row.supplemental_adjustment ?? 0),
      product_cost: amountValue(row.product_cost ?? 0), late_early_deduction: amountValue(row.late_early_deduction ?? 0),
      shooting_deduction: amountValue(row.shooting_deduction ?? 0), leave_deduction: amountValue(row.leave_deduction ?? 0),
      growth_deduction: amountValue(row.growth_deduction ?? 0), employee_purchase: amountValue(row.employee_purchase ?? 0),
      employee_social_security: amountValue(row.employee_social_security ?? 0), notes: cleanText(row.notes, 1000),
    };
  });
}

async function salarySheetRead(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requirePayrollRead(session);
  if (cleanText(session.operations_role, 40) === "employee") throw new Error("员工账号只能在工资中心查看本人数据");
  const store = await selectedStoreInfo(session, payload), month = parseMonth(payload.month);
  const companyId = cleanText(store.company_id, 40), storeId = cleanText(store.id, 40);
  let sheetId = cleanText(payload.sheet_id, 40);
  if (sheetId) uuidValue(sheetId, "工资电子表编号无效");
  if (!sheetId) {
    const sheets = await restRowsAll(`zysyr_salary_sheet_drafts?select=id,status,version&company_id=eq.${companyId}&store_id=eq.${storeId}&salary_month=eq.${month}-01&order=version.desc&limit=100`, 100);
    const current = sheets.find((sheet) => ["draft", "locked"].includes(cleanText(sheet.status, 20))) || sheets[0];
    sheetId = cleanText(current?.id, 40);
  }
  const employees = await restRowsAll(`zysyr_employees?select=id,employee_code,name,position,employment_status&company_id=eq.${companyId}&store_id=eq.${storeId}&deleted_at=is.null&order=employee_code.asc,name.asc&limit=1000`, 1000);
  const writable = cleanText(session.operations_role, 40) === "finance" && hasAuthCapability(session, "salary.write_approve");
  if (!sheetId) {
    const historyEntries = await historyMonthEntries(companyId, storeId, month, "salary");
    if (historyEntries.length) {
      const batchId = cleanText(historyEntries[0].import_batch_id, 40);
      const batches = await restRows(`zysyr_history_import_batches?select=id,source_filename,created_by_user_id,created_at,confirmed_by_user_id,confirmed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${batchId}&status=eq.completed&limit=1`);
      const batch = batches[0] || {};
      const evidenceData = await historyEvidenceForEntries(companyId, storeId, historyEntries);
      const revisions = await restRowsAll(`zysyr_history_ledger_revisions?select=id,ledger_entry_id,version,action,before_payload,after_payload,reason,actor_user_id,created_at&company_id=eq.${companyId}&store_id=eq.${storeId}&import_batch_id=eq.${batchId}&order=created_at.desc&limit=5000`, 5000);
      const rows = historyEntries.map((entry, index) => {
        const current = entry.current_payload as JsonRecord;
        return {
          id: entry.id, sheet_id: batchId, row_number: index + 1, historical: true,
          history_ledger_entry_id: entry.id, import_row_id: entry.import_row_id, source_locator: entry.source_locator,
          employee_id: current.employee_id || null, position: current.position || "", employee_name: current.employee_name || "",
          base_salary: current.base_salary || 0, seniority_salary: current.seniority_salary || 0,
          position_salary: current.position_salary || 0, meal_allowance: current.meal_allowance || 0,
          performance_commission: current.performance_commission || 0,
          delivery_card_commission: current.delivery_card_commission || 0,
          overtime_activity_allowance: current.overtime_activity_allowance || 0,
          supplemental_adjustment: current.supplemental_adjustment || 0,
          product_cost: current.product_cost || 0, late_early_deduction: current.late_early_deduction || 0,
          shooting_deduction: current.shooting_deduction || 0, leave_deduction: current.leave_deduction || 0,
          growth_deduction: current.growth_deduction || 0,
          employee_purchase: current.employee_purchase_deduction || 0,
          employee_social_security: current.social_security || 0,
          gross_pay: current.gross_pay || 0, total_deductions: current.total_deduction || 0,
          net_pay: current.net_pay || 0, notes: current.notes || "",
        };
      });
      const attachments = [batch.id ? { id: batch.id, history_file_kind: "source", original_filename: batch.source_filename,
        mime_type: XLSX_MIME, attachment_kind: "original_report", uploaded_by: batch.confirmed_by_user_id || batch.created_by_user_id,
        uploaded_at: batch.confirmed_at || batch.created_at } : null,
        ...(evidenceData.evidence as JsonRecord[]).map((item) => ({ ...item, history_file_kind: "evidence", attachment_kind: "original_report" }))].filter(Boolean);
      return {
        month, historical: true, history_entries: historyEntries, history_evidence_links: evidenceData.links,
        history_ledger_revisions: revisions,
        sheet: { id: batchId, historical: true, salary_month: `${month}-01`, version: Math.max(...historyEntries.map((row) => Number(row.version || 1))), status: "locked", edit_revision: revisions.length },
        rows, attachments, history: [], unlock_requests: [], employees, formal_salaries: [], salary_details: [],
        original_count: attachments.length, manual_entry_only: true, ai_recognition_enabled: false, meiguanjia_used: false,
        permissions: { read: true, write: false, create: writable, upload_original: false,
          confirm_lock: false, request_unlock: false, approve_unlock: false },
      };
    }
    return { month, sheet: null, rows: [], attachments: [], history: [], unlock_requests: [], employees,
      original_count: 0, manual_entry_only: true, ai_recognition_enabled: false, meiguanjia_used: false,
      permissions: { read: true, write: writable, create: writable, upload_original: writable,
        confirm_lock: writable, request_unlock: writable, approve_unlock: false } };
  }
  const data = await salarySheetData(companyId, storeId, sheetId);
  const sheet = data.sheet as JsonRecord;
  const isDraft = cleanText(sheet.status, 20) === "draft";
  const canApprove = cleanText(session.operations_role, 40) === "shareholder" && hasAuthCapability(session, "finance_account.create");
  return { ...data, month, employees, readonly: !(writable && isDraft), current_user_id: cleanText(session.auth_account_id, 40),
    permissions: { read: true, write: writable && isDraft, create: writable, upload_original: writable && cleanText(sheet.status, 20) !== "reversed",
      confirm_lock: writable && isDraft, request_unlock: writable && cleanText(sheet.status, 20) === "locked", approve_unlock: canApprove } };
}

async function createSalarySheet(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requirePayrollWrite(session);
  const store = await selectedStoreInfo(session, payload), month = parseMonth(payload.month);
  const reason = cleanText(payload.reason, 500);
  if (!reason) throw new Error("请填写新建工资表原因");
  const saved = await financeRpcSaved("rpc/zysyr_create_salary_sheet", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_salary_month: `${month}-01`, p_reason: reason,
  });
  return salarySheetRead({ store: cleanText(store.name, 120), month, sheet_id: saved.id }, session);
}

async function saveSalarySheet(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requirePayrollWrite(session);
  const store = await selectedStoreInfo(session, payload), sheetId = uuidValue(payload.sheet_id, "工资电子表编号无效") as string;
  const reason = cleanText(payload.reason, 500);
  if (!reason) throw new Error("请填写工资修改原因");
  await financeRpcSaved("rpc/zysyr_save_salary_sheet", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_sheet_id: sheetId, p_rows: salarySheetPayloadRows(payload.rows), p_reason: reason,
  });
  return salarySheetRead({ store: cleanText(store.name, 120), month: parseMonth(payload.month), sheet_id: sheetId }, session);
}

async function uploadSalarySheetAttachment(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requirePayrollWrite(session);
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40), storeId = cleanText(store.id, 40);
  const sheetId = uuidValue(payload.sheet_id, "请选择需要绑定的电子工资表") as string;
  const filename = cleanText(payload.filename, 200), mime = cleanText(payload.mime_type, 120);
  const attachmentKind = cleanText(payload.attachment_kind, 40) || "original_report";
  const note = cleanText(payload.note, 500) || "上传并绑定原始工资报表";
  const allowed = ["image/jpeg", "image/png", "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
  if (!allowed.includes(mime)) throw new Error("原始工资报表支持 JPG、PNG、PDF、XLSX 或 DOCX");
  if (!filename || !["original_report", "supporting_document", "payment_proof"].includes(attachmentKind)) throw new Error("原始工资附件信息无效");
  const sheets = await restRows(`zysyr_salary_sheet_drafts?select=id,salary_month,status&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${sheetId}&limit=1`);
  if (!sheets[0] || cleanText(sheets[0].status, 20) === "reversed") throw new Error("工资电子表不存在或已被替代");
  let bytes: Uint8Array;
  try { bytes = decodeBase64(cleanText(payload.base64, 15000000)); } catch { throw new Error("原始工资附件内容无效"); }
  if (!bytes.length || bytes.length > MAX_VOUCHER_BYTES) throw new Error("原始工资附件必须小于 10MB");
  const digest = await sha256Bytes(bytes);
  const duplicates = await restRows(`zysyr_voucher_attachments?select=id,original_filename&company_id=eq.${companyId}&sha256=eq.${digest}&limit=1`);
  if (duplicates.length) throw new Error(`该原始资料已上传：${cleanText(duplicates[0].original_filename, 200) || "同一文件"}`);
  const extension = mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png"
    : mime.includes("spreadsheetml") ? "xlsx" : mime.includes("wordprocessingml") ? "docx" : "jpg";
  const voucherId = crypto.randomUUID(), month = cleanText(sheets[0].salary_month, 10).slice(0, 7);
  const objectPath = `${companyId}/${storeId}/salary-sheets/${month}/${sheetId}/${voucherId}.${extension}`;
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${VOUCHER_BUCKET}/${storagePath(objectPath)}`, {
    method: "POST", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": mime, "x-upsert": "false" },
    body: exactArrayBuffer(bytes),
  });
  if (!upload.ok) throw new Error(`原始工资附件上传失败 (${upload.status})`);
  const response = await rest("rpc/zysyr_register_salary_sheet_attachment", { method: "POST", body: JSON.stringify({
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: companyId, p_store_id: storeId,
    p_sheet_id: sheetId, p_voucher_id: voucherId, p_object_path: objectPath,
    p_original_filename: filename, p_mime_type: mime, p_size_bytes: bytes.length,
    p_sha256: digest, p_attachment_kind: attachmentKind, p_note: note,
  }) });
  if (!response.ok) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${VOUCHER_BUCKET}/${storagePath(objectPath)}`, {
      method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    const error = await response.json().catch(() => ({})) as JsonRecord;
    const code = cleanText(error.message ?? error.code, 120);
    if (code === "VOUCHER_DUPLICATE_FILE" || cleanText(error.code, 20) === "23505") throw new Error("相同原始工资资料已经上传，无需重复补传");
    throw new Error(`原始工资附件登记失败 (${response.status})`);
  }
  return { ...(await salarySheetRead({ store: cleanText(store.name, 120), month, sheet_id: sheetId }, session)), attachment_uploaded: true };
}

async function salarySheetAction(payload: JsonRecord, session: JsonRecord, action: string): Promise<JsonRecord> {
  const store = await selectedStoreInfo(session, payload), sheetId = uuidValue(payload.sheet_id, "工资电子表编号无效") as string;
  const companyId = cleanText(store.company_id, 40), storeId = cleanText(store.id, 40), reason = cleanText(payload.reason, 500);
  if (!reason) throw new Error("请填写操作原因");
  if (action === "confirm") {
    requirePayrollWrite(session);
    await financeRpcSaved("rpc/zysyr_confirm_and_lock_salary_sheet", { p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: companyId, p_store_id: storeId, p_sheet_id: sheetId, p_reason: reason });
  } else if (action === "request_unlock") {
    requirePayrollWrite(session);
    await financeRpcSaved("rpc/zysyr_request_salary_sheet_unlock", { p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: companyId, p_store_id: storeId, p_sheet_id: sheetId, p_reason: reason });
  } else if (action === "begin_revision") {
    requirePayrollWrite(session);
    const saved = await financeRpcSaved("rpc/zysyr_begin_salary_sheet_revision", { p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: companyId, p_store_id: storeId, p_sheet_id: sheetId, p_reason: reason });
    return salarySheetRead({ store: cleanText(store.name, 120), month: parseMonth(payload.month), sheet_id: saved.id }, session);
  } else throw new Error("不支持的工资表操作");
  return salarySheetRead({ store: cleanText(store.name, 120), month: parseMonth(payload.month), sheet_id: sheetId }, session);
}

async function decideSalarySheetUnlock(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (cleanText(session.operations_role, 40) !== "shareholder" || !hasAuthCapability(session, "finance_account.create")) throw new Error("只有公司范围管理员可以审批工资修改申请");
  const store = await selectedStoreInfo(session, payload), decision = cleanText(payload.decision, 20), reason = cleanText(payload.reason, 500);
  if (!["approved", "rejected"].includes(decision) || !reason) throw new Error("请填写审批决定和原因");
  await financeRpcSaved("rpc/zysyr_decide_salary_sheet_unlock", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_request_id: uuidValue(payload.request_id, "工资修改申请编号无效"), p_decision: decision, p_reason: reason,
  });
  return salarySheetRead({ store: cleanText(store.name, 120), month: parseMonth(payload.month), sheet_id: uuidValue(payload.sheet_id, "工资电子表编号无效") }, session);
}

async function recordAttendance(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requirePayrollWrite(session);
  const store = await selectedStoreInfo(session, payload);
  const date = cleanText(payload.attendance_date, 10);
  const type = cleanText(payload.attendance_type, 30);
  const minutes = Number(payload.minutes || 0);
  const reason = cleanText(payload.reason, 500);
  if (!validDate(date) || !["normal","late","leave","absent","early_leave"].includes(type)
    || !Number.isInteger(minutes) || minutes < 0 || !reason) throw new Error("请完整填写考勤类型、日期、分钟数和登记原因");
  const saved = await financeRpcSaved("rpc/zysyr_record_attendance", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_employee_id: uuidValue(payload.employee_id, "请选择员工"),
    p_attendance_date: date, p_attendance_type: type, p_minutes: minutes,
    p_note: cleanText(payload.note, 500), p_voucher_ids: voucherIdValues(payload.voucher_ids), p_reason: reason,
  });
  return { saved, formal_source: "finance_confirmed_attendance" };
}

async function recordCheck(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requirePayrollWrite(session);
  const store = await selectedStoreInfo(session, payload);
  const date = cleanText(payload.check_date, 10);
  const type = cleanText(payload.check_type, 30);
  const result = cleanText(payload.result, 20);
  const reason = cleanText(payload.reason, 500);
  if (!validDate(date) || !["appearance","hygiene","service_discipline","other"].includes(type)
    || !["pass","fail"].includes(result) || !cleanText(payload.item_name, 160) || !reason) {
    throw new Error("请完整填写检查日期、类型、项目、结果和登记原因");
  }
  const saved = await financeRpcSaved("rpc/zysyr_record_check", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_employee_id: uuidValue(payload.employee_id, "请选择员工"),
    p_check_date: date, p_check_type: type, p_item_name: cleanText(payload.item_name, 160),
    p_result: result, p_note: cleanText(payload.note, 500),
    p_voucher_ids: voucherIdValues(payload.voucher_ids), p_reason: reason,
  });
  return { saved, formal_source: "finance_confirmed_check" };
}

async function recordPenaltyReward(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requirePayrollWrite(session);
  const store = await selectedStoreInfo(session, payload);
  const date = cleanText(payload.record_date, 10);
  const type = cleanText(payload.record_type, 20);
  const sourceType = cleanText(payload.source_type, 20);
  const reason = cleanText(payload.reason, 500);
  if (!validDate(date) || !["reward","penalty"].includes(type)
    || !["attendance","check","manual"].includes(sourceType) || !reason
    || !cleanText(payload.record_reason, 500)) throw new Error("请完整填写奖罚类型、日期、事由、来源和登记原因");
  const saved = await financeRpcSaved("rpc/zysyr_record_penalty_reward", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_employee_id: uuidValue(payload.employee_id, "请选择员工"),
    p_record_date: date, p_record_type: type, p_record_reason: cleanText(payload.record_reason, 500),
    p_amount: amountValue(payload.amount), p_source_type: sourceType,
    p_source_id: uuidValue(payload.source_id, "来源记录无效", sourceType === "manual"),
    p_voucher_ids: voucherIdValues(payload.voucher_ids), p_reason: reason,
  });
  return { saved, structured_record: true };
}

async function recordPerformance(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requirePayrollWrite(session);
  const store = await selectedStoreInfo(session, payload);
  const date = cleanText(payload.business_date, 10);
  const sourceType = cleanText(payload.source_type, 30);
  const customerCount = Number(payload.customer_count || 0);
  const reason = cleanText(payload.reason, 500);
  if (!validDate(date) || !["daily_report","service_order","import"].includes(sourceType)
    || !Number.isInteger(customerCount) || customerCount < 0 || !reason) throw new Error("请完整填写业绩日期、来源、客数和登记原因");
  const saved = await financeRpcSaved("rpc/zysyr_record_performance", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_employee_id: uuidValue(payload.employee_id, "请选择员工"),
    p_business_date: date, p_service_item_code: cleanText(payload.service_item_code, 80) || null,
    p_revenue_amount: amountValue(payload.revenue_amount), p_customer_count: customerCount,
    p_source_type: sourceType, p_source_report_cell_id: uuidValue(payload.source_report_cell_id, "请选择业绩原表单元格"),
    p_reason: reason,
  });
  return { saved, performance_rule: "hairstylist_only", meiguanjia_used: false };
}

async function saveCommissionRule(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requirePayrollWrite(session);
  const store = await selectedStoreInfo(session, payload);
  const start = cleanText(payload.effective_from, 10); const end = cleanText(payload.effective_to, 10);
  const reason = cleanText(payload.reason, 500);
  if (!validDate(start) || (end && !validDate(end)) || !reason) throw new Error("请完整填写提成规则生效日期和修改原因");
  const saved = await financeRpcSaved("rpc/zysyr_upsert_commission_rule", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_rule_store_id: payload.company_wide === true ? null : cleanText(store.id, 40),
    p_rule_id: uuidValue(payload.id, "提成规则编号无效", true), p_position: cleanText(payload.position, 120) || null,
    p_service_item_code: cleanText(payload.service_item_code, 80) || null, p_rate: rateValue(payload.rate),
    p_effective_from: start, p_effective_to: end || null, p_status: cleanText(payload.status, 20) || "active",
    p_reason: reason,
  });
  return { saved, guessed_rate: false };
}

async function generateSalary(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requirePayrollWrite(session);
  const store = await selectedStoreInfo(session, payload);
  const month = cleanText(payload.salary_month, 10); const reason = cleanText(payload.reason, 500);
  if (!validDate(month) || !/^\d{4}-\d{2}-01$/.test(month) || !reason) throw new Error("请选择工资月份并填写生成原因");
  const saved = await financeRpcSaved("rpc/zysyr_generate_salary", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_employee_id: uuidValue(payload.employee_id, "请选择员工"),
    p_salary_month: month, p_source_report_id: uuidValue(payload.source_report_id, "请选择工资原表"),
    p_base_salary: amountValue(payload.base_salary),
    p_base_source_cell_id: uuidValue(payload.base_source_cell_id, "请选择底薪对应单元格", Number(payload.base_salary) === 0),
    p_social_security: amountValue(payload.social_security),
    p_social_security_source_cell_id: uuidValue(payload.social_security_source_cell_id, "请选择社保对应单元格", Number(payload.social_security) === 0),
    p_other_adjustment: signedAmountValue(payload.other_adjustment ?? 0),
    p_other_adjustment_source_cell_id: uuidValue(payload.other_adjustment_source_cell_id, "请选择其他调整对应单元格", Number(payload.other_adjustment || 0) === 0),
    p_voucher_ids: voucherIdValues(payload.voucher_ids), p_reason: reason,
  });
  return { saved, decomposed: true, guessed_rate: false };
}

async function transitionSalary(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requirePayrollWrite(session);
  const store = await selectedStoreInfo(session, payload);
  const action = cleanText(payload.action, 20); const reason = cleanText(payload.reason, 500);
  if (!["approve","pay","reverse"].includes(action) || !reason) throw new Error("请选择工资操作并填写原因");
  const paymentDate = cleanText(payload.payment_date, 10);
  if (action === "pay" && (!validDate(paymentDate) || !cleanText(payload.payment_method, 80))) throw new Error("支付工资必须填写支付日期和方式");
  const saved = await financeRpcSaved("rpc/zysyr_transition_salary", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_salary_id: uuidValue(payload.salary_id, "工资记录无效"),
    p_action: action, p_payment_date: action === "pay" ? paymentDate : null,
    p_payment_method: action === "pay" ? cleanText(payload.payment_method, 80) : null,
    p_payment_reference: action === "pay" ? cleanText(payload.payment_reference, 160) || null : null,
    p_voucher_ids: action === "pay" ? voucherIdValues(payload.voucher_ids) : [], p_reason: reason,
  });
  return { saved };
}

async function reversePayrollRecord(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requirePayrollWrite(session);
  const store = await selectedStoreInfo(session, payload);
  const type = cleanText(payload.entity_type, 40); const reason = cleanText(payload.reason, 500);
  if (!["attendance_record","check_record","penalty_reward","performance_record"].includes(type) || !reason) throw new Error("请选择待冲销记录并填写原因");
  const saved = await financeRpcSaved("rpc/zysyr_reverse_payroll_record", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_entity_type: type,
    p_entity_id: uuidValue(payload.entity_id, "待冲销记录无效"), p_reason: reason,
  });
  return { saved };
}

function requireInventoryWrite(session: JsonRecord): void {
  if (!hasAuthCapability(session, "inventory.write")) throw new Error("当前账号没有采购和库存维护权限");
}

function inventoryQuantity(value: unknown): number {
  const quantity = quantityValue(value);
  if (quantity === null || quantity <= 0) throw new Error("数量必须大于 0，最多四位小数");
  return quantity;
}

async function inventoryCenter(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const role = cleanText(session.operations_role, 40);
  if (role !== "shareholder" && role !== "finance" && role !== "store_manager") throw new Error("当前角色无权查看采购库存");
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40); const storeId = cleanText(store.id, 40);
  const month = cleanText(payload.month, 7);
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`)) throw new Error("月份无效");
  const start = `${month}-01`; const endDate = new Date(`${start}T00:00:00Z`); endDate.setUTCMonth(endDate.getUTCMonth()+1);
  const end = endDate.toISOString().slice(0,10);
  const [products,suppliers,employees,orders,balances,transactions,usage,purchases,receipts,approvedVouchers,companyStores,stockTransfers] = await Promise.all([
    restRowsAll(`zysyr_products?select=id,name,category,unit,default_cost,status&company_id=eq.${companyId}&deleted_at=is.null&order=status.asc,category.asc,name.asc&limit=5000`,5000),
    restRowsAll(`zysyr_suppliers?select=id,name,category,contact,status&company_id=eq.${companyId}&deleted_at=is.null&order=status.asc,name.asc&limit=2000`,2000),
    restRowsAll(`zysyr_employees?select=id,employee_code,name,position,employment_status&company_id=eq.${companyId}&store_id=eq.${storeId}&deleted_at=is.null&order=employee_code.asc&limit=2000`,2000),
    restRowsAll(`zysyr_purchase_orders?select=id,supplier_id,order_number,order_date,expected_date,status,receipt_status,payment_status,total_amount,notes,created_at,approved_at&company_id=eq.${companyId}&store_id=eq.${storeId}&order_date=gte.${start}&order_date=lt.${end}&order=order_date.desc,created_at.desc&limit=2000`,2000),
    restRowsAll(`zysyr_inventory_balances?select=id,product_id,quantity,moving_average_cost,inventory_value,last_posting_sequence,updated_at&company_id=eq.${companyId}&store_id=eq.${storeId}&order=updated_at.desc&limit=5000`,5000),
    restRowsAll(`zysyr_inventory_transactions?select=id,product_id,business_date,posted_at,posting_sequence,transaction_type,direction,quantity,unit_cost,total_cost,quantity_before,quantity_after,average_cost_before,average_cost_after,source_type,source_id,status,reverse_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&business_date=gte.${start}&business_date=lt.${end}&order=posting_sequence.desc&limit=5000`,5000),
    restRowsAll(`zysyr_usage_records?select=id,product_id,employee_id,usage_date,usage_type,quantity,unit_cost,total_cost,notes,status,inventory_transaction_id,confirmed_at,reverse_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&usage_date=gte.${start}&usage_date=lt.${end}&order=usage_date.desc,created_at.desc&limit=5000`,5000),
    restRowsAll(`zysyr_employee_purchases?select=id,employee_id,product_id,purchase_date,quantity,unit_price,amount,inventory_unit_cost,inventory_cost,payment_status,paid_amount,status,inventory_transaction_id,notes,approved_at,reverse_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&purchase_date=gte.${start}&purchase_date=lt.${end}&order=purchase_date.desc,created_at.desc&limit=5000`,5000),
    restRowsAll(`zysyr_goods_receipts?select=id,purchase_order_id,receipt_number,receipt_date,status,total_amount,posted_at,reverse_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&receipt_date=gte.${start}&receipt_date=lt.${end}&order=receipt_date.desc,created_at.desc&limit=3000`,3000),
    hasAuthCapability(session,"inventory.write") ? restRowsAll(`zysyr_voucher_attachments?select=id,original_filename,document_type,audit_status,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&audit_status=eq.approved&order=uploaded_at.desc&limit=2000`,2000) : Promise.resolve([]),
    restRowsAll(`zysyr_stores?select=id,name,code,status&company_id=eq.${companyId}&deleted_at=is.null&order=name.asc&limit=500`,500),
    restRowsAll(`zysyr_stock_transfers?select=id,source_store_id,destination_store_id,transfer_number,transfer_date,status,total_cost,notes,posted_at,reverse_reason&company_id=eq.${companyId}&or=(source_store_id.eq.${storeId},destination_store_id.eq.${storeId})&transfer_date=gte.${start}&transfer_date=lt.${end}&order=transfer_date.desc,created_at.desc&limit=3000`,3000),
  ]);
  const orderIds=orders.map((item)=>item.id); const receiptIds=receipts.map((item)=>item.id); const employeePurchaseIds=purchases.map((item)=>item.id); const stockTransferIds=stockTransfers.map((item)=>item.id);
  const [orderLines,receiptLines,purchasePayments,employeePurchasePayments,stockTransferLines] = await Promise.all([
    orderIds.length ? restRowsAll(`zysyr_purchase_order_lines?select=id,purchase_order_id,line_number,product_id,ordered_quantity,unit_cost,line_amount&company_id=eq.${companyId}&store_id=eq.${storeId}&purchase_order_id=in.${uuidIn(orderIds)}&order=purchase_order_id,line_number.asc&limit=10000`,10000) : Promise.resolve([]),
    receiptIds.length ? restRowsAll(`zysyr_goods_receipt_lines?select=id,goods_receipt_id,purchase_order_line_id,product_id,quantity,unit_cost,line_amount&company_id=eq.${companyId}&store_id=eq.${storeId}&goods_receipt_id=in.${uuidIn(receiptIds)}&limit=10000`,10000) : Promise.resolve([]),
    orderIds.length ? restRowsAll(`zysyr_payment_records?select=id,business_id,payment_date,payee,amount,payment_method,payment_reference,status,confirmed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&business_type=eq.purchase&business_id=in.${uuidIn(orderIds)}&limit=5000`,5000) : Promise.resolve([]),
    employeePurchaseIds.length ? restRowsAll(`zysyr_employee_purchase_payments?select=id,employee_purchase_id,payment_date,amount,payment_method,payment_reference,status,confirmed_at,reverse_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&employee_purchase_id=in.${uuidIn(employeePurchaseIds)}&limit=5000`,5000) : Promise.resolve([]),
    stockTransferIds.length ? restRowsAll(`zysyr_stock_transfer_lines?select=id,stock_transfer_id,line_number,product_id,quantity,unit_cost,total_cost,source_transaction_id,destination_transaction_id&company_id=eq.${companyId}&stock_transfer_id=in.${uuidIn(stockTransferIds)}&order=stock_transfer_id,line_number.asc&limit=10000`,10000) : Promise.resolve([]),
  ]);
  const businessIds=Array.from(new Set([...receipts,...usage,...purchases,...purchasePayments,...employeePurchasePayments,...stockTransfers].map((item)=>item.id)));
  const voucherLinks=businessIds.length ? await restRowsAll(`zysyr_voucher_links?select=voucher_id,business_type,business_id,relation_type,linked_at&company_id=eq.${companyId}&store_id=eq.${storeId}&business_id=in.${uuidIn(businessIds)}&unlinked_at=is.null&limit=10000`,10000) : [];
  const historicalEmployeePurchaseEntries=await historyMonthEntries(companyId,storeId,month,"employee_purchase");
  const historicalEmployeePurchaseEvidence=await historyEvidenceForEntries(companyId,storeId,historicalEmployeePurchaseEntries);
  const historicalEmployeePurchases=historicalEmployeePurchaseEntries.map((entry)=>{const current=entry.current_payload as JsonRecord;return{
    id:entry.id,history_ledger_entry_id:entry.id,import_row_id:entry.import_row_id,historical:true,
    purchase_date:current.transaction_date,employee_id:current.employee_id||null,employee_name:current.employee_name||"未映射员工",
    product_id:current.product_id||null,product_name:current.product_name||"未映射产品",quantity:null,
    unit_price:current.employee_purchase_price,amount:current.employee_purchase_price,inventory_cost:current.inventory_cost,
    retail_price:current.retail_price,payment_status:"historical",status:"posted",source_locator:entry.source_locator,version:entry.version};});
  const authorizedStoreNames=await availableStores(session); const authorizedStores=companyStores.filter((item)=>authorizedStoreNames.includes(cleanText(item.name,100)));
  return {company_id:companyId,store_id:storeId,store:cleanText(store.name,100),month,products,suppliers,employees,
    purchase_orders:orders,purchase_order_lines:orderLines,goods_receipts:receipts,goods_receipt_lines:receiptLines,
    balances,transactions,usage_records:usage,employee_purchases:purchases,purchase_payments:purchasePayments,
    historical_employee_purchases:historicalEmployeePurchases,
    historical_employee_purchase_evidence:historicalEmployeePurchaseEvidence.evidence,
    historical_employee_purchase_evidence_links:historicalEmployeePurchaseEvidence.links,
    employee_purchase_payments:employeePurchasePayments,stock_transfers:stockTransfers,stock_transfer_lines:stockTransferLines,
    authorized_stores:authorizedStores,voucher_links:voucherLinks,approved_vouchers:approvedVouchers,permissions:{read:true,write:hasAuthCapability(session,"inventory.write")},
    costing_method:"moving_average",source_boundary:"finance_uploaded_records_only",meiguanjia_used:false};
}

async function savePurchaseOrder(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireInventoryWrite(session); const store=await selectedStoreInfo(session,payload);
  const date=cleanText(payload.order_date,10); const expected=cleanText(payload.expected_date,10); const reason=cleanText(payload.reason,500);
  if(!validDate(date)||(expected&&!validDate(expected))||!cleanText(payload.order_number,100)||!reason) throw new Error("请完整填写采购单号、日期、供应商和保存原因");
  if(!Array.isArray(payload.lines)||!payload.lines.length||payload.lines.length>500) throw new Error("采购明细必须为 1 至 500 行");
  const lines=(payload.lines as JsonRecord[]).map((line)=>({product_id:uuidValue(line.product_id,"请选择产品"),quantity:inventoryQuantity(line.quantity),unit_cost:catalogCostValue(line.unit_cost)??0}));
  const saved=await financeRpcSaved("rpc/zysyr_save_purchase_order",{p_actor_user_id:cleanText(session.auth_account_id,40),p_company_id:cleanText(store.company_id,40),p_store_id:cleanText(store.id,40),
    p_id:uuidValue(payload.id,"采购单编号无效",true),p_supplier_id:uuidValue(payload.supplier_id,"请选择供应商"),p_order_number:cleanText(payload.order_number,100),p_order_date:date,
    p_expected_date:expected||null,p_lines:lines,p_notes:cleanText(payload.notes,500)||null,p_reason:reason});
  return {saved,receipt_independent_from_payment:true,meiguanjia_used:false};
}

async function transitionPurchaseOrder(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireInventoryWrite(session); const store=await selectedStoreInfo(session,payload); const action=cleanText(payload.action,20); const reason=cleanText(payload.reason,500);
  if(!["submit","approve","reject","cancel"].includes(action)||!reason) throw new Error("请选择采购单操作并填写原因");
  const saved=await financeRpcSaved("rpc/zysyr_transition_purchase_order",{p_actor_user_id:cleanText(session.auth_account_id,40),p_company_id:cleanText(store.company_id,40),p_store_id:cleanText(store.id,40),p_purchase_order_id:uuidValue(payload.purchase_order_id,"采购单无效"),p_action:action,p_reason:reason});
  return {saved};
}

async function postGoodsReceipt(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireInventoryWrite(session); const store=await selectedStoreInfo(session,payload); const date=cleanText(payload.receipt_date,10); const reason=cleanText(payload.reason,500);
  if(!validDate(date)||!cleanText(payload.receipt_number,100)||!reason||!Array.isArray(payload.lines)||(payload.lines as unknown[]).length===0) throw new Error("请完整填写入库单号、日期、明细和原因");
  const lines=(payload.lines as JsonRecord[]).map((line)=>({purchase_order_line_id:uuidValue(line.purchase_order_line_id,"采购明细无效"),quantity:inventoryQuantity(line.quantity)}));
  const saved=await financeRpcSaved("rpc/zysyr_post_goods_receipt",{p_actor_user_id:cleanText(session.auth_account_id,40),p_company_id:cleanText(store.company_id,40),p_store_id:cleanText(store.id,40),p_purchase_order_id:uuidValue(payload.purchase_order_id,"采购单无效"),p_receipt_number:cleanText(payload.receipt_number,100),p_receipt_date:date,p_lines:lines,p_voucher_ids:voucherIdValues(payload.voucher_ids),p_reason:reason});
  return {saved,costing_method:"moving_average",partial_receipt_supported:true};
}

async function recordInventoryUsage(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireInventoryWrite(session); const store=await selectedStoreInfo(session,payload); const date=cleanText(payload.usage_date,10); const type=cleanText(payload.usage_type,30); const reason=cleanText(payload.reason,500);
  if(!validDate(date)||!["salon_service","daily_consumable","damage","other"].includes(type)||!reason) throw new Error("请完整填写消耗日期、类型和登记原因");
  const saved=await financeRpcSaved("rpc/zysyr_record_usage",{p_actor_user_id:cleanText(session.auth_account_id,40),p_company_id:cleanText(store.company_id,40),p_store_id:cleanText(store.id,40),p_product_id:uuidValue(payload.product_id,"请选择产品"),p_employee_id:uuidValue(payload.employee_id,"员工无效",true),p_usage_date:date,p_usage_type:type,p_quantity:inventoryQuantity(payload.quantity),p_notes:cleanText(payload.notes,500)||null,p_voucher_ids:voucherIdValues(payload.voucher_ids),p_reason:reason});
  return {saved,cost_from_inventory_snapshot:true};
}

async function recordEmployeePurchase(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireInventoryWrite(session); const store=await selectedStoreInfo(session,payload); const date=cleanText(payload.purchase_date,10); const reason=cleanText(payload.reason,500);
  if(!validDate(date)||!reason) throw new Error("请完整填写员工自购日期和登记原因");
  const saved=await financeRpcSaved("rpc/zysyr_record_employee_purchase",{p_actor_user_id:cleanText(session.auth_account_id,40),p_company_id:cleanText(store.company_id,40),p_store_id:cleanText(store.id,40),p_employee_id:uuidValue(payload.employee_id,"请选择员工"),p_product_id:uuidValue(payload.product_id,"请选择产品"),p_purchase_date:date,p_quantity:inventoryQuantity(payload.quantity),p_unit_price:catalogCostValue(payload.unit_price)??0,p_notes:cleanText(payload.notes,500)||null,p_voucher_ids:voucherIdValues(payload.voucher_ids),p_reason:reason});
  return {saved,inventory_cost_from_snapshot:true};
}

async function confirmInventoryPayment(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const store=await selectedStoreInfo(session,payload); const kind=cleanText(payload.payment_kind,30); const date=cleanText(payload.payment_date,10); const reason=cleanText(payload.reason,500);
  if(!validDate(date)||!reason||!cleanText(payload.payment_method,80)) throw new Error("请完整填写收付款日期、方式和登记原因");
  if(kind==="purchase") {
    requireFinanceCapability(session,"payment.confirm","只有财务账号可以确认采购付款");
    const saved=await financeRpcSaved("rpc/zysyr_confirm_purchase_payment",{p_actor_user_id:cleanText(session.auth_account_id,40),p_company_id:cleanText(store.company_id,40),p_store_id:cleanText(store.id,40),p_purchase_order_id:uuidValue(payload.business_id,"采购单无效"),p_payment_date:date,p_amount:amountValue(payload.amount),p_payment_method:cleanText(payload.payment_method,80),p_payment_reference:cleanText(payload.payment_reference,160)||null,p_voucher_ids:voucherIdValues(payload.voucher_ids),p_reason:reason}); return {saved,payment_kind:kind};
  }
  requireInventoryWrite(session);
  const saved=await financeRpcSaved("rpc/zysyr_confirm_employee_purchase_payment",{p_actor_user_id:cleanText(session.auth_account_id,40),p_company_id:cleanText(store.company_id,40),p_store_id:cleanText(store.id,40),p_employee_purchase_id:uuidValue(payload.business_id,"员工自购记录无效"),p_payment_date:date,p_amount:amountValue(payload.amount),p_payment_method:cleanText(payload.payment_method,80),p_payment_reference:cleanText(payload.payment_reference,160)||null,p_voucher_ids:voucherIdValues(payload.voucher_ids),p_reason:reason}); return {saved,payment_kind:"employee_purchase"};
}

async function reverseInventoryRecord(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireInventoryWrite(session); const store=await selectedStoreInfo(session,payload); const type=cleanText(payload.business_type,40); const reason=cleanText(payload.reason,500);
  if(!["goods_receipt","usage_record","employee_purchase","stock_transfer"].includes(type)||!reason) throw new Error("请选择库存记录并填写冲销原因");
  const saved=await financeRpcSaved("rpc/zysyr_reverse_inventory_record",{p_actor_user_id:cleanText(session.auth_account_id,40),p_company_id:cleanText(store.company_id,40),p_store_id:cleanText(store.id,40),p_business_type:type,p_business_id:uuidValue(payload.business_id,"库存记录无效"),p_reason:reason}); return {saved};
}

async function postStockTransfer(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  requireInventoryWrite(session); const source=await selectedStoreInfo(session,payload); const destinationId=uuidValue(payload.destination_store_id,"请选择目标门店");
  const date=cleanText(payload.transfer_date,10); const reason=cleanText(payload.reason,500);
  if(!validDate(date)||!cleanText(payload.transfer_number,100)||!reason||!Array.isArray(payload.lines)||(payload.lines as unknown[]).length===0) throw new Error("请完整填写调拨单号、日期、产品和原因");
  const lines=(payload.lines as JsonRecord[]).map((line)=>({product_id:uuidValue(line.product_id,"请选择调拨产品"),quantity:inventoryQuantity(line.quantity)}));
  const saved=await financeRpcSaved("rpc/zysyr_post_stock_transfer",{p_actor_user_id:cleanText(session.auth_account_id,40),p_company_id:cleanText(source.company_id,40),p_source_store_id:cleanText(source.id,40),p_destination_store_id:destinationId,p_transfer_number:cleanText(payload.transfer_number,100),p_transfer_date:date,p_lines:lines,p_notes:cleanText(payload.notes,500)||null,p_voucher_ids:voucherIdValues(payload.voucher_ids),p_reason:reason}); return {saved,cost_from_source_snapshot:true};
}

async function reverseInventoryPayment(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const store=await selectedStoreInfo(session,payload); const type=cleanText(payload.payment_type,30); const reason=cleanText(payload.reason,500);
  if(!["purchase","employee_purchase"].includes(type)||!reason) throw new Error("请选择收付款并填写冲销原因");
  if(type==="purchase") requireFinanceCapability(session,"payment.confirm","只有财务账号可以冲销采购付款"); else requireInventoryWrite(session);
  const saved=await financeRpcSaved("rpc/zysyr_reverse_inventory_payment",{p_actor_user_id:cleanText(session.auth_account_id,40),p_company_id:cleanText(store.company_id,40),p_store_id:cleanText(store.id,40),p_payment_type:type,p_payment_id:uuidValue(payload.payment_id,"收付款记录无效"),p_reason:reason}); return {saved};
}

async function analysisCenter(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "ai_insight.read") && !hasAuthCapability(session, "question.create")
    && !hasAuthCapability(session, "question.respond")) throw new Error("当前账号没有经营分析或问答权限");
  const store = await selectedStoreInfo(session, payload);
  const month = parseMonth(payload.month);
  const companyId = cleanText(store.company_id, 40), storeId = cleanText(store.id, 40);
  const next = new Date(`${month}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
  const end = next.toISOString().slice(0, 10);
  const reports = await restRowsAll(`zysyr_monthly_reports?select=id,period_month,version,status,created_at,locked_at&company_id=eq.${companyId}&store_id=eq.${storeId}&period_month=gte.${month}-01&period_month=lt.${end}&order=version.desc&limit=100`, 100);
  const reportFilter = uuidIn(reports.map((row) => row.id));
  const [runs, questions] = await Promise.all([
    reportFilter === "()" ? [] : restRowsAll(`zysyr_ai_analysis_runs?select=id,monthly_report_id,analysis_type,status,provider,model,prompt_version,attempt,snapshot_sha256,output_json,error_message,requested_by_user_id,requested_at,completed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&monthly_report_id=in.${reportFilter}&order=requested_at.desc&limit=1000`, 1000),
    reportFilter === "()" ? [] : restRowsAll(`zysyr_questions?select=id,monthly_report_id,title,body,status,created_by_user_id,created_at,answered_at&company_id=eq.${companyId}&store_id=eq.${storeId}&monthly_report_id=in.${reportFilter}&order=created_at.desc&limit=1000`, 1000),
  ]);
  const questionFilter = uuidIn(questions.map((row) => row.id));
  const messages = questionFilter === "()" ? [] : await restRowsAll(`zysyr_question_messages?select=id,question_id,sender_user_id,sender_role,body,created_at&company_id=eq.${companyId}&store_id=eq.${storeId}&question_id=in.${questionFilter}&order=created_at.asc,id.asc&limit=5000`, 5000);
  return { month, store_id: storeId, monthly_reports: reports, analysis_runs: runs, questions, question_messages: messages,
    permissions: { request_analysis: hasAuthCapability(session, "ai_insight.read"), create_question: hasAuthCapability(session, "question.create"), respond_question: hasAuthCapability(session, "question.respond") },
    ai_provider_configured: Boolean(Deno.env.get("ZYSYR_AI_API_KEY")), evidence_mode: "immutable_monthly_snapshot", meiguanjia_used: false };
}

async function requestAiAnalysis(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "ai_insight.read")) throw new Error("当前账号没有发起经营分析的权限");
  const store = await selectedStoreInfo(session, payload), reason = cleanText(payload.reason, 500);
  const type = cleanText(payload.analysis_type, 40) || "monthly_operations";
  if (!reason || !["monthly_operations", "variance", "voucher_completeness"].includes(type)) throw new Error("请选择分析类型并填写原因");
  const saved = await financeRpcSaved("rpc/zysyr_request_ai_analysis", { p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40), p_store_id: cleanText(store.id, 40),
    p_monthly_report_id: uuidValue(payload.monthly_report_id, "请选择正式月报"), p_analysis_type: type, p_reason: reason });
  return { saved, read_only: true, citations_required: true };
}

async function createQuestion(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "question.create")) throw new Error("当前账号没有发起问题的权限");
  const store = await selectedStoreInfo(session, payload), title = cleanText(payload.title, 160), body = cleanText(payload.body, 2000);
  if (!title || !body) throw new Error("请填写问题标题和内容");
  const saved = await financeRpcSaved("rpc/zysyr_create_question", { p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40), p_store_id: cleanText(store.id, 40),
    p_monthly_report_id: uuidValue(payload.monthly_report_id, "请选择正式月报"), p_title: title, p_body: body });
  return { saved, evidence_snapshot_preserved: true };
}

async function respondQuestion(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "question.respond")) throw new Error("当前账号没有回复经营问题的权限");
  const store = await selectedStoreInfo(session, payload), body = cleanText(payload.body, 2000);
  if (!body) throw new Error("请填写回复内容");
  const saved = await financeRpcSaved("rpc/zysyr_respond_question", { p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40), p_store_id: cleanText(store.id, 40),
    p_question_id: uuidValue(payload.question_id, "问题无效"), p_body: body });
  return { saved, evidence_snapshot_preserved: true };
}

async function signedStorageUrl(bucket: string, objectPath: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${storagePath(bucket)}/${storagePath(objectPath)}`, {
    method: "POST", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  if (!response.ok) throw new Error(`原始图片链接生成失败 (${response.status})`);
  const signed = await response.json() as JsonRecord;
  const path = cleanText(signed.signedURL ?? signed.signedUrl, 2000);
  if (!path) throw new Error("原始图片链接生成失败");
  return path.startsWith("http") ? path : `${SUPABASE_URL}/storage/v1${path}`;
}

async function approvedDailyVoucher(companyId: string, storeId: string, voucherId: string): Promise<JsonRecord> {
  const rows = await restRows(`zysyr_voucher_attachments?select=id,object_path,original_filename,mime_type,size_bytes,sha256,audit_status,document_type&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${voucherId}&audit_status=eq.approved&document_type=eq.daily_report&limit=1`);
  if (!rows[0]) throw new Error("请选择当前门店已审核通过的日报原图");
  return rows[0];
}

async function voucherSourceBytes(voucher: JsonRecord): Promise<Uint8Array> {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${VOUCHER_BUCKET}/${storagePath(cleanText(voucher.object_path, 500))}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!response.ok) throw new Error(`原始日报读取失败 (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_REPORT_BYTES) throw new Error("原始日报必须小于 10MB");
  const mime = cleanText(voucher.mime_type, 80);
  if (!["image/jpeg", "image/png", "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(mime)) {
    throw new Error("原始日报支持 JPG、PNG、PDF 或 XLSX");
  }
  return bytes;
}

async function uploadDailySheetAttachment(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "daily_report.write")) throw new Error("当前账号没有上传日报原件权限");
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40), storeId = cleanText(store.id, 40);
  const draftId = uuidValue(payload.draft_id, "请选择需要绑定的电子日报");
  const filename = cleanText(payload.filename, 200), mime = cleanText(payload.mime_type, 120);
  const attachmentKind = cleanText(payload.attachment_kind, 40) || "original_report";
  const note = cleanText(payload.note, 500) || "上传并绑定原始日报附件";
  const allowed = ["image/jpeg", "image/png", "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];
  if (!allowed.includes(mime)) throw new Error("原始日报支持 JPG、PNG、PDF 或 XLSX");
  if (!filename) throw new Error("原始日报文件名无效");
  const drafts = await restRows(`zysyr_daily_sheet_drafts?select=id,report_date,status&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${draftId}&limit=1`);
  if (!drafts[0]) throw new Error("电子日报不存在或不属于当前门店");
  if (cleanText(drafts[0].status, 20) === "cancelled") throw new Error("已取消的日报不能补传原件");
  let bytes: Uint8Array;
  try { bytes = decodeBase64(cleanText(payload.base64, 15000000)); } catch { throw new Error("原始日报文件内容无效"); }
  if (!bytes.length || bytes.length > MAX_VOUCHER_BYTES) throw new Error("原始日报文件必须小于 10MB");
  const digest = await sha256Bytes(bytes);
  const duplicates = await restRows(`zysyr_voucher_attachments?select=id,original_filename&company_id=eq.${companyId}&sha256=eq.${digest}&limit=1`);
  if (duplicates.length) throw new Error(`该原始资料已上传：${cleanText(duplicates[0].original_filename, 200) || "同一文件"}`);
  const extension = mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png"
    : mime.includes("spreadsheetml") ? "xlsx" : "jpg";
  const voucherId = crypto.randomUUID();
  const reportDate = cleanText(drafts[0].report_date, 10);
  const objectPath = `${companyId}/${storeId}/daily-sheets/${reportDate}/${draftId}/${voucherId}.${extension}`;
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${VOUCHER_BUCKET}/${storagePath(objectPath)}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": mime, "x-upsert": "false" },
    body: exactArrayBuffer(bytes),
  });
  if (!upload.ok) throw new Error(`原始日报上传失败 (${upload.status})`);
  const registered = await rest("rpc/zysyr_register_daily_sheet_attachment", {
    method: "POST", body: JSON.stringify({
      p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: companyId,
      p_store_id: storeId, p_draft_id: draftId, p_voucher_id: voucherId,
      p_object_path: objectPath, p_original_filename: filename, p_mime_type: mime,
      p_size_bytes: bytes.length, p_sha256: digest, p_attachment_kind: attachmentKind, p_note: note,
    }),
  });
  if (!registered.ok) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${VOUCHER_BUCKET}/${storagePath(objectPath)}`, {
      method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    const error = await registered.json().catch(() => ({})) as JsonRecord;
    const code = cleanText(error.message ?? error.code, 120);
    if (code === "VOUCHER_DUPLICATE_FILE" || cleanText(error.code, 20) === "23505") throw new Error("相同原始资料已经上传，无需重复补传");
    if (code === "DAILY_ENTRY_SCOPE_FORBIDDEN") throw new Error("当前账号无权为该门店上传日报原件");
    throw new Error(`原始日报登记失败 (${registered.status})`);
  }
  return { ...(await dailySheetRead({ store: cleanText(store.name, 120), draft_id: draftId }, session)), attachment_uploaded: true,
    ai_recognition_enabled: false, formal_cells_unchanged: true };
}

async function dailySheetData(companyId: string, storeId: string, draftId: string): Promise<JsonRecord> {
  const drafts = await restRows(`zysyr_daily_sheet_drafts?select=id,source_voucher_id,report_date,template_code,template_version,status,source_sha256,ocr_provider,ocr_model,validation_result,edit_revision,created_at,updated_at,confirmed_at,confirm_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${draftId}&limit=1`);
  const draft = drafts[0];
  if (!draft) throw new Error("电子日报草稿不存在或不属于当前门店");
  const reportDate = cleanText(draft.report_date, 10), month = reportDate.slice(0, 7);
  const [cells, links, changes, locks] = await Promise.all([
    restRowsAll(`zysyr_daily_sheet_cells?select=id,section_code,row_key,row_label,column_code,column_label,row_number,column_number,cell_role,ocr_text,ocr_numeric,corrected_numeric,manual_text,manual_override,confidence,bbox,source_method,updated_at&company_id=eq.${companyId}&store_id=eq.${storeId}&draft_id=eq.${draftId}&order=row_number.asc,column_number.asc&limit=1000`, 1000),
    restRowsAll(`zysyr_daily_sheet_attachments?select=id,voucher_id,attachment_kind,note,linked_by_user_id,linked_at&company_id=eq.${companyId}&store_id=eq.${storeId}&draft_id=eq.${draftId}&order=linked_at.desc&limit=200`, 200),
    restRowsAll(`zysyr_daily_sheet_cell_changes?select=id,cell_id,revision,before_value,after_value,before_text,after_text,before_label,after_label,changed_by_user_id,changed_at,reason&company_id=eq.${companyId}&store_id=eq.${storeId}&draft_id=eq.${draftId}&order=changed_at.desc&limit=500`, 500),
    restRowsAll(`zysyr_period_locks?select=id,scope_type,store_id,status,locked_at,unlock_reason&company_id=eq.${companyId}&period_month=eq.${month}-01&status=eq.locked&limit=100`, 100),
  ]);
  const voucherIds = links.map((link) => cleanText(link.voucher_id, 40)).filter(Boolean);
  const legacyVoucherId = cleanText(draft.source_voucher_id, 40);
  if (legacyVoucherId && !voucherIds.includes(legacyVoucherId)) voucherIds.push(legacyVoucherId);
  const vouchers = voucherIds.length ? await restRowsAll(`zysyr_voucher_attachments?select=id,object_path,original_filename,mime_type,size_bytes,sha256,audit_status,document_type,uploaded_by,uploaded_by_user_id,uploaded_at,reviewed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(voucherIds)}&limit=200`, 200) : [];
  const actorIds = [...new Set(changes.map((change) => cleanText(change.changed_by_user_id, 40)).filter(Boolean))];
  const actors = actorIds.length ? await restRowsAll(`zysyr_user_accounts?select=id,login_name,display_name&company_id=eq.${companyId}&id=in.${uuidIn(actorIds)}&limit=200`, 200) : [];
  const actorMap = new Map(actors.map((actor) => [cleanText(actor.id, 40), cleanText(actor.display_name ?? actor.login_name, 120)]));
  const cellMap = new Map(cells.map((cell) => [cleanText(cell.id, 40), cell]));
  const linkMap = new Map(links.map((link) => [cleanText(link.voucher_id, 40), link]));
  const attachments = await Promise.all(vouchers.map(async (voucher) => ({ ...voucher,
    ...(linkMap.get(cleanText(voucher.id, 40)) || { attachment_kind: "original_report", linked_at: voucher.uploaded_at }),
    private_url: await signedStorageUrl(VOUCHER_BUCKET, cleanText(voucher.object_path, 500)),
    url_expires_in: 300,
  })));
  const primary = attachments.find((item) => ["image/jpeg", "image/png"].includes(cleanText(item.mime_type, 80))) || attachments[0] || null;
  return { draft, cells: cells.map((cell) => ({ ...cell, effective_numeric: effectiveCellValue(cell) })),
    attachments, original_image_url: primary?.private_url ?? null,
    original_filename: primary?.original_filename ?? null, image_url_expires_in: 300,
    history: changes.map((change) => { const cell = cellMap.get(cleanText(change.cell_id, 40)) || {};
      return { ...change, section_code: cell.section_code ?? null, row_label: cell.row_label ?? null,
        column_label: cell.column_label ?? null,
        changed_by_name: actorMap.get(cleanText(change.changed_by_user_id, 40)) || "已授权账号" }; }),
    locked: locks.some((lock) => cleanText(lock.scope_type, 20) === "company" || cleanText(lock.store_id, 40) === storeId),
    manual_entry_only: true, ai_values_excluded: true, final_confirmation_required: true, meiguanjia_used: false };
}

async function createDailySheetDraft(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "daily_report.write")) throw new Error("当前账号没有创建电子日报权限");
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40), storeId = cleanText(store.id, 40);
  const actorId = cleanText(session.auth_account_id, 40), reportDate = cleanText(payload.report_date, 10);
  const voucherId = uuidValue(payload.voucher_id, "请选择已审核日报原图", true), reason = cleanText(payload.reason, 500);
  if (!validDate(reportDate) || !reason) throw new Error("请填写日报日期和建表原因");
  if (voucherId) await approvedDailyVoucher(companyId, storeId, voucherId);
  const existing = await restRows(`zysyr_daily_sheet_drafts?select=id,status&company_id=eq.${companyId}&store_id=eq.${storeId}&report_date=eq.${reportDate}&status=in.(draft,confirmed)&order=created_at.desc&limit=1`);
  if (existing[0]) return dailySheetData(companyId, storeId, cleanText(existing[0].id, 40));
  const employees = await restRowsAll(`zysyr_employees?select=name,position,employee_code&company_id=eq.${companyId}&store_id=eq.${storeId}&employment_status=eq.active&deleted_at=is.null&order=employee_code.asc,name.asc&limit=200`, 200);
  const nameSeeds: JsonRecord[] = [];
  for (const employee of employees) {
    const position = cleanText(employee.position, 120), name = safeCellText(employee.name, 80);
    if (!name) continue;
    if (/技师|技工|助理/.test(position)) nameSeeds.push({ section_code: "technician", row_label: name, column_code: "subtotal", value: null });
    else if (/发型师|设计师|店长/.test(position)) nameSeeds.push({ section_code: "stylist", row_label: name, column_code: "subtotal", value: null });
  }
  const extraction: JsonRecord = { parsed: { report_date: reportDate, notes: "人工逐格填写空白日报模板", cells: nameSeeds },
    response_id: null, model: "manual-entry-v1", usage: null };
  return saveDailySheetExtraction({ companyId, storeId, actorId, reportDate, voucherId, reason,
    extraction, provider: "manual-entry", storeName: cleanText(store.name, 100) });
}

async function saveDailySheetExtraction(input: {
  companyId: string; storeId: string; actorId: string; reportDate: string; voucherId: string | null;
  reason: string; extraction: JsonRecord; provider?: string; storeName?: string;
}): Promise<JsonRecord> {
  const { companyId, storeId, actorId, reportDate, voucherId, reason, extraction } = input;
  const parsed = extraction.parsed as JsonRecord;
  const detectedDate = cleanText(parsed.report_date, 10);
  const saved = await financeRpcSaved("rpc/zysyr_create_daily_sheet_draft", {
    p_actor_user_id: actorId, p_company_id: companyId, p_store_id: storeId,
    p_report_date: reportDate, p_source_voucher_id: voucherId,
    p_ocr_provider: cleanText(input.provider, 120) || "manual-entry",
    p_ocr_model: cleanText(extraction.model, 120) || "manual-entry-v1",
    p_ocr_raw_result: { source: "employee_master_and_blank_template", ai_recognition_enabled: false,
      report_date: parsed.report_date ?? null, notes: cleanText(parsed.notes, 2000),
      seeded_row_count: Array.isArray(parsed.cells) ? parsed.cells.length : 0 },
    p_cells: dailySheetSeeds(extraction, cleanText(input.storeName, 100)), p_reason: reason,
  });
  const result = await dailySheetData(companyId, storeId, cleanText(saved.id, 40));
  return { ...result, readonly: false, permissions: { write: true, upload_original: true },
    detected_date: validDate(detectedDate) ? detectedDate : null,
    date_mismatch: validDate(detectedDate) && detectedDate !== reportDate };
}

async function importDailySheetExtraction(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  void payload; void session;
  throw new Error("日报AI候选导入已停用；请对照原图人工填写电子表格");
}

async function getDailySheetDraft(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "daily_report.write")) throw new Error("当前账号没有电子日报权限");
  return dailySheetRead(payload, session);
}

async function saveDailySheetDraft(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "daily_report.write")) throw new Error("当前账号没有修改电子日报权限");
  const store = await selectedStoreInfo(session, payload), reason = cleanText(payload.reason, 500);
  const draftId = uuidValue(payload.draft_id, "电子日报草稿无效");
  if (!reason || !Array.isArray(payload.cells) || !payload.cells.length || payload.cells.length > 1000) throw new Error("请选择修改单元格并填写复核说明");
  const cells = (payload.cells as JsonRecord[]).map((cell) => {
    const textRole = cell.cell_role === "signature" || cell.cell_role === "unclosed_order" || cell.cell_role === "note";
    const raw = cell.value == null || cell.value === "" ? null : String(cell.value);
    let value: number | string | null = null;
    if (raw != null) {
      if (textRole) {
        value = safeCellText(raw, 500);
      } else {
        const numeric = Number(raw);
        if (!Number.isFinite(numeric) || numeric < 0 || numeric > 999999999999.99) throw new Error("电子日报金额或计数无效");
        value = Math.round(numeric * 100) / 100;
      }
    }
    const id = cell.id == null || cell.id === "" ? null : uuidValue(cell.id, "电子日报单元格无效");
    if (id == null && !cell.section_code && !cell.row_key && !cell.column_code && !cell.cell_role) {
      if (raw == null && cell.row_label == null) throw new Error("电子日报单元格无效");
      return { id: null, value, row_key: cleanText(cell.row_key, 80), row_label: cell.row_label == null ? null : safeCellText(cell.row_label, 120) };
    }
    return { id, value,
      section_code: cleanText(cell.section_code, 30), row_key: cleanText(cell.row_key, 80),
      row_label: cell.row_label == null ? null : safeCellText(cell.row_label, 120),
      column_code: cleanText(cell.column_code, 80), column_label: cleanText(cell.column_label, 120),
      row_number: cell.row_number == null ? null : Number(cell.row_number),
      column_number: cell.column_number == null ? null : Number(cell.column_number),
      cell_role: cleanText(cell.cell_role, 60) };
  });
  const saved = await financeRpcSaved("rpc/zysyr_save_daily_sheet_cells", {
    p_actor_user_id: cleanText(session.auth_account_id, 40), p_company_id: cleanText(store.company_id, 40),
    p_store_id: cleanText(store.id, 40), p_draft_id: draftId, p_cells: cells, p_reason: reason,
  });
  return { saved, ...(await dailySheetRead({ store: cleanText(store.name, 120), draft_id: draftId }, session)) };
}

async function confirmDailySheetDraft(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (cleanText(session.operations_role, 40) !== "finance" || !hasAuthCapability(session, "daily_report.write")) throw new Error("只有财务账号可以最终确认电子日报");
  const store = await selectedStoreInfo(session, payload), companyId = cleanText(store.company_id, 40), storeId = cleanText(store.id, 40);
  const actorId = cleanText(session.auth_account_id, 40), draftId = uuidValue(payload.draft_id, "电子日报草稿无效"), reason = cleanText(payload.reason, 500);
  if (!reason || payload.reviewed_all !== true) throw new Error("最终确认前必须逐格核对原图并填写复核说明");
  const draftRows = await restRows(`zysyr_daily_sheet_drafts?select=id,source_voucher_id,report_date,validation_result,status&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${draftId}&limit=1`);
  const draft = draftRows[0]; if (!draft || cleanText(draft.status, 30) !== "draft") throw new Error("电子日报草稿不存在或已经确认");
  const validation = draft.validation_result && typeof draft.validation_result === "object" ? draft.validation_result as JsonRecord : {};
  if (validation.valid !== true) throw new Error("员工、项目、实做与支付合计尚未全部一致，不能最终确认");
  const voucher = await approvedDailyVoucher(companyId, storeId, cleanText(draft.source_voucher_id, 40));
  const bytes = await voucherSourceBytes(voucher), mime = cleanText(voucher.mime_type, 80);
  const extension = mime === "image/png" ? "png" : mime === "application/pdf" ? "pdf"
    : mime.includes("spreadsheetml") ? "xlsx" : "jpg";
  const objectPath = `${companyId}/${storeId}/daily/${cleanText(draft.report_date, 10)}/${crypto.randomUUID()}.${extension}`;
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${REPORT_BUCKET}/${storagePath(objectPath)}`, {
    method: "POST", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": mime, "x-upsert": "false" }, body: exactArrayBuffer(bytes),
  });
  if (!upload.ok) throw new Error(`电子日报原图归档失败 (${upload.status})`);
  const cells = await restRowsAll(`zysyr_daily_sheet_cells?select=id,section_code,row_key,row_label,column_code,column_label,row_number,column_number,cell_role,ocr_numeric,corrected_numeric,manual_text,manual_override,confidence,bbox,source_method&company_id=eq.${companyId}&store_id=eq.${storeId}&draft_id=eq.${draftId}&order=row_number.asc,column_number.asc&limit=1000`, 1000);
  const displayData = { sheet_name: "原图电子日报", range: "A1:AD60", rows: 60, columns: 30, values: [], merges: [],
    cells: cells.map((cell) => ({ ...cell, numeric_value: effectiveCellValue(cell) })),
    source_kind: "approved_daily_photo_review_grid", source_format: mime,
    source_voucher_id: draft.source_voucher_id,
    validation, original_image_preserved: true };
  try {
    const saved = await financeRpcSaved("rpc/zysyr_confirm_daily_sheet", {
      p_actor_user_id: actorId, p_company_id: companyId, p_store_id: storeId, p_draft_id: draftId,
      p_report: { original_filename: cleanText(voucher.original_filename, 200), mime_type: mime,
        size_bytes: bytes.length, sha256: await sha256Bytes(bytes), bucket_id: REPORT_BUCKET,
        object_path: objectPath, display_data: displayData },
      p_is_business_day: payload.is_business_day == null ? null : Boolean(payload.is_business_day), p_reason: reason,
    });
    return { saved, confirmed: true, formal_daily_report_created: true, income_created_from: "nonzero_stylist_atomic_cells_only", meiguanjia_used: false };
  } catch (error) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${REPORT_BUCKET}/${storagePath(objectPath)}`, {
      method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    }).catch(() => null);
    throw error;
  }
}

async function importCenter(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "daily_report.write")) throw new Error("当前账号没有真实日报导入权限");
  const store=await selectedStoreInfo(session,payload), month=parseMonth(payload.month), companyId=cleanText(store.company_id,40), storeId=cleanText(store.id,40);
  const next=new Date(`${month}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth()+1); const end=next.toISOString().slice(0,10);
  const [batches,vouchers,dailyReports,drafts]=await Promise.all([
    restRowsAll(`zysyr_import_batches?select=id,report_date,import_type,status,raw_row_count,mapped_row_count,payload_sha256,source_voucher_id,source_report_id,reason,error_message,created_at,completed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&report_date=gte.${month}-01&report_date=lt.${end}&order=created_at.desc&limit=1000`,1000),
    restRowsAll(`zysyr_voucher_attachments?select=id,object_path,original_filename,mime_type,size_bytes,ocr_status,audit_status,document_type,reviewed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&audit_status=eq.approved&document_type=eq.daily_report&order=reviewed_at.desc&limit=1000`,1000),
    restRowsAll(`zysyr_daily_reports?select=id,report_date,version,status,source_report_id,submitted_at,reviewed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&report_date=gte.${month}-01&report_date=lt.${end}&order=report_date.desc,version.desc&limit=1000`,1000),
    restRowsAll(`zysyr_daily_sheet_drafts?select=id,source_voucher_id,report_date,status,ocr_provider,ocr_model,validation_result,edit_revision,created_at,updated_at,confirmed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&report_date=gte.${month}-01&report_date=lt.${end}&order=report_date.desc,created_at.desc&limit=1000`,1000),
  ]);
  const batchFilter=uuidIn(batches.map((row)=>row.id));
  const [conflicts,reconciliations]=await Promise.all([
    batchFilter==="()"?[]:restRowsAll(`zysyr_import_conflicts?select=id,import_batch_id,conflict_type,existing_entity_type,existing_entity_id,details,resolution_status,created_at&company_id=eq.${companyId}&store_id=eq.${storeId}&import_batch_id=in.${batchFilter}&order=created_at.desc&limit=2000`,2000),
    batchFilter==="()"?[]:restRowsAll(`zysyr_reconciliation_reports?select=id,import_batch_id,daily_report_id,status,source_row_count,business_row_count,source_amount,business_amount,delta,generated_at&company_id=eq.${companyId}&store_id=eq.${storeId}&import_batch_id=in.${batchFilter}&order=generated_at.desc&limit=1000`,1000),
  ]);
  return {month,batches,vouchers,daily_reports:dailyReports,drafts,conflicts,reconciliations,
    permissions:{import:hasAuthCapability(session,"daily_report.write")},
    manual_entry_only:true,ai_recognition_enabled:false,meiguanjia_used:false};
}

function dailySheetTotal(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function dailySheetMonth(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "voucher.read") && !hasAuthCapability(session, "daily_report.write")) {
    throw new Error("当前账号没有查看日报权限");
  }
  const store = await selectedStoreInfo(session, payload), month = parseMonth(payload.month);
  const companyId = cleanText(store.company_id, 40), storeId = cleanText(store.id, 40);
  const next = new Date(`${month}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
  const end = next.toISOString().slice(0, 10);
  const [dailyReports, drafts, periodLocks] = await Promise.all([
    restRowsAll(`zysyr_daily_reports?select=id,report_date,version,status,source_report_id,submitted_at,reviewed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&report_date=gte.${month}-01&report_date=lt.${end}&order=report_date.desc,version.desc&limit=1000`, 1000),
    restRowsAll(`zysyr_daily_sheet_drafts?select=id,source_voucher_id,report_date,status,validation_result,edit_revision,created_at,updated_at,confirmed_at&company_id=eq.${companyId}&store_id=eq.${storeId}&report_date=gte.${month}-01&report_date=lt.${end}&order=report_date.desc,created_at.desc&limit=1000`, 1000),
    restRowsAll(`zysyr_period_locks?select=id,scope_type,store_id,status,locked_at&company_id=eq.${companyId}&period_month=eq.${month}-01&status=eq.locked&limit=100`, 100),
  ]);
  const locked = periodLocks.some((lock) => cleanText(lock.scope_type, 20) === "company" || cleanText(lock.store_id, 40) === storeId);
  const draftIds = drafts.map((draft) => cleanText(draft.id, 40)).filter(Boolean);
  const attachmentLinks = draftIds.length ? await restRowsAll(`zysyr_daily_sheet_attachments?select=draft_id,voucher_id&company_id=eq.${companyId}&store_id=eq.${storeId}&draft_id=in.${uuidIn(draftIds)}&limit=5000`, 5000) : [];
  const attachmentVoucherIds = [...new Set(attachmentLinks.map((link) => cleanText(link.voucher_id, 40)).filter(Boolean))];
  const attachmentVouchers = attachmentVoucherIds.length ? await restRowsAll(`zysyr_voucher_attachments?select=id,audit_status,document_type&company_id=eq.${companyId}&store_id=eq.${storeId}&id=in.${uuidIn(attachmentVoucherIds)}&limit=5000`, 5000) : [];
  const attachmentStatus = new Map(attachmentVouchers.map((voucher) => [cleanText(voucher.id, 40), cleanText(voucher.audit_status, 20)]));
  const linksByDraft = new Map<string, JsonRecord[]>();
  for (const link of attachmentLinks) {
    const draftId = cleanText(link.draft_id, 40), list = linksByDraft.get(draftId) || [];
    list.push(link); linksByDraft.set(draftId, list);
  }
  const reportIds = dailyReports.map((report) => cleanText(report.id, 40)).filter(Boolean);
  const formalLines = reportIds.length
    ? await restRowsAll(`zysyr_daily_report_lines?select=daily_report_id,line_type,amount&company_id=eq.${companyId}&store_id=eq.${storeId}&daily_report_id=in.${uuidIn(reportIds)}&line_type=eq.income&limit=10000`, 10000)
    : [];
  const formalTotals = new Map<string, number>();
  for (const line of formalLines) {
    const reportId = cleanText(line.daily_report_id, 40);
    formalTotals.set(reportId, (formalTotals.get(reportId) || 0) + Number(line.amount || 0));
  }
  const byDate = new Map<string, JsonRecord>();
  for (const draft of drafts) {
    const date = cleanText(draft.report_date, 10);
    if (byDate.has(date)) continue;
    const validation = (draft.validation_result ?? {}) as JsonRecord;
    const total = dailySheetTotal(validation.grand_total) ?? dailySheetTotal(validation.staff_atomic_total);
    const dailyLinks = linksByDraft.get(cleanText(draft.id, 40)) || [];
    const originalCount = dailyLinks.length + (draft.source_voucher_id && !dailyLinks.some((link) => cleanText(link.voucher_id, 40) === cleanText(draft.source_voucher_id, 40)) ? 1 : 0);
    const approvedOriginalCount = dailyLinks.filter((link) => attachmentStatus.get(cleanText(link.voucher_id, 40)) === "approved").length
      + (draft.source_voucher_id && !dailyLinks.some((link) => cleanText(link.voucher_id, 40) === cleanText(draft.source_voucher_id, 40)) ? 1 : 0);
    byDate.set(date, { report_date: date, draft_id: draft.id, source_voucher_id: draft.source_voucher_id,
      status: cleanText(draft.status, 20), grand_total: total, edit_revision: Number(draft.edit_revision ?? 0),
      confirmed_at: draft.confirmed_at ?? null, source: "electronic", original_count: originalCount,
      approved_original_count: approvedOriginalCount, missing_original: originalCount === 0,
      has_anomaly: validation.valid === false, locked });
  }
  for (const report of dailyReports) {
    const date = cleanText(report.report_date, 10);
    const existing = byDate.get(date);
    if (existing && existing.source === "formal") continue;
    if (existing) { existing.daily_report_id = report.id; existing.source_report_id = report.source_report_id;
      existing.version = Number(report.version ?? 1); existing.formal_status = cleanText(report.status, 20);
      if (existing.grand_total == null) existing.grand_total = formalTotals.get(cleanText(report.id, 40)) ?? null;
      continue; }
    const formalStatus = cleanText(report.status, 20);
    byDate.set(date, { report_date: date, draft_id: null, daily_report_id: report.id,
      source_report_id: report.source_report_id, version: Number(report.version ?? 1),
      status: formalStatus === "approved" || formalStatus === "locked" ? "confirmed" : formalStatus,
      grand_total: formalTotals.get(cleanText(report.id, 40)) ?? null, source: "formal",
      original_count: report.source_report_id ? 1 : 0, approved_original_count: report.source_report_id ? 1 : 0,
      missing_original: !report.source_report_id, has_anomaly: false, locked });
  }
  const days = [...byDate.values()].sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)));
  return { month, days, locked, manual_entry_only: true, ai_recognition_enabled: false, meiguanjia_used: false,
    permissions: { write: hasAuthCapability(session, "daily_report.write") } };
}

async function dailySheetRead(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  if (!hasAuthCapability(session, "voucher.read") && !hasAuthCapability(session, "daily_report.write")) {
    throw new Error("当前账号没有查看日报权限");
  }
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40), storeId = cleanText(store.id, 40);
  const draftId = uuidValue(payload.draft_id, "请选择日报草稿");
  const data = await dailySheetData(companyId, storeId, draftId);
  const actorId = cleanText(session.auth_account_id, 40), reportDate = cleanText((data.draft as JsonRecord).report_date, 10);
  const approvals = data.locked === true && actorId ? await restRowsAll(`zysyr_monthly_cell_unlock_requests?select=id,status,decided_at,decision_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&period_month=eq.${reportDate.slice(0, 7)}-01&requested_by_user_id=eq.${actorId}&status=eq.approved&consumed_at=is.null&limit=10`, 10) : [];
  const hasUnlockApproval = approvals.length > 0;
  const writable = hasAuthCapability(session, "daily_report.write")
    && cleanText((data.draft as JsonRecord).status, 20) === "draft"
    && (data.locked !== true || hasUnlockApproval);
  return { ...data, readonly: !writable, permissions: { write: writable,
    upload_original: hasAuthCapability(session, "daily_report.write") },
    daily_unlock_approved: hasUnlockApproval, daily_unlock_request_id: approvals[0]?.id ?? null };
}

async function photoDailyImport(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  void payload; void session;
  throw new Error("旧版手工文本导入已停用；请使用原图与同版电子表格复核流程");
}

async function voucherUrl(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const store = await selectedStoreInfo(session, payload);
  const voucherId = cleanText(payload.voucher_id, 80);
  const rows = await restRows(`zysyr_voucher_attachments?select=id,object_path,original_filename&company_id=eq.${cleanText(store.company_id, 40)}&store_id=eq.${cleanText(store.id, 40)}&id=eq.${encodeURIComponent(voucherId)}&limit=1`);
  const voucher = rows[0];
  if (!voucher) throw new Error("凭证不存在或无权访问");
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${VOUCHER_BUCKET}/${storagePath(cleanText(voucher.object_path, 500))}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  if (!response.ok) throw new Error(`凭证链接生成失败 (${response.status})`);
  const signed = await response.json();
  const signedPath = cleanText(signed.signedURL ?? signed.signedUrl, 2000);
  if (!signedPath) throw new Error("凭证链接生成失败");
  return { url: signedPath.startsWith("http") ? signedPath : `${SUPABASE_URL}/storage/v1${signedPath}`, expires_in: 300, filename: voucher.original_filename };
}

async function createStore(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  return saveStore(payload, session);
}

const HISTORY_IMPORT_TYPES = new Set(["monthly_profit_loss", "salary", "petty_cash", "employee_purchase"]);
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function historyImportFinance(session: JsonRecord): void {
  requireFinanceCapability(session, "expense.create_submit", "只有财务账号可以预览和确认历史数据导入");
}

async function historyImportPreview(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  historyImportFinance(session);
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const accountId = cleanText(session.auth_account_id, 40);
  const importType = cleanText(payload.import_type, 60);
  const filename = cleanText(payload.filename, 200);
  const mime = cleanText(payload.mime_type, 120);
  const reason = cleanText(payload.reason, 500);
  const year = Number(cleanText(payload.year, 4));
  const periodStart = cleanText(payload.period_start, 7);
  const periodEnd = cleanText(payload.period_end, 7);
  if (!HISTORY_IMPORT_TYPES.has(importType)) throw new Error("请选择正确的历史数据类型");
  if (mime !== XLSX_MIME || !/\.xlsx$/i.test(filename)) throw new Error("历史结构化数据请上传 XLSX 原文件");
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error("历史数据年份无效");
  if (!/^\d{4}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}$/.test(periodEnd)
      || periodStart > periodEnd) throw new Error("请选择正确的历史导入起止月份");
  if (!reason) throw new Error("请填写本次导入预览原因");
  let bytes: Uint8Array;
  try { bytes = decodeBase64(cleanText(payload.base64, 15000000)); } catch { throw new Error("历史 Excel 文件内容无效"); }
  if (!bytes.length || bytes.length > MAX_REPORT_BYTES) throw new Error("历史 Excel 文件必须小于 10MB");
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(exactArrayBuffer(bytes)); } catch { throw new Error("历史 Excel 文件无法识别或已损坏"); }
  const [employees, products] = await Promise.all([
    restRowsAll(`zysyr_employees?select=id,employee_code,name,position,employment_status&company_id=eq.${companyId}&store_id=eq.${storeId}&deleted_at=is.null&limit=3000`, 3000),
    restRowsAll(`zysyr_products?select=id,name,category,status&company_id=eq.${companyId}&deleted_at=is.null&limit=5000`, 5000),
  ]);
  const preview = parseHistoricalWorkbook(workbook, {
    import_type: importType, year, period_start: periodStart, period_end: periodEnd,
    target_store_label: cleanText(store.name, 120), employees, products,
  }) as JsonRecord;
  const parsedRows = Array.isArray(preview.rows) ? preview.rows as JsonRecord[] : [];
  const rows: JsonRecord[] = [];
  for (const row of parsedRows) {
    const raw = row.raw && typeof row.raw === "object" ? row.raw as JsonRecord : {};
    rows.push({ ...row, row_hash: await sha256(JSON.stringify(raw)) });
  }
  const sourceHash = await sha256Bytes(bytes);
  const objectPath = `${companyId}/${storeId}/history-import/${importType}/${sourceHash}/${crypto.randomUUID()}.xlsx`;
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${REPORT_BUCKET}/${storagePath(objectPath)}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": mime, "x-upsert": "false" },
    body: exactArrayBuffer(bytes),
  });
  if (!upload.ok) throw new Error(`历史 Excel 原件上传失败 (${upload.status})`);
  try {
    const saved = await rpcSaved("rpc/zysyr_stage_history_import", {
      p_actor_user_id: accountId, p_company_id: companyId, p_store_id: storeId,
      p_import_type: importType, p_source_filename: filename, p_source_mime_type: mime,
      p_source_size_bytes: bytes.length, p_source_sha256: sourceHash,
      p_source_bucket_id: REPORT_BUCKET, p_source_object_path: objectPath,
      p_source_store_label: cleanText(preview.source_store_label, 160) || null,
      p_target_store_label: cleanText(store.name, 120), p_period_start: cleanText(preview.period_start, 10),
      p_period_end: cleanText(preview.period_end, 10), p_rows: rows,
      p_source_warnings: Array.isArray(preview.source_warnings) ? preview.source_warnings : [],
      p_preview_summary: preview.summary && typeof preview.summary === "object" ? preview.summary : {},
      p_reason: reason,
    });
    return { batch: saved, preview: { ...preview, rows }, formal_ledger_written: false, original_private: true };
  } catch (error) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${REPORT_BUCKET}/${storagePath(objectPath)}`, {
      method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    throw error;
  }
}

async function historyImportRead(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  historyImportFinance(session);
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const batches = await restRowsAll(`zysyr_history_import_batches?select=id,import_type,source_filename,source_sha256,source_store_label,target_store_label,period_start,period_end,status,raw_row_count,valid_row_count,warning_row_count,invalid_row_count,imported_row_count,failed_row_count,source_warnings,preview_summary,reason,created_by_user_id,created_at,confirmed_by_user_id,confirmed_at,confirmation_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&order=created_at.desc&limit=100`, 100);
  const requested = cleanText(payload.import_batch_id, 40);
  const batchId = requested || cleanText(batches[0]?.id, 40);
  if (batchId && !batches.some((batch) => cleanText(batch.id, 40) === batchId)) throw new Error("历史导入批次不存在或不属于当前门店");
  if (!batchId) return { batches, rows: [], evidence: [], links: [], events: [], ledger_entries: [], ledger_revisions: [], formal_ledger_written: false };
  const [rows, evidence, links, events, ledgerEntries, ledgerRevisions] = await Promise.all([
    restRowsAll(`zysyr_history_import_rows?select=id,import_batch_id,source_sheet,source_row_number,source_locator,row_hash,raw_json,mapped_json,corrected_json,validation_status,validation_issues,review_status,reviewed_by_user_id,reviewed_at,review_note,reviewed_snapshot,import_status,target_business_type,target_business_id,import_error,imported_at,created_at,updated_at&company_id=eq.${companyId}&store_id=eq.${storeId}&import_batch_id=eq.${batchId}&order=source_sheet.asc,source_row_number.asc&limit=5000`, 5000),
    restRowsAll(`zysyr_history_import_evidence?select=id,import_batch_id,period_month,evidence_kind,original_filename,mime_type,size_bytes,sha256,embedded_asset_count,uploaded_by_user_id,uploaded_at&company_id=eq.${companyId}&store_id=eq.${storeId}&import_batch_id=eq.${batchId}&order=period_month.asc,uploaded_at.asc&limit=1000`, 1000),
    restRowsAll(`zysyr_history_import_row_evidence?select=id,import_batch_id,import_row_id,evidence_id,source_locator,link_level,linked_by_user_id,linked_at&company_id=eq.${companyId}&store_id=eq.${storeId}&import_batch_id=eq.${batchId}&order=linked_at.asc&limit=10000`, 10000),
    restRowsAll(`zysyr_history_import_events?select=id,import_batch_id,import_row_id,action,before_json,after_json,reason,actor_user_id,created_at&company_id=eq.${companyId}&store_id=eq.${storeId}&import_batch_id=eq.${batchId}&order=created_at.desc&limit=10000`, 10000),
    restRowsAll(`zysyr_history_ledger_entries?select=id,import_batch_id,import_row_id,entry_type,period_month,source_sheet,source_locator,posted_payload,current_payload,posted_validation_status,posted_validation_issues,posted_review_status,posted_with_warning,status,version,posted_by_user_id,posted_at,last_modified_by_user_id,last_modified_at,reversed_at,reversal_reason&company_id=eq.${companyId}&store_id=eq.${storeId}&import_batch_id=eq.${batchId}&order=source_sheet.asc,source_locator.asc&limit=5000`, 5000),
    restRowsAll(`zysyr_history_ledger_revisions?select=id,ledger_entry_id,import_batch_id,import_row_id,version,action,before_payload,after_payload,reason,actor_user_id,created_at&company_id=eq.${companyId}&store_id=eq.${storeId}&import_batch_id=eq.${batchId}&order=created_at.desc&limit=10000`, 10000),
  ]);
  return {
    batches, selected_batch_id: batchId, rows, evidence, links, events,
    ledger_entries: ledgerEntries, ledger_revisions: ledgerRevisions,
    formal_ledger_written: ledgerEntries.length > 0,
  };
}

async function historyImportSheetPreview(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  historyImportFinance(session);
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const batchId = uuidValue(payload.import_batch_id, "历史导入批次编号无效") as string;
  const batches = await restRows(`zysyr_history_import_batches?select=id,source_bucket_id,source_object_path,source_filename&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${batchId}&limit=1`);
  const batch = batches[0];
  if (!batch) throw new Error("历史导入批次不存在或不属于当前门店");
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${storagePath(cleanText(batch.source_bucket_id, 100))}/${storagePath(cleanText(batch.source_object_path, 500))}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!response.ok) throw new Error(`历史 Excel 原件读取失败 (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(exactArrayBuffer(bytes)); } catch { throw new Error("历史 Excel 原件无法读取"); }
  const sheetNames = workbook.worksheets.map((item) => cleanText(item.name, 120));
  const requested = cleanText(payload.source_sheet, 120);
  const sheet = worksheetByCleanName(workbook, requested || sheetNames[0]);
  if (!sheet || !sheetNames.includes(cleanText(sheet.name, 120))) throw new Error("历史 Excel 工作表不存在");
  const rowCount = Math.min(sheet.actualRowCount || sheet.rowCount || 0, 200);
  const columnCount = Math.min(sheet.actualColumnCount || sheet.columnCount || 0, 40);
  if (!rowCount || !columnCount) throw new Error("历史 Excel 工作表为空");
  const cells: JsonRecord[] = [];
  for (let row = 1; row <= rowCount; row += 1) {
    for (let column = 1; column <= columnCount; column += 1) {
      const cell = sheet.getCell(row, column);
      const value = displayValue(cell);
      const formula = formulaText(cell);
      if ((value === null || value === "") && !formula) continue;
      const font = cell.font || {};
      const alignment = cell.alignment || {};
      const fill = cell.fill && cell.fill.type === "pattern"
        ? cell.fill as unknown as { fgColor?: { argb?: string } } : null;
      cells.push({
        row, column, address: cell.address, value, formula: formula || null,
        number_format: cleanText(cell.numFmt, 100) || null,
        bold: Boolean(font.bold),
        horizontal: cleanText(alignment.horizontal, 20) || null,
        fill: cleanText(fill?.fgColor?.argb, 12) || null,
      });
    }
  }
  const merges = Array.isArray(sheet.model?.merges) ? sheet.model.merges.map((item) => cleanText(item, 40)) : [];
  const columnWidths: number[] = [];
  for (let column = 1; column <= columnCount; column += 1) {
    columnWidths.push(Math.max(6, Math.min(32, Number(sheet.getColumn(column).width) || 10)));
  }
  const rowHeights: number[] = [];
  for (let row = 1; row <= rowCount; row += 1) {
    rowHeights.push(Math.max(18, Math.min(72, Number(sheet.getRow(row).height) || 24)));
  }
  return {
    batch_id: batchId, source_filename: cleanText(batch.source_filename, 200),
    sheet_names: sheetNames, selected_sheet: cleanText(sheet.name, 120),
    row_count: rowCount, column_count: columnCount, cells, merges,
    column_widths: columnWidths, row_heights: rowHeights,
    formal_ledger_written: false, source_immutable: true,
  };
}

async function historyImportReview(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  historyImportFinance(session);
  const store = await selectedStoreInfo(session, payload);
  const corrected = payload.corrected_json;
  if (!corrected || typeof corrected !== "object" || Array.isArray(corrected)) throw new Error("复核后的字段格式无效");
  const reviewStatus = cleanText(payload.review_status, 30);
  if (!["confirmed", "needs_correction"].includes(reviewStatus)) throw new Error("请选择正确的人工复核结果");
  const reason = cleanText(payload.reason, 500);
  if (!reason) throw new Error("人工复核必须填写说明");
  const saved = await rpcSaved("rpc/zysyr_review_history_import_row", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40), p_store_id: cleanText(store.id, 40),
    p_import_row_id: uuidValue(payload.import_row_id, "历史明细编号无效"),
    p_corrected_json: corrected, p_review_status: reviewStatus, p_reason: reason,
  });
  return { saved, formal_ledger_written: false };
}

async function historyImportMonthConfirm(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  historyImportFinance(session);
  const store = await selectedStoreInfo(session, payload);
  const reason = cleanText(payload.reason, 500);
  if (!reason) throw new Error("月份核对完成必须填写说明");
  const saved = await rpcSaved("rpc/zysyr_confirm_history_import_month", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40), p_store_id: cleanText(store.id, 40),
    p_import_batch_id: uuidValue(payload.import_batch_id, "历史导入批次编号无效"),
    p_period_month: `${parseMonth(cleanText(payload.period_month, 7))}-01`, p_reason: reason,
  });
  return { saved, formal_ledger_written: false };
}

async function historyImportCorrect(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  historyImportFinance(session);
  const store = await selectedStoreInfo(session, payload);
  const corrected = payload.corrected_json;
  if (!corrected || typeof corrected !== "object" || Array.isArray(corrected)) throw new Error("修正后的字段格式无效");
  const status = cleanText(payload.validation_status, 20);
  if (!["valid", "warning", "invalid"].includes(status)) throw new Error("修正后的校验状态无效");
  const issues = Array.isArray(payload.validation_issues) ? payload.validation_issues : [];
  const reason = cleanText(payload.reason, 500);
  if (!reason) throw new Error("修正历史数据必须填写原因");
  const saved = await rpcSaved("rpc/zysyr_correct_history_import_row", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40), p_store_id: cleanText(store.id, 40),
    p_import_row_id: uuidValue(payload.import_row_id, "历史明细编号无效"),
    p_corrected_json: corrected, p_validation_status: status,
    p_validation_issues: issues, p_reason: reason,
  });
  return { saved, formal_ledger_written: false };
}

async function historyImportConfirm(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  historyImportFinance(session);
  const store = await selectedStoreInfo(session, payload);
  const reason = cleanText(payload.reason, 500);
  if (!reason) throw new Error("确认历史数据映射必须填写原因");
  const saved = await rpcSaved("rpc/zysyr_confirm_history_import", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40), p_store_id: cleanText(store.id, 40),
    p_import_batch_id: uuidValue(payload.import_batch_id, "历史导入批次编号无效"), p_reason: reason,
  });
  return { saved, status: "ready", formal_ledger_written: false };
}

async function historyImportPost(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  historyImportFinance(session);
  const store = await selectedStoreInfo(session, payload);
  const reason = cleanText(payload.reason, 500);
  if (!reason) throw new Error("正式入账必须填写原因");
  const saved = await rpcSaved("rpc/zysyr_post_history_import_batch", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40), p_store_id: cleanText(store.id, 40),
    p_import_batch_id: uuidValue(payload.import_batch_id, "历史导入批次编号无效"),
    p_allow_unreviewed: payload.allow_unreviewed === true, p_reason: reason,
  });
  return { saved, status: "completed", formal_ledger_written: true };
}

async function historyLedgerRevise(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  historyImportFinance(session);
  const store = await selectedStoreInfo(session, payload);
  const currentPayload = payload.current_payload;
  if (!currentPayload || typeof currentPayload !== "object" || Array.isArray(currentPayload)) {
    throw new Error("正式账修订后的字段格式无效");
  }
  const reason = cleanText(payload.reason, 500);
  if (!reason) throw new Error("修改正式账必须填写原因");
  const saved = await rpcSaved("rpc/zysyr_revise_history_ledger_entry", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40), p_store_id: cleanText(store.id, 40),
    p_ledger_entry_id: uuidValue(payload.ledger_entry_id, "正式账明细编号无效"),
    p_current_payload: currentPayload, p_reason: reason,
  });
  return { saved, formal_ledger_written: true };
}

async function historyLedgerReverse(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  historyImportFinance(session);
  const store = await selectedStoreInfo(session, payload);
  const reason = cleanText(payload.reason, 500);
  if (!reason) throw new Error("冲正正式账必须填写原因");
  const saved = await rpcSaved("rpc/zysyr_reverse_history_ledger_entry", {
    p_actor_user_id: cleanText(session.auth_account_id, 40),
    p_company_id: cleanText(store.company_id, 40), p_store_id: cleanText(store.id, 40),
    p_ledger_entry_id: uuidValue(payload.ledger_entry_id, "正式账明细编号无效"),
    p_reason: reason,
  });
  return { saved, formal_ledger_written: true };
}

async function historyImportEvidenceUpload(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  historyImportFinance(session);
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const accountId = cleanText(session.auth_account_id, 40);
  const batchId = uuidValue(payload.import_batch_id, "历史导入批次编号无效") as string;
  const period = parseMonth(cleanText(payload.period_month, 7));
  const periodMonth = `${period}-01`;
  const filename = cleanText(payload.filename, 200);
  const mime = cleanText(payload.mime_type, 120);
  const reason = cleanText(payload.reason, 500);
  const extensionByMime: Record<string, string> = {
    [DOCX_MIME]: "docx", "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png",
  };
  const extension = extensionByMime[mime];
  if (!extension || !new RegExp(`\\.${extension === "jpg" ? "jpe?g" : extension}$`, "i").test(filename)) throw new Error("凭证包支持 DOCX、PDF、JPG 或 PNG");
  if (!reason) throw new Error("上传历史凭证包必须填写说明");
  let bytes: Uint8Array;
  try { bytes = decodeBase64(cleanText(payload.base64, 15000000)); } catch { throw new Error("历史凭证包内容无效"); }
  if (!bytes.length || bytes.length > MAX_REPORT_BYTES) throw new Error("单个历史凭证包必须小于 10MB");
  let embeddedAssetCount = 0;
  if (mime === DOCX_MIME) {
    try {
      const archive = await JSZip.loadAsync(exactArrayBuffer(bytes));
      embeddedAssetCount = Object.keys(archive.files).filter((path) => /^word\/media\/[^/]+$/i.test(path) && !archive.files[path].dir).length;
    } catch { throw new Error("Word 凭证包无法读取或已损坏"); }
    if (!embeddedAssetCount) throw new Error("Word 凭证包中没有原始图片");
  }
  const fileHash = await sha256Bytes(bytes);
  const objectPath = `${companyId}/${storeId}/history-import/${batchId}/evidence/${periodMonth}/${fileHash}.${extension}`;
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${REPORT_BUCKET}/${storagePath(objectPath)}`, {
    method: "POST", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": mime, "x-upsert": "false" },
    body: exactArrayBuffer(bytes),
  });
  if (!upload.ok) throw new Error(`历史凭证包上传失败 (${upload.status})`);
  let registered = false;
  try {
    const saved = await rpcSaved("rpc/zysyr_register_history_import_evidence", {
      p_actor_user_id: accountId, p_company_id: companyId, p_store_id: storeId,
      p_import_batch_id: batchId, p_period_month: periodMonth, p_evidence_kind: "voucher_bundle",
      p_original_filename: filename, p_mime_type: mime, p_size_bytes: bytes.length, p_sha256: fileHash,
      p_bucket_id: REPORT_BUCKET, p_object_path: objectPath, p_embedded_asset_count: embeddedAssetCount,
      p_reason: reason,
    });
    registered = true;
    try {
      const linkedRows = await restRowsAll(`zysyr_history_import_row_evidence?select=id&company_id=eq.${companyId}&store_id=eq.${storeId}&import_batch_id=eq.${batchId}&evidence_id=eq.${cleanText(saved.id, 40)}&limit=5000`, 5000);
      return { saved, linked_rows: linkedRows.length, link_level: "bundle_only", formal_ledger_written: false };
    } catch {
      return { saved, linked_rows: null, link_level: "bundle_only", link_count_check_failed: true,
        formal_ledger_written: false };
    }
  } catch (error) {
    if (!registered) {
      await fetch(`${SUPABASE_URL}/storage/v1/object/${REPORT_BUCKET}/${storagePath(objectPath)}`, {
        method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      });
    }
    throw error;
  }
}

async function historyLedgerEvidenceUpload(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  historyImportFinance(session);
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const accountId = cleanText(session.auth_account_id, 40);
  const ledgerEntryId = uuidValue(payload.ledger_entry_id, "历史月报金额编号无效") as string;
  const filename = cleanText(payload.filename, 200);
  const mime = cleanText(payload.mime_type, 120);
  const reason = cleanText(payload.reason, 500);
  const extensionByMime: Record<string, string> = {
    "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png",
  };
  const extension = extensionByMime[mime];
  if (!extension || !new RegExp(`\\.${extension === "jpg" ? "jpe?g" : extension}$`, "i").test(filename)) {
    throw new Error("原始凭证支持 JPG、PNG 或 PDF");
  }
  if (!reason) throw new Error("补传原始凭证必须填写原因");
  let bytes: Uint8Array;
  try { bytes = decodeBase64(cleanText(payload.base64, 15000000)); } catch { throw new Error("原始凭证内容无效"); }
  if (!bytes.length || bytes.length > MAX_REPORT_BYTES) throw new Error("单个原始凭证必须小于 10MB");

  const entries = await restRows(`zysyr_history_ledger_entries?select=id,import_batch_id,import_row_id,period_month,status&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${ledgerEntryId}&entry_type=eq.monthly_profit_loss&status=eq.posted&limit=1`);
  const entry = entries[0];
  if (!entry) throw new Error("历史月报金额不存在或无权修改");
  const fileHash = await sha256Bytes(bytes);
  const batchId = cleanText(entry.import_batch_id, 40);
  const existing = await restRows(`zysyr_history_import_evidence?select=id&company_id=eq.${companyId}&store_id=eq.${storeId}&import_batch_id=eq.${batchId}&sha256=eq.${fileHash}&limit=1`);
  const objectPath = `${companyId}/${storeId}/history-import/${batchId}/direct/${fileHash}.${extension}`;
  let uploaded = false;
  if (!existing[0]) {
    const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${REPORT_BUCKET}/${storagePath(objectPath)}`, {
      method: "POST", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": mime, "x-upsert": "false" },
      body: exactArrayBuffer(bytes),
    });
    if (!upload.ok && upload.status !== 409) throw new Error(`原始凭证上传失败 (${upload.status})`);
    uploaded = upload.ok;
  }
  try {
    const saved = await rpcSaved("rpc/zysyr_attach_history_ledger_evidence", {
      p_actor_user_id: accountId,
      p_company_id: companyId,
      p_store_id: storeId,
      p_ledger_entry_id: ledgerEntryId,
      p_original_filename: filename,
      p_mime_type: mime,
      p_size_bytes: bytes.length,
      p_sha256: fileHash,
      p_bucket_id: REPORT_BUCKET,
      p_object_path: objectPath,
      p_reason: reason,
    });
    return { saved, reused: Boolean(existing[0]), linked: true, formal_ledger_amount_changed: false };
  } catch (error) {
    if (uploaded) {
      const registered = await restRows(`zysyr_history_import_evidence?select=id&company_id=eq.${companyId}&store_id=eq.${storeId}&import_batch_id=eq.${batchId}&sha256=eq.${fileHash}&limit=1`).catch(() => []);
      if (!registered[0]) {
        await fetch(`${SUPABASE_URL}/storage/v1/object/${REPORT_BUCKET}/${storagePath(objectPath)}`, {
          method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        });
      }
    }
    throw error;
  }
}

async function historyEvidenceImages(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const evidenceId = uuidValue(payload.evidence_id, "历史凭证编号无效") as string;
  const rows = await restRows(`zysyr_history_import_evidence?select=id,original_filename,mime_type,size_bytes,embedded_asset_count,bucket_id,object_path&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${evidenceId}&limit=1`);
  const evidence = rows[0];
  if (!evidence) throw new Error("历史凭证不存在或无权查看");
  const bucket = cleanText(evidence.bucket_id, 100);
  const objectPath = cleanText(evidence.object_path, 500);
  const filename = cleanText(evidence.original_filename, 200);
  const mime = cleanText(evidence.mime_type, 120);
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${storagePath(bucket)}/${storagePath(objectPath)}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!response.ok) throw new Error(`原始凭证图片读取失败 (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (mime.startsWith("image/") && ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)) {
    return { filename, mime_type: mime, embedded_asset_count: 1,
      images: [{ index: 1, filename, mime_type: mime, data_url: `data:${mime};base64,${bytesBase64(bytes)}` }] };
  }
  if (mime !== DOCX_MIME) {
    return { filename, mime_type: mime, embedded_asset_count: Number(evidence.embedded_asset_count || 0),
      images: [], file_url: await signedStorageUrl(bucket, objectPath), expires_in: 300 };
  }
  let archive: JSZip;
  try { archive = await JSZip.loadAsync(exactArrayBuffer(bytes)); } catch { throw new Error("Word 凭证包无法读取或已损坏"); }
  const available = Object.keys(archive.files).filter((path) => /^word\/media\/[^/]+$/i.test(path) && !archive.files[path].dir && rasterMime(path));
  const natural = (a: string, b: string) => a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });
  const ordered: string[] = [];
  try {
    const relXml = await archive.file("word/_rels/document.xml.rels")?.async("string") || "";
    const documentXml = await archive.file("word/document.xml")?.async("string") || "";
    const targets = new Map<string, string>();
    for (const tag of relXml.match(/<Relationship\b[^>]*>/gi) || []) {
      const id = tag.match(/\bId="([^"]+)"/i)?.[1];
      const target = tag.match(/\bTarget="([^"]+)"/i)?.[1];
      if (id && target && /(?:^|\/)media\//i.test(target)) targets.set(id, target.replace(/^\.\.\//, ""));
    }
    for (const match of documentXml.matchAll(/\br:embed="([^"]+)"/g)) {
      const target = targets.get(match[1]);
      if (!target) continue;
      const path = target.startsWith("word/") ? target : `word/${target}`;
      if (available.includes(path) && !ordered.includes(path)) ordered.push(path);
    }
  } catch { /* Fall back to the package's natural media order. */ }
  available.sort(natural).forEach((path) => { if (!ordered.includes(path)) ordered.push(path); });
  const images: JsonRecord[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const path = ordered[index];
    const imageMime = rasterMime(path);
    const base64 = await archive.file(path)?.async("base64");
    if (!base64 || !imageMime) continue;
    images.push({ index: index + 1, filename: path.split("/").pop(), mime_type: imageMime,
      data_url: `data:${imageMime};base64,${base64}` });
  }
  if (!images.length) throw new Error("Word 凭证包中没有可显示的 JPG、PNG、WEBP 或 GIF 原图");
  return { filename, mime_type: mime, embedded_asset_count: images.length, images };
}

async function historyImportFileUrl(payload: JsonRecord, session: JsonRecord): Promise<JsonRecord> {
  const store = await selectedStoreInfo(session, payload);
  const companyId = cleanText(store.company_id, 40);
  const storeId = cleanText(store.id, 40);
  const kind = cleanText(payload.file_kind, 20);
  const id = uuidValue(payload.id, "历史文件编号无效") as string;
  const table = kind === "source" ? "zysyr_history_import_batches" : kind === "evidence" ? "zysyr_history_import_evidence" : "";
  if (!table) throw new Error("历史文件类型无效");
  const rows = await restRows(`${table}?select=${kind === "source" ? "source_bucket_id,source_object_path,source_filename" : "bucket_id,object_path,original_filename"}&company_id=eq.${companyId}&store_id=eq.${storeId}&id=eq.${id}&limit=1`);
  if (!rows[0]) throw new Error("历史原件不存在或无权查看");
  const bucket = cleanText(kind === "source" ? rows[0].source_bucket_id : rows[0].bucket_id, 100);
  const path = cleanText(kind === "source" ? rows[0].source_object_path : rows[0].object_path, 500);
  const filename = cleanText(kind === "source" ? rows[0].source_filename : rows[0].original_filename, 200);
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${storagePath(bucket)}/${storagePath(path)}`, {
    method: "POST", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  if (!response.ok) throw new Error(`历史原件链接生成失败 (${response.status})`);
  const signed = await response.json() as JsonRecord;
  const signedPath = cleanText(signed.signedURL || signed.signedUrl || signed.path, 2000);
  return { url: signedPath.startsWith("http") ? signedPath : `${SUPABASE_URL}/storage/v1${signedPath}`, filename, expires_in: 300 };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (request.method !== "POST") return json({ error: "POST required" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "service not configured" }, 503);
  let payload: JsonRecord;
  try { payload = await request.json(); } catch { return json({ error: "请求格式错误" }, 400); }
  const operation = cleanText(payload.operation, 40);
  try {
    if (operation === "login") return json(await login(payload));
    if (operation === "shareholder_register") return json(await shareholderRegister(payload));
    if (operation === "logout") return json(await logout(payload));
    const session = await requireSession(payload, request);
    if (operation === "session") return json({ user: await sessionUser(session), expires_at: session.expires_at });
    if (cleanText(session.operations_role, 40) === "employee" && operation !== "payroll_center") {
      throw new Error("员工账号只能查看本人的工资、考勤、奖罚和业绩");
    }
    if (operation === "overview") return json(await overview(payload, session));
    if (operation === "report_acknowledge") return json(await reportAcknowledge(payload, session));
    if (operation === "monthly_summary") return json(await monthlySummary(payload, session));
    if (operation === "monthly_cell_save") return json(await monthlyCellSave(payload, session));
    if (operation === "history_monthly_cell_save") return json(await historyMonthlyCellSave(payload, session));
    if (operation === "monthly_cell_unlock_request") return json(await requestMonthlyCellUnlock(payload, session));
    if (operation === "monthly_cell_unlock_decide") return json(await decideMonthlyCellUnlock(payload, session));
    if (operation === "shareholder_registration_list") return json(await shareholderRegistrationList(payload, session));
    if (operation === "shareholder_registration_review") return json(await shareholderRegistrationReview(payload, session));
    if (operation === "catalog") return json(await catalog(payload, session));
    if (operation === "service_item_save") return json(await saveServiceItem(payload, session));
    if (operation === "product_save") return json(await saveProduct(payload, session));
    if (operation === "supplier_save") return json(await saveSupplier(payload, session));
    if (operation === "employee_save") return json(await saveEmployee(payload, session));
    if (operation === "store_save") return json(await saveStore(payload, session));
    if (operation === "report_upload") return json(await uploadReport(payload, session));
    if (operation === "report_cells") return json(await reportCells(payload, session));
    if (operation === "report_lineage") return json(await reportLineage(payload, session));
    if (operation === "cell_trace") return json(await cellTrace(payload, session));
    if (operation === "cell_trace_save") return json(await saveCellTrace(payload, session));
    if (operation === "monthly_evidence_rule_save") return json(await saveMonthlyEvidenceRule(payload, session));
    if (operation === "business_evidence_rule_save") return json(await saveBusinessEvidenceRule(payload, session));
    if (operation === "report_url") return json(await reportUrl(payload, session));
    if (operation === "finance_workbench") return json(await financeWorkbench(payload, session));
    if (operation === "petty_cash_report") return json(await pettyCashReport(payload, session));
    if (operation === "expense_category_save") return json(await saveExpenseCategory(payload, session));
    if (operation === "expense_save" || operation === "expense_submit") return json(await submitExpense(payload, session));
    if (operation === "expense_import") return json(await importExpenses(payload, session));
    if (operation === "expense_review") return json(await reviewExpense(payload, session));
    if (operation === "petty_cash_record") return json(await recordPettyCash(payload, session));
    if (operation === "cash_opening_balance_save") return json(await saveCashOpeningBalance(payload, session));
    if (operation === "expense_payment_confirm") return json(await confirmExpensePayment(payload, session));
    if (operation === "finance_record_reverse") return json(await reverseFinanceRecord(payload, session));
    if (operation === "monthly_generate") return json(await generateMonthlyReport(payload, session));
    if (operation === "monthly_transition") return json(await transitionMonthlyReport(payload, session));
    if (operation === "voucher_upload") return json(await uploadVoucher(payload, session));
    if (operation === "voucher_center") return json(await voucherCenter(payload, session));
    if (operation === "voucher_review") return json(await reviewVoucher(payload, session));
    if (operation === "voucher_ocr_retry") return json(await retryVoucherOcr(payload, session));
    if (operation === "voucher_ocr_wake") return json(await wakeVoucherOcr(payload, session));
    if (operation === "daily_report_save") return json(await saveDailyReport(payload, session));
    if (operation === "daily_report_review") return json(await reviewDailyReport(payload, session));
    if (operation === "finance_voucher_link") return json(await linkFinanceVoucher(payload, session));
    if (operation === "payroll_center") return json(await payrollCenter(payload, session));
    if (operation === "salary_sheet_read") return json(await salarySheetRead(payload, session));
    if (operation === "salary_sheet_create") return json(await createSalarySheet(payload, session));
    if (operation === "salary_sheet_save") return json(await saveSalarySheet(payload, session));
    if (operation === "salary_sheet_attachment_upload") return json(await uploadSalarySheetAttachment(payload, session));
    if (operation === "salary_sheet_confirm_lock") return json(await salarySheetAction(payload, session, "confirm"));
    if (operation === "salary_sheet_unlock_request") return json(await salarySheetAction(payload, session, "request_unlock"));
    if (operation === "salary_sheet_revision_begin") return json(await salarySheetAction(payload, session, "begin_revision"));
    if (operation === "salary_sheet_unlock_decide") return json(await decideSalarySheetUnlock(payload, session));
    if (operation === "attendance_record") return json(await recordAttendance(payload, session));
    if (operation === "check_record") return json(await recordCheck(payload, session));
    if (operation === "penalty_reward_record") return json(await recordPenaltyReward(payload, session));
    if (operation === "performance_record") return json(await recordPerformance(payload, session));
    if (operation === "commission_rule_save") return json(await saveCommissionRule(payload, session));
    if (operation === "salary_generate") return json(await generateSalary(payload, session));
    if (operation === "salary_transition") return json(await transitionSalary(payload, session));
    if (operation === "payroll_record_reverse") return json(await reversePayrollRecord(payload, session));
    if (operation === "inventory_center") return json(await inventoryCenter(payload, session));
    if (operation === "purchase_order_save") return json(await savePurchaseOrder(payload, session));
    if (operation === "purchase_order_transition") return json(await transitionPurchaseOrder(payload, session));
    if (operation === "goods_receipt_post") return json(await postGoodsReceipt(payload, session));
    if (operation === "inventory_usage_record") return json(await recordInventoryUsage(payload, session));
    if (operation === "employee_purchase_record") return json(await recordEmployeePurchase(payload, session));
    if (operation === "inventory_payment_confirm") return json(await confirmInventoryPayment(payload, session));
    if (operation === "inventory_record_reverse") return json(await reverseInventoryRecord(payload, session));
    if (operation === "stock_transfer_post") return json(await postStockTransfer(payload, session));
    if (operation === "inventory_payment_reverse") return json(await reverseInventoryPayment(payload, session));
    if (operation === "analysis_center") return json(await analysisCenter(payload, session));
    if (operation === "ai_analysis_request") return json(await requestAiAnalysis(payload, session));
    if (operation === "question_create") return json(await createQuestion(payload, session));
    if (operation === "question_respond") return json(await respondQuestion(payload, session));
    if (operation === "import_center") return json(await importCenter(payload, session));
    if (operation === "daily_sheet_create") return json(await createDailySheetDraft(payload, session));
    if (operation === "daily_sheet_import_candidates") return json(await importDailySheetExtraction(payload, session));
    if (operation === "daily_sheet_get") return json(await getDailySheetDraft(payload, session));
    if (operation === "daily_sheet_save") return json(await saveDailySheetDraft(payload, session));
    if (operation === "daily_sheet_confirm") return json(await confirmDailySheetDraft(payload, session));
    if (operation === "daily_sheet_attachment_upload") return json(await uploadDailySheetAttachment(payload, session));
    if (operation === "daily_sheet_month") return json(await dailySheetMonth(payload, session));
    if (operation === "daily_sheet_read") return json(await dailySheetRead(payload, session));
    if (operation === "photo_daily_import") return json(await photoDailyImport(payload, session));
    if (operation === "history_import_preview") return json(await historyImportPreview(payload, session));
    if (operation === "history_import_read") return json(await historyImportRead(payload, session));
    if (operation === "history_import_sheet_preview") return json(await historyImportSheetPreview(payload, session));
    if (operation === "history_import_review") return json(await historyImportReview(payload, session));
    if (operation === "history_import_month_confirm") return json(await historyImportMonthConfirm(payload, session));
    if (operation === "history_import_correct") return json(await historyImportCorrect(payload, session));
    if (operation === "history_import_confirm") return json(await historyImportConfirm(payload, session));
    if (operation === "history_import_post") return json(await historyImportPost(payload, session));
    if (operation === "history_ledger_revise") return json(await historyLedgerRevise(payload, session));
    if (operation === "history_ledger_reverse") return json(await historyLedgerReverse(payload, session));
    if (operation === "history_import_evidence_upload") return json(await historyImportEvidenceUpload(payload, session));
    if (operation === "history_ledger_evidence_upload") return json(await historyLedgerEvidenceUpload(payload, session));
    if (operation === "history_evidence_images") return json(await historyEvidenceImages(payload, session));
    if (operation === "history_import_file_url") return json(await historyImportFileUrl(payload, session));
    if (operation === "voucher_url") return json(await voucherUrl(payload, session));
    if (operation === "store_create") return json(await createStore(payload, session));
    return json({ error: "不支持的操作" }, 400);
  } catch (error) {
    const message = (error as Error).message || "请求失败";
    const authError = /登录|账号|密码|权限|离职|无权/.test(message);
    return json({ error: message }, authError ? 403 : 400);
  }
});
