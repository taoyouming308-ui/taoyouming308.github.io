const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');
const source = fs.readFileSync(require('node:path').join(__dirname, '../supabase/functions/operations-api/index.ts'), 'utf8');
const names = ['cleanText', 'mergeCoordinates', 'columnLetters', 'formulaPrecedents', 'safeFormulaValue', 'effectiveHistoryMonthlyEntries'];
const snippets = names.map(name => {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}).join('\n');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(stripTypeScriptTypes(snippets), sandbox);
const row = (address, amount, formula = null, posted = amount) => ({
  source_sheet: '6月', posted_payload: { amount: posted },
  current_payload: { cell_address: address, amount, formula, cell_kind: formula ? 'formula' : 'input' }
});
const entries = [row('R3', 100000), row('R4', 47259), row('R28', 147259, 'SUM(R3:R27)'), row('S28', 59.9), row('C3', 147199.1, 'R28-S28'), row('C4', 435.9), row('C8', 147635, 'SUM(C3:C4)'), row('Z9', 999, '1+2')];
assert.equal(sandbox.effectiveHistoryMonthlyEntries(entries).find(r => r.current_payload.cell_address === 'Z9').current_payload.amount, 999, 'do not alter untouched source caches');
entries[0].current_payload.amount = 100200;
const result = sandbox.effectiveHistoryMonthlyEntries(entries);
const amount = address => result.find(r => r.current_payload.cell_address === address).current_payload.amount;
assert.equal(amount('R28'), 147459);
assert.equal(amount('C3'), 147399.1);
assert.equal(amount('C8'), 147835);
assert.equal(entries[2].current_payload.amount, 147259, 'read calculation never mutates original input rows');
assert.equal(entries[0].posted_payload.amount, 100000);
assert.equal(amount('Z9'), 999);
const invalid = sandbox.effectiveHistoryMonthlyEntries([row('A1', 3, null, 2), row('B1', 8, "'别月'!A1")]);
assert.equal(invalid[1].current_payload.amount, 8, 'unsupported references retain source value');
console.log('Monthly formula recalculation: nested actual C3=R28-S28 path, immutable originals, unaffected cells and unsupported references passed');
