import assert from 'node:assert/strict';
import postgres from 'postgres';
import WebSocket from 'ws';
import {createHash,randomUUID} from 'node:crypto';
const base=process.env.TEST_SITE_URL;
if(!base||!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw Error('A local TEST_SITE_URL is required');
const sql=postgres(process.env.TEST_DATABASE_URL,{max:1});
const key='esh_key_'+randomUUID().replaceAll('-','');
const [owner]=await sql`INSERT INTO esphub.accounts(handle) VALUES(${randomUUID()}) RETURNING id`;
await sql`INSERT INTO esphub.access_tokens VALUES(${createHash('sha256').update(key).digest('hex')},${owner.id},'developer',now()+interval '1 hour',now())`;
async function call(method,params){
 const r=await fetch(base+'/backend/mcp',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const msg=await r.json();assert.equal(r.status,200,JSON.stringify(msg));assert.ok(!msg.error,JSON.stringify(msg));return msg.result
}
async function op(name,args){const r=await call('tools/call',{name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text)}
let ws;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 assert.equal((await call('initialize',{protocolVersion:'2025-11-25'})).serverInfo.name,'esphub');
 assert.ok((await call('tools/list',{})).tools.some(t=>t.name==='uart.write'));
 const d=await op('devices.create',{board:'paper-color',name:'Simulator'}),id={device_id:d.id};
 const socketURL=new URL('/backend/api/device/connect',base);socketURL.protocol='ws:';
 ws=new WebSocket(socketURL,{headers:{Authorization:'Bearer '+d.token}});
 await new Promise((ok,no)=>{ws.once('open',ok);ws.once('error',no)});
 const inbox=[];ws.on('message',msg=>{const f=JSON.parse(msg.toString());inbox.push(f);if(f.t==='req')ws.send(JSON.stringify({t:'res',id:f.id,ok:true,data:{output:'test Wi-Fi network'}}))});
 const send=v=>ws.send(JSON.stringify(v));
 const take=async pred=>{for(let i=0;i<150;i++){const n=inbox.findIndex(pred);if(n>=0)return inbox.splice(n,1)[0];await sleep(75)}throw Error('WebSocket response timeout')};
 const session={...id,process_id:randomUUID()};
 send({t:'hello',boot_id:session.process_id,fw:{name:'launcher',version:'test'},role:'launcher',chip:'esp32s3'});
 await take(f=>f.t==='ack');
 send({t:'log',seq:1,lines:[[121,'I','boot log']]});await take(f=>f.t==='ack'&&f.seq===1);
 assert.equal((await op('uart.read',{...session,after:0})).records[0].text,'boot log');
 assert.equal((await op('devices.get',id)).online,true);
 const data={...session,text:'help\n',request_id:randomUUID()};
 assert.equal((await op('uart.write',data)).sequence,1);assert.equal((await op('uart.write',data)).sequence,1);
 send({t:'uart.poll',after:0});assert.equal((await take(f=>f.t==='uart.input')).text,'help\n');
 send({t:'uart.poll',after:1});send({t:'log',seq:2,lines:[[456,'I','help response']]});await take(f=>f.t==='ack'&&f.seq===2);
 assert.equal((await op('uart.read',{...session,after:1})).records[0].text,'help response');
 assert.equal((await op('uart.sessions',id))[0].rx_cursor,1);
 assert.equal((await op('wifi.scan',id)).output,'test Wi-Fi network');
 send({t:'hello',boot_id:randomUUID(),fw:{name:'launcher',version:'test'}});await take(f=>f.t==='ack');
 const archived=await call('tools/call',{name:'uart.write',arguments:{...data,request_id:randomUUID()}});assert.equal(archived.isError,true);
 await op('devices.delete',id);console.log('PASS MCP, authenticated simulated MCU, boot isolation, RX idempotency and ACK, R2 TX replay, live RPC and device deletion');
}finally{ws?.close();await sql`DELETE FROM esphub.accounts WHERE id=${owner.id}`;await sql.end()}
