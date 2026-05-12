create table if not exists public.kairn_telemetry_events (
  id uuid primary key default gen_random_uuid(),
  installation_id text not null,
  schema_version integer not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

alter table public.kairn_telemetry_events enable row level security;

drop policy if exists "deny public kairn telemetry reads" on public.kairn_telemetry_events;
drop policy if exists "deny public kairn telemetry writes" on public.kairn_telemetry_events;

create policy "deny public kairn telemetry reads"
  on public.kairn_telemetry_events
  for select
  to anon, authenticated
  using (false);

create policy "deny public kairn telemetry writes"
  on public.kairn_telemetry_events
  for insert
  to anon, authenticated
  with check (false);

create index if not exists kairn_telemetry_events_installation_received_idx
  on public.kairn_telemetry_events (installation_id, received_at desc);

create index if not exists kairn_telemetry_events_payload_gin_idx
  on public.kairn_telemetry_events using gin (payload jsonb_path_ops);
