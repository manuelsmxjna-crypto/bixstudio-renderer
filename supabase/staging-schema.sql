-- Solo para un proyecto Supabase NUEVO de pruebas de BixStudio.
-- No ejecutar en la base de producción.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'editing',
  total_width_cm numeric,
  total_height_cm numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.assets (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  original_name text not null,
  storage_path text not null unique,
  thumbnail_path text,
  mime_type text,
  width_px integer,
  height_px integer,
  dpi_x numeric,
  dpi_y numeric,
  file_size_bytes bigint,
  upload_status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table public.sheets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  sheet_number integer not null,
  width_cm numeric not null,
  height_cm numeric not null,
  layout jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, sheet_number)
);

create table public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  sheet_id uuid not null references public.sheets(id) on delete cascade,
  status text not null default 'queued',
  attempts integer not null default 0,
  output_path text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index assets_project_id_idx on public.assets(project_id);
create index render_jobs_project_id_idx on public.render_jobs(project_id);

alter table public.projects enable row level security;
alter table public.assets enable row level security;
alter table public.sheets enable row level security;
alter table public.render_jobs enable row level security;

revoke all on public.projects, public.assets, public.sheets, public.render_jobs from anon, authenticated;
grant select, insert, update, delete on public.projects, public.assets, public.sheets, public.render_jobs to service_role;
