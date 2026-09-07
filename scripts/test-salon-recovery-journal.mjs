import assert from 'node:assert/strict';
import {createRecoveryJournal} from '../packages/salon-core/recovery-journal.mjs';
const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
const scope={organizationId:1,storeId:2,staffId:3},key='salon.pending.v1:1:2:3';
const make=(s=scope)=>createRecoveryJournal(()=>storage,s);
const ticket={operation:'order_create',requestKey:'synthetic-key-0001',token:'must-not-store',phone:'must-not-store',amount:100};
values.set('unrelated','keep');assert.deepEqual(make().list(),[]);
make().remember(ticket);
assert.deepEqual(JSON.parse(values.get(key)),{version:1,requests:[{operation:ticket.operation,requestKey:ticket.requestKey}]});
assert.deepEqual(make().list(),[{operation:ticket.operation,requestKey:ticket.requestKey}]);
for(const changed of [{...scope,organizationId:2},{...scope,storeId:3},{...scope,staffId:4}])assert.deepEqual(make(changed).list(),[]);
assert.throws(()=>make().remember({...ticket,requestKey:'synthetic-key-0002'}));
assert.throws(()=>make().acknowledge({...ticket,operation:'order_lines'}));
make().acknowledge(ticket);assert.equal(values.has(key),false);assert.equal(values.get('unrelated'),'keep');
for(const raw of ['broken','null','[]','{"version":2,"requests":[]}',JSON.stringify({version:1,requests:[ticket]}),JSON.stringify({version:1,requests:[{operation:'checkout',requestKey:ticket.requestKey}]}),JSON.stringify({version:1,requests:[{operation:'order_create',requestKey:'short'}]}),'x'.repeat(8193)]){
 values.set(key,raw);assert.throws(()=>make().list());assert.throws(()=>make().remember(ticket));assert.equal(values.get(key),raw,'corrupt data must not be silently overwritten');
}
values.delete(key);
for(const broken of [()=>{throw Error('denied');},()=>({...storage,setItem:()=>{throw Error('quota');}}),()=>({...storage,setItem:()=>{}})])assert.throws(()=>createRecoveryJournal(broken,scope).remember(ticket));
make().remember(ticket);
assert.throws(()=>createRecoveryJournal(()=>({...storage,removeItem:()=>{}}),scope).acknowledge(ticket));assert.equal(make().list().length,1);
console.log('Recovery journal passed: scoped metadata only, reload, corruption/no overwrite, quota/no-op writes, acknowledgement and unrelated storage preserved');
