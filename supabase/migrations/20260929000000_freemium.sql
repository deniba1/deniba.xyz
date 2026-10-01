-- Roblox Alt Checker: accounts, plans and daily lookup quotas.
--
-- Run once: paste into the Supabase dashboard (SQL Editor -> New query -> Run),
-- or `supabase db push` with the CLI. Safe to run again.

-- ---------------------------------------------------------------------------
-- profiles: one row per account. Written only by the Edge Functions (service
-- role); a signed-in user can read their own row and nothing else.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                     uuid primary key references auth.users (id) on delete cascade,
  plan                   text not null default 'free' check (plan in ('free', 'pro')),
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  subscription_status    text,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users read their own profile" on public.profiles;
create policy "Users read their own profile" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant all on public.profiles to service_role;

-- Every new sign-up gets a free profile.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Accounts that existed before this migration.
insert into public.profiles (id) select id from auth.users on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- usage: lookups per subject per UTC day. subject is 'u:<user id>' for
-- accounts or 'ip:<salted hash>' for guests. It stores counts only, never
-- which usernames were looked up. No client access at all.
-- ---------------------------------------------------------------------------
create table if not exists public.usage (
  subject text    not null,
  day     date    not null,
  count   integer not null default 0,
  primary key (subject, day)
);
create index if not exists usage_day_idx on public.usage (day);

alter table public.usage enable row level security;
revoke all on public.usage from anon, authenticated;
grant all on public.usage to service_role;

-- Atomically take one lookup from today's allowance. Returns the new count,
-- or null when the subject is already at p_limit.
create or replace function public.consume_lookup(p_subject text, p_limit integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_count integer;
begin
  if p_limit < 1 then
    return null;
  end if;
  insert into public.usage as u (subject, day, count) values (p_subject, v_today, 1)
  on conflict (subject, day) do update set count = u.count + 1 where u.count < p_limit
  returning u.count into v_count;
  -- First lookup of the day: sweep out counters more than two days old.
  if v_count = 1 then
    delete from public.usage where day < v_today - 2;
  end if;
  return v_count;
end $$;

-- Give a lookup back (the Roblox call failed, so it shouldn't count).
create or replace function public.refund_lookup(p_subject text) returns void
language sql security definer set search_path = '' as $$
  update public.usage set count = greatest(count - 1, 0)
  where subject = p_subject and day = (now() at time zone 'utc')::date;
$$;

revoke execute on function public.consume_lookup(text, integer) from public, anon, authenticated;
revoke execute on function public.refund_lookup(text) from public, anon, authenticated;
grant execute on function public.consume_lookup(text, integer) to service_role;
grant execute on function public.refund_lookup(text) to service_role;
