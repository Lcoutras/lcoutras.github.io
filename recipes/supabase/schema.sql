-- Family Recipe Box: storage for the website edition.
-- Everything lives in two tables that nobody can touch directly (row level security on, no policies).
-- The website only calls the rb_* functions below, and every one of them checks the family key
-- from the link against a stored hash before it reads or writes anything.

create table if not exists public.rb_docs (
  path       text primary key,
  parent     text not null,
  data       jsonb not null default '{}'::jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists rb_docs_parent_idx  on public.rb_docs (parent) where not deleted;
create index if not exists rb_docs_updated_idx on public.rb_docs (updated_at);

create table if not exists public.rb_photos (
  id         text primary key,
  data       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.rb_access (
  id       int primary key default 1 check (id = 1),
  key_hash text not null
);

alter table public.rb_docs   enable row level security;
alter table public.rb_photos enable row level security;
alter table public.rb_access enable row level security;
revoke all on public.rb_docs, public.rb_photos, public.rb_access from anon, authenticated;

create or replace function public.rb_check(k text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if k is null or not exists (select 1 from rb_access where key_hash = encode(sha256(convert_to(k, 'UTF8')), 'hex')) then
    raise exception 'bad_key' using errcode = '28000';
  end if;
end $$;

create or replace function public.rb_parent(p text) returns text
language sql immutable as $$ select regexp_replace(p, '/[^/]+$', '') $$;

create or replace function public.rb_merge(a jsonb, b jsonb) returns jsonb
language plpgsql immutable as $$
declare k text; v jsonb; out jsonb := coalesce(a, '{}'::jsonb);
begin
  for k, v in select * from jsonb_each(coalesce(b, '{}'::jsonb)) loop
    if jsonb_typeof(v) = 'object' and v ? '__delete__' and v->>'__delete__' = 'true' then
      out := out - k;
    elsif jsonb_typeof(v) = 'object' and jsonb_typeof(out->k) = 'object' then
      out := jsonb_set(out, array[k], rb_merge(out->k, v));
    else
      out := jsonb_set(out, array[k], v, true);
    end if;
  end loop;
  return out;
end $$;

create or replace function public.rb_now(k text) returns timestamptz
language plpgsql security definer set search_path = public as $$
begin perform rb_check(k); return clock_timestamp(); end $$;

create or replace function public.rb_get(k text, p text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin perform rb_check(k);
  return (select data from rb_docs where path = p and not deleted);
end $$;

create or replace function public.rb_list(k text, par text)
returns table (path text, data jsonb, updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin perform rb_check(k);
  return query select d.path, d.data, d.updated_at from rb_docs d where d.parent = par and not d.deleted limit 5000;
end $$;

create or replace function public.rb_set(k text, p text, d jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin perform rb_check(k);
  if length(d::text) > 262144 then raise exception 'too_big'; end if;
  insert into rb_docs (path, parent, data, deleted, updated_at) values (p, rb_parent(p), d, false, clock_timestamp())
  on conflict (path) do update set data = excluded.data, deleted = false, updated_at = clock_timestamp();
end $$;

create or replace function public.rb_update(k text, p text, d jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin perform rb_check(k);
  update rb_docs set data = rb_merge(data, d), updated_at = clock_timestamp() where path = p and not deleted;
  if not found then raise exception 'not_found'; end if;
end $$;

create or replace function public.rb_delete(k text, p text) returns void
language plpgsql security definer set search_path = public as $$
begin perform rb_check(k);
  update rb_docs set deleted = true, data = '{}'::jsonb, updated_at = clock_timestamp() where path = p;
end $$;

create or replace function public.rb_changes(k text, since timestamptz)
returns table (path text, parent text, data jsonb, deleted boolean, updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin perform rb_check(k);
  return query select d.path, d.parent, d.data, d.deleted, d.updated_at from rb_docs d
    where d.updated_at > since order by d.updated_at limit 2000;
end $$;

create or replace function public.rb_photo_put(k text, pid text, pdata text) returns void
language plpgsql security definer set search_path = public as $$
begin perform rb_check(k);
  if length(pdata) > 3000000 then raise exception 'too_big'; end if;
  insert into rb_photos as ph (id, data) values (pid, pdata) on conflict on constraint rb_photos_pkey do nothing;
end $$;

create or replace function public.rb_photo_get(k text, pid text) returns text
language plpgsql security definer set search_path = public as $$
begin perform rb_check(k);
  return (select ph.data from rb_photos ph where ph.id = pid);
end $$;

-- Only the rb_* doorway is open to the website.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.rb_now(text), public.rb_get(text, text), public.rb_list(text, text),
  public.rb_set(text, text, jsonb), public.rb_update(text, text, jsonb), public.rb_delete(text, text),
  public.rb_changes(text, timestamptz), public.rb_photo_put(text, text, text), public.rb_photo_get(text, text)
  to anon;
