import postgres from "postgres";
import { neon } from "@neondatabase/serverless";

export async function withDatabase(env, run) {
  const uri = env.DATABASE_URL;
  const sql = new URL(uri).hostname.endsWith(".neon.tech")
    ? neon(uri)
    : postgres(uri, { max: 1, prepare: false, fetch_types: false });
  try {
    return await run(sql);
  } finally {
    if (sql.end) await sql.end();
  }
}
