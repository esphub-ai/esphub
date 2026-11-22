import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import {operate} from '../services/api/src/operations.js';
import {digest} from '../services/api/src/auth.js';
test('new registrations store only a token hash and cannot cross account boundaries',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const sql=postgres(process.env.TEST_DATABASE_URL,{max:1});try{
 await sql.begin(async tx=>{
 const users=await tx`INSERT INTO esphub.accounts(handle) VALUES(${crypto.randomUUID()}),(${crypto.randomUUID()}) RETURNING id`;
 const c={get:()=>tx,env:{DEVICE:{idFromName:id=>id,get:()=>({fetch:()=>Response.json({})})}}};
 const args={board:'paper-color',name:'Paper Color'},d=await operate(c,users[0].id,'devices.create',args);
 assert.equal((await tx`SELECT token_hash FROM esphub.devices WHERE id=${d.id}`)[0].token_hash,await digest(d.token));
 for(const n of ['devices.get','devices.delete','devices.reissue'])await assert.rejects(operate(c,users[1].id,n,{device_id:d.id}),e=>e.status===404);
 const next=await operate(c,users[0].id,'devices.reissue',{device_id:d.id});assert.notEqual(next.token,d.token);
 await operate(c,users[0].id,'devices.delete',{device_id:d.id});await tx`DELETE FROM esphub.accounts WHERE id IN ${tx(users.map(u=>u.id))}`
 })
 }finally{await sql.end()}
});
