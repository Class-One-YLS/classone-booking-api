create extension if not exists pgcrypto;

create table if not exists app_state (
  key text primary key,
  data jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists teachers (
  id text primary key,
  name text not null,
  subjects text[] not null default '{}',
  category text not null default 'freelance',
  tier text not null default 'standard',
  rate numeric(10,2) not null default 0,
  profit_share numeric(6,2) not null default 0,
  status text not null default 'active',
  photo_url text,
  remark text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists students (
  id text primary key,
  name text not null,
  subject text,
  package_name text,
  package_amount numeric(10,2) not null default 0,
  package_total_classes integer not null default 0,
  status text not null default 'new',
  remark text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists teacher_slots (
  id text primary key,
  teacher_id text not null references teachers(id) on delete cascade,
  slot_kind text not null default 'regular',
  day_name text,
  slot_date date,
  start_date date,
  end_date date,
  time_24 text not null,
  subject text,
  student_name text,
  locked boolean not null default false,
  unavailable boolean not null default false,
  source text,
  remark text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bookings (
  id text primary key,
  teacher_id text references teachers(id) on delete set null,
  student_id text references students(id) on delete set null,
  student_name text not null,
  subject text,
  booking_type text not null default 'regular class',
  class_date date not null,
  time_24 text not null,
  status text not null default 'booked',
  source text,
  remark text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists replacement_cases (
  id text primary key,
  student_id text references students(id) on delete set null,
  student_name text not null,
  subject text,
  reason text not null,
  status text not null default 'action_needed',
  original_teacher_id text references teachers(id) on delete set null,
  original_teacher_name text,
  original_date date,
  original_time_24 text,
  replacement_teacher_id text references teachers(id) on delete set null,
  replacement_teacher_name text,
  replacement_date date,
  replacement_time_24 text,
  notes text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists replacement_credits (
  id text primary key,
  student_id text references students(id) on delete set null,
  student_name text not null,
  credit_count integer not null default 0,
  used_count integer not null default 0,
  reason text,
  remark text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public_holidays (
  id text primary key,
  title text not null,
  start_date date not null,
  end_date date not null,
  default_cancel boolean not null default true,
  remark text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_leads (
  id text primary key,
  parent_name text,
  parent_phone text,
  child_name text,
  child_age text,
  subjects text[] not null default '{}',
  source text,
  salesperson text,
  status text not null default 'new contact',
  urgency text,
  next_follow_up_date date,
  notes text,
  imported boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists tutor_leads (
  id text primary key,
  name text not null,
  phone text,
  subjects text[] not null default '{}',
  tutor_category text not null default 'freelance',
  status text not null default 'new applicant',
  approved_rate numeric(10,2) not null default 0,
  profit_share numeric(6,2) not null default 0,
  notes text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists packages (
  id text primary key,
  name text not null,
  amount numeric(10,2) not null default 0,
  total_classes integer not null default 0,
  remark text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists revenue_entries (
  id text primary key,
  month_key text not null,
  amount numeric(12,2) not null default 0,
  remark text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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
);

create index if not exists idx_teachers_name on teachers (lower(name));
create index if not exists idx_students_name on students (lower(name));
create index if not exists idx_bookings_teacher_date on bookings (teacher_id, class_date, time_24);
create index if not exists idx_bookings_student_date on bookings (student_name, class_date);
create index if not exists idx_crm_status_updated on crm_leads (status, updated_at desc);
create index if not exists idx_tutor_status_updated on tutor_leads (status, updated_at desc);
create index if not exists idx_replacement_status on replacement_cases (status, updated_at desc);
create index if not exists idx_audit_created on audit_logs (created_at desc);
