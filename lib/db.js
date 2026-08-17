const { Pool, neon } = require("@neondatabase/serverless");

let cachedSql;
let cachedPool;

function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }
  if (!cachedSql) cachedSql = neon(process.env.DATABASE_URL);
  return cachedSql;
}

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }
  if (!cachedPool) cachedPool = new Pool({ connectionString: process.env.DATABASE_URL });
  return cachedPool;
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
  await sql`
    create table if not exists system_versions (
      state_key text primary key,
      version bigint not null default 0,
      updated_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists booking_records_v2 (
      state_key text not null,
      booking_id text not null,
      teacher_id text,
      student_id text,
      class_date date,
      class_time text,
      status text,
      record_version bigint not null default 1,
      data jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (state_key, booking_id)
    )
  `;
  await sql`create index if not exists booking_records_v2_teacher_date_idx on booking_records_v2 (state_key, teacher_id, class_date, class_time)`;
  await sql`create index if not exists booking_records_v2_updated_idx on booking_records_v2 (state_key, updated_at)`;
  await sql`
    create table if not exists replacement_records_v2 (
      state_key text not null,
      replacement_id text not null,
      source_booking_id text,
      source_occurrence_id text,
      student_id text,
      teacher_id text,
      original_date date,
      original_time text,
      record_version bigint not null default 1,
      data jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (state_key, replacement_id)
    )
  `;
  await sql`create index if not exists replacement_records_v2_source_idx on replacement_records_v2 (state_key, source_booking_id)`;
  await sql`
    create table if not exists replacement_credit_records_v2 (
      state_key text not null,
      credit_id text not null,
      source_booking_id text,
      source_occurrence_id text,
      student_id text,
      teacher_id text,
      original_date date,
      original_time text,
      record_version bigint not null default 1,
      data jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (state_key, credit_id)
    )
  `;
  await sql`create index if not exists replacement_credit_records_v2_source_idx on replacement_credit_records_v2 (state_key, source_booking_id)`;
  await sql`
    create table if not exists activity_events_v2 (
      state_key text not null,
      event_id text not null,
      action text,
      entity_type text,
      entity_id text,
      actor text,
      metadata jsonb,
      data jsonb not null,
      created_at timestamptz not null default now(),
      primary key (state_key, event_id)
    )
  `;
  await sql`create index if not exists activity_events_v2_entity_idx on activity_events_v2 (state_key, entity_type, entity_id)`;
  await sql`
    create table if not exists booking_outcome_requests_v2 (
      state_key text not null,
      request_id text not null,
      booking_id text,
      request_hash text,
      response jsonb not null,
      created_at timestamptz not null default now(),
      primary key (state_key, request_id)
    )
  `;
  await sql`
    create table if not exists booking_create_requests_v2 (
      state_key text not null,
      request_id text not null,
      booking_id text,
      request_hash text,
      response jsonb not null,
      created_at timestamptz not null default now(),
      primary key (state_key, request_id)
    )
  `;
  await sql`
    create table if not exists recurring_assignments_v2 (
      state_key text not null,
      assignment_id text not null,
      teacher_id text,
      student_id text,
      weekday text,
      class_time text,
      status text,
      source_collection text,
      source_slot_id text,
      student_slot_id text,
      record_version bigint not null default 1,
      data jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (state_key, assignment_id)
    )
  `;
  await sql`create index if not exists recurring_assignments_v2_teacher_idx on recurring_assignments_v2 (state_key, teacher_id, weekday, class_time)`;
  await sql`create index if not exists recurring_assignments_v2_student_idx on recurring_assignments_v2 (state_key, student_id)`;
  await sql`create index if not exists recurring_assignments_v2_updated_idx on recurring_assignments_v2 (state_key, updated_at)`;
  await sql`
    create table if not exists recurring_assignment_requests_v2 (
      state_key text not null,
      request_id text not null,
      assignment_id text,
      request_hash text,
      response jsonb not null,
      created_at timestamptz not null default now(),
      primary key (state_key, request_id)
    )
  `;
  await sql`
    create table if not exists collection_records_v2 (
      state_key text not null,
      collection_name text not null,
      record_id text not null,
      record_version bigint not null default 1,
      data jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (state_key, collection_name, record_id)
    )
  `;
  await sql`create index if not exists collection_records_v2_collection_idx on collection_records_v2 (state_key, collection_name, updated_at)`;
  await sql`
    create table if not exists record_transaction_requests_v2 (
      state_key text not null,
      request_id text not null,
      request_hash text,
      response jsonb not null,
      created_at timestamptz not null default now(),
      primary key (state_key, request_id)
    )
  `;
}

module.exports = {
  getPool,
  getSql,
  ensureCoreTables
};
