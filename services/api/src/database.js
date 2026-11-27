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

export async function inTransaction(sql, buildQueries) {
  if (typeof sql.transaction === "function") {
    return sql.transaction(buildQueries);
  }
  const run = async (tx) => {
    const results = [];
    for (const query of buildQueries(tx)) results.push(await query);
    return results;
  };
  if (typeof sql.begin === "function") return sql.begin(run);
  if (typeof sql.savepoint === "function") return sql.savepoint(run);
  return run(sql);
}
