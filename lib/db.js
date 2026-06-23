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
  await sql`
    create table if not exists app_state_uploads (
      upload_id text primary key,
      state_key text not null,
      expected_version bigint,
      updated_by text,
      total_chunks integer not null,
      created_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists app_state_upload_chunks (
      upload_id text not null references app_state_uploads(upload_id) on delete cascade,
      chunk_index integer not null,
      chunk_data text not null,
      created_at timestamptz not null default now(),
      primary key (upload_id, chunk_index)
    )
  `;
  await sql`
    create table if not exists app_state_text_chunks (
      state_key text not null,
      version bigint not null,
      chunk_index integer not null,
      chunk_data text not null,
      created_at timestamptz not null default now(),
      primary key (state_key, version, chunk_index)
    )
  `;
}

module.exports = {
  getSql,
  ensureCoreTables
};
