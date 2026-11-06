-- WorkZone: esquema
create table if not exists public.membros(
  email text primary key,
  nome text,
  admin boolean not null default false
);
create table if not exists public.perfis(
  uid uuid primary key references auth.users(id) on delete cascade,
  nome text, avatar_url text, email text,
  atualizado timestamptz not null default now()
);
create table if not exists public.docs(
  col text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key(col,id)
);
create index if not exists docs_col on public.docs(col);
alter table public.docs replica identity full;

create or replace function public.eh_membro() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.membros where lower(email) = lower(coalesce(auth.jwt()->>'email','')));
$$;
create or replace function public.eh_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.membros where lower(email) = lower(coalesce(auth.jwt()->>'email','')) and admin);
$$;

alter table public.membros enable row level security;
alter table public.perfis enable row level security;
alter table public.docs enable row level security;

drop policy if exists membros_ler on public.membros;
create policy membros_ler on public.membros for select to authenticated
  using (public.eh_membro() or lower(email) = lower(coalesce(auth.jwt()->>'email','')));
drop policy if exists membros_admin on public.membros;
create policy membros_admin on public.membros for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

drop policy if exists perfis_ler on public.perfis;
create policy perfis_ler on public.perfis for select to authenticated using (public.eh_membro());
drop policy if exists perfis_proprio on public.perfis;
create policy perfis_proprio on public.perfis for insert to authenticated with check (uid = auth.uid() and public.eh_membro());
drop policy if exists perfis_proprio_upd on public.perfis;
create policy perfis_proprio_upd on public.perfis for update to authenticated using (uid = auth.uid()) with check (uid = auth.uid());

drop policy if exists docs_membros on public.docs;
create policy docs_membros on public.docs for all to authenticated
  using (public.eh_membro()) with check (public.eh_membro());

create or replace function public.doc_merge(p_col text, p_id text, p_patch jsonb) returns void
language sql security invoker set search_path = public as $$
  insert into public.docs(col,id,data,updated_at) values (p_col,p_id,p_patch,now())
  on conflict (col,id) do update set data = public.docs.data || excluded.data, updated_at = now();
$$;

do $$ begin
  begin alter publication supabase_realtime add table public.docs; exception when duplicate_object then null; end;
end $$;

-- Storage
insert into storage.buckets(id,name,public,file_size_limit) values ('midia','midia',false,52428800) on conflict (id) do nothing;
insert into storage.buckets(id,name,public,file_size_limit) values ('anexos','anexos',false,20971520) on conflict (id) do nothing;
drop policy if exists wz_ler on storage.objects;
create policy wz_ler on storage.objects for select to authenticated using (bucket_id in ('midia','anexos') and public.eh_membro());
drop policy if exists wz_anexos_ins on storage.objects;
create policy wz_anexos_ins on storage.objects for insert to authenticated with check (bucket_id = 'anexos' and public.eh_membro());
drop policy if exists wz_anexos_del on storage.objects;
create policy wz_anexos_del on storage.objects for delete to authenticated using (bucket_id = 'anexos' and public.eh_membro());
drop policy if exists wz_midia_admin on storage.objects;
create policy wz_midia_admin on storage.objects for all to authenticated using (bucket_id = 'midia' and public.eh_admin()) with check (bucket_id = 'midia' and public.eh_admin());
