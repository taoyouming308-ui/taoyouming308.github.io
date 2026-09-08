// Per-tab metadata only. Storage contents never grant authorization or carry mutation payloads.
import {serverId} from './api-client.mjs';
export const recoverableOperations=Object.freeze(['customer_create','order_create','order_lines','order_status','cash_checkout','refund_review']);
const invalid=()=>{throw Error('待核对清单损坏或存储不可用，请保留现场并人工核对，禁止新建业务。');};
export function createRecoveryJournal(getStorage,scope){
 const key=`salon.pending.v1:${serverId(scope.organizationId)}:${serverId(scope.storeId)}:${serverId(scope.staffId)}`;
 function read(){
  let raw;try{raw=getStorage().getItem(key);}catch{invalid();}
  if(raw===null)return [];
  try{
   if(raw.length>8192)invalid();
   const data=JSON.parse(raw);
   if(!data||Object.keys(data).sort().join(',')!=='requests,version'||data.version!==1||!Array.isArray(data.requests)||data.requests.length>20)invalid();
   const seen=new Set();
   return data.requests.map(row=>{
    if(!row||Object.keys(row).sort().join(',')!=='operation,requestKey'||!recoverableOperations.includes(row.operation)||typeof row.requestKey!=='string'||!/^[A-Za-z0-9._:-]{16,120}$/.test(row.requestKey)||seen.has(row.requestKey))invalid();
    seen.add(row.requestKey);return Object.freeze({operation:row.operation,requestKey:row.requestKey});
   });
  }catch{invalid();}
 }
 function write(rows){
  try{
   const storage=getStorage(),raw=rows.length?JSON.stringify({version:1,requests:rows}):null;
   if(raw===null)storage.removeItem(key);else storage.setItem(key,raw);
   if(storage.getItem(key)!==raw)invalid();
  }catch{invalid();}
 }
 return {
  list:read,
  remember(ticket){
   if(!recoverableOperations.includes(ticket.operation)||typeof ticket.requestKey!=='string'||!/^[A-Za-z0-9._:-]{16,120}$/.test(ticket.requestKey))invalid();
   const rows=read();
   if(rows.length)throw Error('当前门店仍有待核对请求，禁止另建业务。');
   write([{operation:ticket.operation,requestKey:ticket.requestKey}]);
  },
  acknowledge(ticket){
   const rows=read();
   if(!rows.some(r=>r.requestKey===ticket.requestKey&&r.operation===ticket.operation))invalid();
   write(rows.filter(r=>r.requestKey!==ticket.requestKey));
  },
 };
}
