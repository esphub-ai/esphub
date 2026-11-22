import postgres from 'postgres';
import {readdir, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
if (!process.env.MIGRATION_DATABASE_URL) throw Error('Missing MIGRATION_DATABASE_URL');
const sql=postgres(process.env.MIGRATION_DATABASE_URL,{max:1,prepare:false});
try {
 await sql.begin(async tx=>{
   await tx`SELECT pg_advisory_xact_lock(1764692911)`;
   await tx`CREATE TABLE IF NOT EXISTS public.esphub_migrations(name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz DEFAULT now())`;
   const files=(await readdir('migrations')).filter(s=>s.endsWith('.sql')).sort();
   for(const file of files){
     const contents=await readFile('migrations/'+file,'utf8'),hash=createHash('sha256').update(contents).digest('hex');
     const [old]=await tx`SELECT sha256 FROM public.esphub_migrations WHERE name=${file}`;
     if(old){if(old.sha256!==hash)throw Error('Changed migration: '+file);continue}
     await tx.unsafe(contents).simple();
     await tx`INSERT INTO public.esphub_migrations(name,sha256) VALUES(${file},${hash})`;
     console.log('Applied',file);
   }
 });
} finally { await sql.end(); }
