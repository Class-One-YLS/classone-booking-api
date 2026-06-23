const { neon } = require("@neondatabase/serverless");

let cachedSql;

function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }
  if (!cachedSql) cachedSql = neon(process.env.DATABASE_URL);
  return cachedSql;
}

async function ensureCoreTables() {
  const sql = getSql();
  await sql`
    create table if not exists app_state (
      key text primary key,
      data jsonb not null,
      version bigint not null default 1,
      updated_at timestamptz not null default now(),
      updated_by text
    )
  `;
  await sql`
    create table if not exists audit_logs (
      id bigserial primary key,
      action text not null,
      entity_type text,
      entity_id text,
      summary text,
      before_data jsonb,
      after_data jsonb,
      created_by text,
      created_at timestamptz not null default now()
    )
  `;
}

module.exports = {
  getSql,
  ensureCoreTables
};
