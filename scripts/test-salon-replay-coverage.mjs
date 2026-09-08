import fs from 'node:fs';
import assert from 'node:assert/strict';
const definitions=new Map();
for(const file of fs.readdirSync('supabase/migrations').filter(f=>/_salon_.*\.sql$/.test(f)).sort()){
 const source=fs.readFileSync('supabase/migrations/'+file,'utf8');
 for(const match of source.matchAll(/create (?:or replace )?function public\.(\w+)\([\s\S]*?\$\$;/g))definitions.set(match[1],match[0]);
}
let covered=0;
for(const [name,source] of definitions){
 const signature=source.match(/^create (?:or replace )?function public\.\w+\(([\s\S]*?)\)\s*returns/)?.[1];
 if(!signature?.includes('p_actor_staff_id')||!signature.includes('p_request_key')||name==='salon_refund_order')continue;
 const guard=source.match(/\w+:=salon_private\.claim_staff_request\([\s\S]*?\);/)?.[0]||source.match(/perform salon_private\.claim_time_context\([\s\S]*?\);/)?.[0];assert.ok(guard,name+' bypasses staff fingerprint');
 for(const p of signature.split(',').map(s=>s.trim().split(/\s+/)[0]).filter(p=>p!=='p_request_key'))
  assert.ok(guard.includes("'"+p+"',"+p),'missing payload parameter '+name+'.'+p);
 assert.doesNotMatch(source,/:=salon_private\.claim_request\(/);
 covered++;
}
assert.equal(covered,42,'all current employee request-key mutations must be guarded');
for(const name of ['salon_create_role','salon_list_payroll']){
 const source=definitions.get(name);assert.match(source,/a\.effective_from<=current_date/);assert.match(source,/a\.effective_to>=current_date/);
}
assert.match(definitions.get('salon_create_staff'),/assert_role_scope_admin/);
assert.match(definitions.get('salon_create_staff'),/insert into public\.salon_staff_store_roles/);
const commission=definitions.get('salon_create_commission_rule');
assert.ok(commission.indexOf('return v_op.response_json')<commission.indexOf('if exists(select 1 from public.salon_commission_rules'));
assert.match(commission,/public\.salon_stores[^;]+for no key update/);
const retired=fs.readFileSync('supabase/migrations/20260906081946_salon_refund_execution.sql','utf8');
assert.match(retired,/revoke execute on function public.salon_refund_order\([^;]+from service_role/);
console.log(`Salon replay coverage passed: ${covered} employee request-key mutations, expiry guards, initial staff roles, serialized commission rules`);
