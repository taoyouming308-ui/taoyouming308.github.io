// Explicit transport boundary. No storage, inferred IDs, automatic retries or offline fallback.
import {withRequestDeadline} from './request-deadline.mjs';
export class SalonClientError extends Error {
  constructor(code, message, requestId = null) { super(message); this.code = code; this.requestId = requestId; }
}
const fail = (code, message) => { throw new SalonClientError(code, message); };
export function serverId(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail('INVALID_ID', '必须使用接口返回的安全整数 ID');
  return Number(value);
}
export function amountToCents(value) {
  const text = String(value);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) fail('INVALID_AMOUNT', '金额必须是非负、最多两位小数');
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_AMOUNT', '金额超出安全范围');
  return Number(cents);
}
export function orderEditVersion(value){
  if(!Number.isInteger(value)||value<0||value>2147483647)fail('INVALID_VERSION','订单编辑版本无效，请只读核对原订单');
  return value;
}
export function mapRows(resource, rows, scope) {
  if (!Array.isArray(rows)) fail('INVALID_RESPONSE', '接口列表格式无效');
  const base = { organizationId: serverId(scope.organizationId), storeId: serverId(scope.storeId) };
  return rows.map(row => {
    if (resource === 'customers') return Object.freeze({ ...base, id: serverId(row.customer_id), displayName: row.display_name,
      phoneMasked: row.phone_masked, status: row.status });
    if (resource === 'catalog') return Object.freeze({ ...base, id: serverId(row.catalog_item_id), name: row.name,
      itemType: row.item_type, status: row.status, listPriceCents: amountToCents(row.list_price) });
    fail('UNSUPPORTED_RESOURCE', '尚未定义该资源映射');
  });
}
const reads = new Set(['context', 'stores', 'customers', 'catalog', 'order_detail', 'booking_requests', 'reschedule_requests', 'store_time', 'request_lookup']);
const writes = new Set(['customer_create', 'order_create', 'order_lines', 'booking_cancel_review', 'booking_reschedule', 'reschedule_review']);
export function createSalonClient({ endpoint, getAccessToken, fetchImpl = globalThis.fetch, makeKey = () => crypto.randomUUID(), onAuthFailure = () => {}, requestTimeoutMs = 30000 }) {
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120000)
    fail('INVALID_TIMEOUT', '请求等待时间必须在 1—120000 毫秒之间');
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))))
    fail('INVALID_ENDPOINT', '接口必须显式配置为 HTTPS 或本机测试地址');
  let scope = null, generation = 0;
  const tickets = new WeakMap();
  const snapshot = () => scope && Object.freeze({ ...scope });
  const current = epoch => { if (generation !== epoch) fail('STALE_SCOPE', '门店或身份已变化，请重新读取'); };
  const invalidateAuth = () => {
    scope = null; generation++;
    try { onAuthFailure(); } catch { /* A failed UI listener must not restore access. */ }
  };
  async function send(body, epoch) {
    const token = await getAccessToken(); current(epoch);
    if (typeof token !== 'string' || token.length < 20) fail('AUTH_REQUIRED', '请重新登录');
    let response, payload;
    try {
      payload = await withRequestDeadline(async signal => {
        response = await fetchImpl(url.href, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
        return response.json();
      }, requestTimeoutMs);
    } catch {
      current(epoch);
      if (response?.status === 401) { invalidateAuth(); fail('AUTH_REQUIRED', '登录已失效，请重新连接'); }
      fail('OUTCOME_UNKNOWN', '未收到有效结果；写入请使用原请求重试，不要新建请求');
    }
    current(epoch);
    if (!response.ok || payload?.error) {
      const error = new SalonClientError('API_REJECTED', payload?.error || '接口拒绝请求', payload?.requestId);
      error.httpStatus = response.status;
      if (response.status === 401 || ['AUTH_REQUIRED', 'STAFF_INACTIVE'].includes(payload?.code)) {
        invalidateAuth();
      }
      throw error;
    }
    if (!payload || !Object.hasOwn(payload, 'data')) fail('OUTCOME_UNKNOWN', '返回格式无效，请核对原请求');
    return payload;
  }
  return {
    get scope() { return snapshot(); },
    disconnect() { scope = null; generation++; },
    async connect(storeId) {
      const selected = storeId == null ? null : serverId(storeId);
      scope = null; const epoch = ++generation;
      const result = await send({ operation: 'context', ...(selected == null ? {} : { storeId: selected }) }, epoch);
      const data = result.data;
      const next = { organizationId: serverId(data.organizationId), storeId: serverId(data.storeId), staffId: serverId(data.staffId) };
      if (selected != null && selected !== next.storeId) fail('SCOPE_MISMATCH', '接口返回了错误门店');
      scope = next; return snapshot();
    },
    async read(operation, fields = {}) {
      if (!reads.has(operation) || !scope) fail('INVALID_READ', '请先连接并选择有效门店');
      return send({ ...fields, operation, storeId: scope.storeId }, generation);
    },
    prepare(operation, fields) {
      if (!writes.has(operation) || !scope) fail('INVALID_WRITE', '尚未接入该写入或未选择门店');
      for (const key of ['operation', 'storeId', 'organizationId', 'actorStaffId', 'requestKey'])
        if (Object.hasOwn(fields, key)) fail('RESERVED_FIELD', '身份、门店和请求号由统一接口层管理');
      const requestKey = makeKey();
      if (!/^[A-Za-z0-9._:-]{16,120}$/.test(requestKey)) fail('INVALID_KEY', '请求号无效');
      const ticket = Object.freeze({ requestKey, operation });
      const body = JSON.parse(JSON.stringify({ ...fields, operation, storeId: scope.storeId, requestKey }));
      tickets.set(ticket, { body, epoch: generation, pending: null });
      return ticket;
    },
    submit(ticket) {
      const state = tickets.get(ticket);
      if (!state) fail('INVALID_TICKET', '请使用本会话创建的请求');
      current(state.epoch);
      // Manual retry reuses the frozen payload/key. Concurrent clicks share one request.
      if (!state.pending) state.pending = send(state.body, state.epoch).finally(() => { state.pending = null; });
      return state.pending;
    },
  };
}
