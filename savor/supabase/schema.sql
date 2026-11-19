-- Savor (accounts edition): every person signs in with their own account (Supabase Auth),
-- and every recipe book belongs to the people in it. Nothing is readable directly:
-- the website only calls the sv_* functions below, and each one checks who is asking.
-- Run this once in the Supabase SQL editor (it is safe to run again).

create table if not exists public.sv_profiles (
  user_id     uuid primary key,
  name        text not null default '',
  daily_units int  not null default 60,           -- how many Claude "units" this person may use per day
  created_at  timestamptz not null default now()
);
create table if not exists public.sv_books (
  id         text primary key,
  name       text not null,
  owner      uuid not null,
  created_at timestamptz not null default now()
);
create table if not exists public.sv_members (
  book_id   text not null references public.sv_books(id) on delete cascade,
  user_id   uuid not null,
  role      text not null check (role in ('owner','admin','contributor','viewer')),
  joined_at timestamptz not null default now(),
  primary key (book_id, user_id)
);
create index if not exists sv_members_user_idx on public.sv_members (user_id);
create table if not exists public.sv_invites (
  code       text primary key,
  book_id    text not null references public.sv_books(id) on delete cascade,
  role       text not null check (role in ('admin','contributor','viewer')),
  created_by uuid not null,
  expires_at timestamptz not null,
  max_uses   int  not null default 25,
  uses       int  not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists public.sv_docs (
  path       text primary key,
  scope      text not null,                       -- 'b:<book id>' or 'u:<user id>'
  parent     text not null,
  data       jsonb not null default '{}'::jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists sv_docs_parent_idx on public.sv_docs (parent) where not deleted;
create index if not exists sv_docs_scope_idx  on public.sv_docs (scope, updated_at);
create table if not exists public.sv_photos (
  id         text primary key,
  book_id    text not null,
  data       text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.sv_usage (
  user_id uuid not null,
  day     date not null,
  units   int  not null default 0,
  primary key (user_id, day)
);

alter table public.sv_profiles enable row level security;
alter table public.sv_books    enable row level security;
alter table public.sv_members  enable row level security;
alter table public.sv_invites  enable row level security;
alter table public.sv_docs     enable row level security;
alter table public.sv_photos   enable row level security;
alter table public.sv_usage    enable row level security;
revoke all on public.sv_profiles, public.sv_books, public.sv_members, public.sv_invites,
              public.sv_docs, public.sv_photos, public.sv_usage from anon, authenticated;

-- ---------- who is asking ----------
create or replace function public.sv_uid() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare u uuid := auth.uid();
begin if u is null then raise exception 'not_signed_in' using errcode = '28000'; end if; return u; end $$;

create or replace function public.sv_role(b text) returns text
language sql stable security definer set search_path = public as $$
  select role from sv_members where book_id = b and user_id = auth.uid() $$;

create or replace function public.sv_parent(p text) returns text
language sql immutable as $$ select regexp_replace(p, '/[^/]+$', '') $$;

-- Which space does this path live in, and may the caller read (w=false) or write (w=true) it?
create or replace function public.sv_scope(p text, w boolean) returns text
language plpgsql stable security definer set search_path = public as $$
declare u uuid := sv_uid(); m text[]; r text;
begin
  m := regexp_match(p, '^books/([a-z0-9]+)/(.*)$');
  if m is not null then
    r := sv_role(m[1]);
    if r is null then raise exception 'forbidden' using errcode = '42501'; end if;
    if w then
      if r = 'viewer' then raise exception 'read_only' using errcode = '42501'; end if;
      -- who is in a book is managed by the server only, never written by the page
      if m[2] ~ '^(members|invites)(/|$)' then raise exception 'forbidden' using errcode = '42501'; end if;
    end if;
    return 'b:' || m[1];
  end if;
  m := regexp_match(p, '^users/([0-9a-f-]{36})/(.+)$');
  if m is not null and m[1] = u::text then return 'u:' || u::text; end if;
  raise exception 'forbidden' using errcode = '42501';
end $$;

create or replace function public.sv_merge(a jsonb, b jsonb) returns jsonb
language plpgsql immutable as $$
declare k text; v jsonb; out jsonb := coalesce(a, '{}'::jsonb);
begin
  for k, v in select * from jsonb_each(coalesce(b, '{}'::jsonb)) loop
    if jsonb_typeof(v) = 'object' and v ? '__delete__' and v->>'__delete__' = 'true' then out := out - k;
    elsif jsonb_typeof(v) = 'object' and jsonb_typeof(out->k) = 'object' then out := jsonb_set(out, array[k], sv_merge(out->k, v));
    else out := jsonb_set(out, array[k], v, true);
    end if;
  end loop;
  return out;
end $$;

-- ---------- reading and writing documents ----------
create or replace function public.sv_now() returns timestamptz
language plpgsql security definer set search_path = public as $$
begin perform sv_uid(); return clock_timestamp(); end $$;

create or replace function public.sv_get(p text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s text := sv_scope(p, false);
begin return (select data from sv_docs where path = p and scope = s and not deleted); end $$;

create or replace function public.sv_list(par text)
returns table (path text, data jsonb, updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare s text := sv_scope(par || '/_', false);
begin
  return query select d.path, d.data, d.updated_at from sv_docs d where d.parent = par and d.scope = s and not d.deleted limit 5000;
end $$;

create or replace function public.sv_set(p text, d jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare s text := sv_scope(p, true);
begin
  if length(d::text) > 262144 then raise exception 'too_big'; end if;
  insert into sv_docs (path, scope, parent, data, deleted, updated_at) values (p, s, sv_parent(p), d, false, clock_timestamp())
  on conflict (path) do update set data = excluded.data, deleted = false, updated_at = clock_timestamp() where sv_docs.scope = s;
end $$;

create or replace function public.sv_update(p text, d jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare s text := sv_scope(p, true);
begin
  update sv_docs set data = sv_merge(data, d), updated_at = clock_timestamp() where path = p and scope = s and not deleted;
  if not found then raise exception 'not_found'; end if;
end $$;

create or replace function public.sv_delete(p text) returns void
language plpgsql security definer set search_path = public as $$
declare s text := sv_scope(p, true);
begin update sv_docs set deleted = true, data = '{}'::jsonb, updated_at = clock_timestamp() where path = p and scope = s; end $$;

-- Everything that changed since a moment, in the caller's books and in their own space
create or replace function public.sv_changes(since timestamptz)
returns table (path text, parent text, data jsonb, deleted boolean, updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare u uuid := sv_uid();
begin
  return query select d.path, d.parent, d.data, d.deleted, d.updated_at from sv_docs d
    where d.updated_at > since
      and (d.scope = 'u:' || u::text or d.scope in (select 'b:' || m.book_id from sv_members m where m.user_id = u))
    order by d.updated_at limit 2000;
end $$;

-- ---------- photos ----------
create or replace function public.sv_photo_put(book text, pid text, pdata text) returns void
language plpgsql security definer set search_path = public as $$
declare r text := sv_role(book);
begin
  if r is null or r = 'viewer' then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(pdata) > 3000000 then raise exception 'too_big'; end if;
  insert into sv_photos (id, book_id, data) values (pid, book, pdata) on conflict (id) do nothing;
end $$;

create or replace function public.sv_photo_get(pid text) returns text
language plpgsql security definer set search_path = public as $$
begin
  perform sv_uid();
  return (select ph.data from sv_photos ph where ph.id = pid and exists (select 1 from sv_members m where m.book_id = ph.book_id and m.user_id = auth.uid()));
end $$;

-- ---------- people and books ----------
create or replace function public.sv_member_doc(b text, u uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m sv_members; n text;
begin
  select * into m from sv_members where book_id = b and user_id = u; select name into n from sv_profiles where user_id = u;
  if not found then
    update sv_docs set deleted = true, data = '{}'::jsonb, updated_at = clock_timestamp() where path = 'books/' || b || '/members/' || u::text;
  else
    insert into sv_docs (path, scope, parent, data, updated_at) values ('books/' || b || '/members/' || u::text, 'b:' || b, 'books/' || b || '/members',
      jsonb_build_object('role', m.role, 'name', coalesce(n, ''), 'joinedAt', (extract(epoch from m.joined_at) * 1000)::bigint), clock_timestamp())
    on conflict (path) do update set data = excluded.data, deleted = false, updated_at = clock_timestamp();
  end if;
end $$;

create or replace function public.sv_new_id() returns text
language sql volatile as $$
  select string_agg(substr('abcdefghjkmnpqrstuvwxyz23456789', 1 + floor(random() * 31)::int, 1), '') from generate_series(1, 12) $$;

-- Called right after signing in: makes sure there is a profile, at least one book and a "home" book
create or replace function public.sv_bootstrap(display_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := sv_uid(); nm text := left(trim(coalesce(display_name, '')), 40); bid text; home jsonb;
begin
  insert into sv_profiles (user_id, name) values (u, nm) on conflict (user_id) do update set name = case when sv_profiles.name = '' then excluded.name else sv_profiles.name end;
  select name into nm from sv_profiles where user_id = u;
  if not exists (select 1 from sv_members where user_id = u) then
    bid := sv_new_id();
    insert into sv_books (id, name, owner) values (bid, case when nm = '' then 'My recipes' else nm || '’s recipes' end, u);
    insert into sv_members (book_id, user_id, role) values (bid, u, 'owner');
    insert into sv_docs (path, scope, parent, data) values ('books/' || bid || '/meta/info', 'b:' || bid, 'books/' || bid || '/meta',
      jsonb_build_object('name', case when nm = '' then 'My recipes' else nm || '’s recipes' end, 'createdBy', u::text, 'createdAt', (extract(epoch from now()) * 1000)::bigint));
    perform sv_member_doc(bid, u);
  end if;
  select data into home from sv_docs where path = 'users/' || u::text || '/home' and not deleted;
  if home is null or not exists (select 1 from sv_members where user_id = u and book_id = home->>'bookId') then
    select book_id into bid from sv_members where user_id = u order by (role = 'owner') desc, joined_at limit 1;
    insert into sv_docs (path, scope, parent, data) values ('users/' || u::text || '/home', 'u:' || u::text, 'users/' || u::text, jsonb_build_object('bookId', bid))
    on conflict (path) do update set data = excluded.data, deleted = false, updated_at = clock_timestamp();
  end if;
  return sv_me();
end $$;

create or replace function public.sv_me() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare u uuid := sv_uid();
begin
  return jsonb_build_object('id', u::text,
    'name', coalesce((select name from sv_profiles where user_id = u), ''),
    'home', (select data->>'bookId' from sv_docs where path = 'users/' || u::text || '/home' and not deleted),
    'books', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'role', m.role) order by m.joined_at)
                       from sv_members m join sv_books b on b.id = m.book_id where m.user_id = u), '[]'::jsonb),
    'units_left', greatest(0, coalesce((select p.daily_units from sv_profiles p where p.user_id = u), 60) - coalesce((select units from sv_usage where user_id = u and day = current_date), 0)),
    'daily_units', coalesce((select p.daily_units from sv_profiles p where p.user_id = u), 60));
end $$;

create or replace function public.sv_set_name(display_name text) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := sv_uid(); nm text := left(trim(coalesce(display_name, '')), 40); b text;
begin
  insert into sv_profiles (user_id, name) values (u, nm) on conflict (user_id) do update set name = excluded.name;
  for b in select book_id from sv_members where user_id = u loop perform sv_member_doc(b, u); end loop;
end $$;

create or replace function public.sv_set_home(book text) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := sv_uid();
begin
  if sv_role(book) is null then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into sv_docs (path, scope, parent, data) values ('users/' || u::text || '/home', 'u:' || u::text, 'users/' || u::text, jsonb_build_object('bookId', book))
  on conflict (path) do update set data = excluded.data, deleted = false, updated_at = clock_timestamp();
end $$;

create or replace function public.sv_new_book(book_name text) returns text
language plpgsql security definer set search_path = public as $$
declare u uuid := sv_uid(); bid text := sv_new_id(); nm text := left(trim(coalesce(book_name, '')), 60);
begin
  if nm = '' then nm = 'New recipe book'; end if;
  if (select count(*) from sv_books where owner = u) >= 10 then raise exception 'too_many_books'; end if;
  insert into sv_books (id, name, owner) values (bid, nm, u);
  insert into sv_members (book_id, user_id, role) values (bid, u, 'owner');
  insert into sv_docs (path, scope, parent, data) values ('books/' || bid || '/meta/info', 'b:' || bid, 'books/' || bid || '/meta',
    jsonb_build_object('name', nm, 'createdBy', u::text, 'createdAt', (extract(epoch from now()) * 1000)::bigint));
  perform sv_member_doc(bid, u); perform sv_set_home(bid);
  return bid;
end $$;

create or replace function public.sv_rename_book(book text, new_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if sv_role(book) not in ('owner', 'admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  update sv_books set name = left(trim(new_name), 60) where id = book;
  update sv_docs set data = jsonb_set(data, '{name}', to_jsonb(left(trim(new_name), 60))), updated_at = clock_timestamp() where path = 'books/' || book || '/meta/info';
end $$;

-- names for the "added by" labels (members' profile names; anything else falls back to the book's saved names)
create or replace function public.sv_names(book text, ids text[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb := '{}'::jsonb; i text; n text;
begin
  if sv_role(book) is null then raise exception 'forbidden' using errcode = '42501'; end if;
  foreach i in array ids loop
    n := null;
    if i ~ '^[0-9a-f-]{36}$' then select p.name into n from sv_profiles p where p.user_id = i::uuid; end if;
    if n is null then select d.data->>'name' into n from sv_docs d where d.path = 'books/' || book || '/people/' || i and not d.deleted; end if;
    out := out || jsonb_build_object(i, coalesce(n, ''));
  end loop;
  return out;
end $$;

-- ---------- sharing a book ----------
create or replace function public.sv_create_invite(book text, as_role text, days int default 14, uses int default 25) returns text
language plpgsql security definer set search_path = public as $$
declare u uuid := sv_uid(); c text := sv_new_id() || sv_new_id();
begin
  if sv_role(book) not in ('owner', 'admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if as_role not in ('admin', 'contributor', 'viewer') then raise exception 'bad_role'; end if;
  insert into sv_invites (code, book_id, role, created_by, expires_at, max_uses)
    values (c, book, as_role, u, now() + make_interval(days => greatest(1, least(days, 90))), greatest(1, least(uses, 200)));
  return c;
end $$;

create or replace function public.sv_list_invites(book text)
returns table (code text, role text, expires_at timestamptz, uses int, max_uses int)
language plpgsql security definer set search_path = public as $$
begin
  if sv_role(book) not in ('owner', 'admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  return query select i.code, i.role, i.expires_at, i.uses, i.max_uses from sv_invites i where i.book_id = book and i.expires_at > now() and i.uses < i.max_uses order by i.created_at desc;
end $$;

create or replace function public.sv_revoke_invite(c text) returns void
language plpgsql security definer set search_path = public as $$
begin delete from sv_invites i where i.code = c and sv_role(i.book_id) in ('owner', 'admin'); end $$;

-- What is this invite for? (shown before the person agrees to join)
create or replace function public.sv_invite_info(c text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare i sv_invites; b sv_books; o text;
begin
  perform sv_uid();
  select * into i from sv_invites where code = c and expires_at > now() and uses < max_uses;
  if not found then return null; end if;
  select * into b from sv_books where id = i.book_id; select name into o from sv_profiles where user_id = b.owner;
  return jsonb_build_object('book', b.name, 'role', i.role, 'owner', coalesce(o, ''), 'already', sv_role(i.book_id) is not null);
end $$;

create or replace function public.sv_join(c text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := sv_uid(); i sv_invites; b sv_books;
begin
  select * into i from sv_invites where code = c and expires_at > now() and uses < max_uses for update;
  if not found then raise exception 'invite_invalid'; end if;
  select * into b from sv_books where id = i.book_id;
  if sv_role(i.book_id) is null then
    insert into sv_members (book_id, user_id, role) values (i.book_id, u, i.role);
    update sv_invites set uses = uses + 1 where code = c;
    perform sv_member_doc(i.book_id, u);
  end if;
  perform sv_set_home(i.book_id);
  return jsonb_build_object('id', b.id, 'name', b.name);
end $$;

create or replace function public.sv_set_role(book text, member uuid, new_role text) returns void
language plpgsql security definer set search_path = public as $$
declare mine text := sv_role(book); cur text;
begin
  if mine not in ('owner', 'admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  select role into cur from sv_members where book_id = book and user_id = member;
  if cur is null or cur = 'owner' or new_role not in ('admin', 'contributor', 'viewer') then raise exception 'bad_role'; end if;
  if mine = 'admin' and (cur = 'admin' or new_role = 'admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  update sv_members set role = new_role where book_id = book and user_id = member;
  perform sv_member_doc(book, member);
end $$;

-- Remove someone (owner/admin) or leave a book yourself. The owner cannot be removed.
create or replace function public.sv_remove_member(book text, member uuid) returns void
language plpgsql security definer set search_path = public as $$
declare mine text := sv_role(book); cur text; u uuid := sv_uid();
begin
  select role into cur from sv_members where book_id = book and user_id = member;
  if cur is null then return; end if;
  if cur = 'owner' then raise exception 'owner_stays'; end if;
  if member <> u and (mine not in ('owner', 'admin') or (mine = 'admin' and cur = 'admin')) then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from sv_members where book_id = book and user_id = member;
  perform sv_member_doc(book, member);
  delete from sv_docs where path = 'users/' || member::text || '/home' and data->>'bookId' = book;
end $$;

-- ---------- the daily allowance for Claude ----------
-- cost: research = 5, draft = 1, photos = 1. Called by the rb-claude function with the person's own token.
create or replace function public.sv_use(cost int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := sv_uid(); lim int; used int;
begin
  insert into sv_profiles (user_id) values (u) on conflict do nothing;
  select daily_units into lim from sv_profiles where user_id = u;
  insert into sv_usage (user_id, day, units) values (u, current_date, 0) on conflict do nothing;
  select units into used from sv_usage where user_id = u and day = current_date for update;
  if used + cost > lim then raise exception 'daily_limit' using errcode = 'P0001', detail = lim::text; end if;
  update sv_usage set units = units + cost where user_id = u and day = current_date;
  return jsonb_build_object('left', lim - used - cost, 'limit', lim);
end $$;

-- Lock every sv_ function first (helpers stay private), then open only the ones the website calls, to signed-in people.
-- (The old rb_ functions are left exactly as they are.)
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'sv\_%' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
grant execute on function
  public.sv_now(), public.sv_get(text), public.sv_list(text), public.sv_set(text, jsonb), public.sv_update(text, jsonb),
  public.sv_delete(text), public.sv_changes(timestamptz), public.sv_photo_put(text, text, text), public.sv_photo_get(text),
  public.sv_bootstrap(text), public.sv_me(), public.sv_set_name(text), public.sv_set_home(text), public.sv_new_book(text),
  public.sv_rename_book(text, text), public.sv_names(text, text[]), public.sv_create_invite(text, text, int, int),
  public.sv_list_invites(text), public.sv_revoke_invite(text), public.sv_invite_info(text), public.sv_join(text),
  public.sv_set_role(text, uuid, text), public.sv_remove_member(text, uuid), public.sv_use(int)
  to authenticated;
-- The old family-key functions (rb_*) stay as they are until the family book is moved over.

-- Pin the search path of the three small helper functions
alter function public.sv_merge(jsonb, jsonb) set search_path = public;
alter function public.sv_new_id() set search_path = public;
alter function public.sv_parent(text) set search_path = public;
