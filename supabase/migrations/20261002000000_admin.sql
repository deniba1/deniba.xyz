-- Roblox Alt Checker: admin accounts.
--
-- Run after the earlier migrations, the same way: paste into the Supabase
-- dashboard (SQL Editor -> New query -> Run). Safe to run again.
--
-- An admin has no lookup limits and can ask the check function for debugging
-- detail and site-wide numbers. The flag lives on the profile row, which only
-- the service role can write, so nobody can grant it to themselves. To make an
-- account an admin, run (with that account's email):
--
--   update public.profiles set is_admin = true
--   where id = (select id from auth.users where email = 'someone@example.com');

alter table public.profiles add column if not exists is_admin boolean not null default false;

-- Site-wide numbers for the admin panel: accounts by plan, and today's and
-- yesterday's use. Counts only; nothing here identifies a visitor.
create or replace function public.admin_stats() returns jsonb
language sql security definer set search_path = '' as $$
  with days as (
    select d as day, jsonb_build_object(
      'lookups',         coalesce(sum(u.count) filter (where u.subject like 'u:%' or u.subject like 'ip:%'), 0),
      'guestLookups',    coalesce(sum(u.count) filter (where u.subject like 'ip:%'), 0),
      'accountLookups',  coalesce(sum(u.count) filter (where u.subject like 'u:%'), 0),
      'deepChecks',      coalesce(sum(u.count) filter (where u.subject like 'deep:%'), 0),
      'activeAccounts',  count(*) filter (where u.subject like 'u:%' and u.count > 0),
      'guestNetworks',   count(*) filter (where u.subject like 'ip:%' and u.count > 0),
      'nonProTotal',     coalesce(max(u.count) filter (where u.subject = 'global'), 0)
    ) as numbers
    from (values ((now() at time zone 'utc')::date), ((now() at time zone 'utc')::date - 1)) as v(d)
    left join public.usage u on u.day = v.d
    group by d
  )
  select jsonb_build_object(
    'accounts', (select coalesce(jsonb_object_agg(plan, n), '{}'::jsonb) from (select plan, count(*) as n from public.profiles group by plan) p),
    'admins',   (select count(*) from public.profiles where is_admin),
    'today',    (select numbers from days where day = (now() at time zone 'utc')::date),
    'yesterday', (select numbers from days where day = (now() at time zone 'utc')::date - 1)
  );
$$;

revoke execute on function public.admin_stats() from public, anon, authenticated;
grant execute on function public.admin_stats() to service_role;
