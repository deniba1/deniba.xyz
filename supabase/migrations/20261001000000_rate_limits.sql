-- Roblox Alt Checker: rate limits shared by every copy of the Edge Functions.
--
-- Run after 20260929000000_freemium.sql, the same way: paste into the Supabase
-- dashboard (SQL Editor -> New query -> Run). Safe to run again.

-- ---------------------------------------------------------------------------
-- rate_limits: short fixed-window counters ("20 per minute"). key is an
-- opaque string chosen by the functions, e.g. 'ip:<salted hash>', 'u:<user
-- id>' or 'global'. No client access at all.
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
  key    text        not null,
  bucket timestamptz not null,
  count  integer     not null default 0,
  primary key (key, bucket)
);
create index if not exists rate_limits_bucket_idx on public.rate_limits (bucket);

alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;
grant all on public.rate_limits to service_role;

-- Count one hit against p_key in the current window. Returns false once the
-- window holds more than p_limit hits. Refused hits still count, so hammering
-- a limit doesn't free it up.
create or replace function public.take_token(p_key text, p_limit integer, p_window_seconds integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_bucket timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count  integer;
begin
  insert into public.rate_limits as r (key, bucket, count) values (p_key, v_bucket, 1)
  on conflict (key, bucket) do update set count = r.count + 1
  returning r.count into v_count;
  -- Now and then, on the first hit of a window, sweep out old windows.
  if v_count = 1 and random() < 0.05 then
    delete from public.rate_limits where bucket < now() - interval '1 day';
  end if;
  return v_count <= p_limit;
end $$;

-- Give back lookups taken from several daily counters at once.
create or replace function public.refund_lookups(p_subjects text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_subject text;
begin
  foreach v_subject in array p_subjects loop
    perform public.refund_lookup(v_subject);
  end loop;
end $$;

-- Decide in one atomic step whether a lookup may run.
--   p_burst: [{"key": text, "limit": int, "window": seconds}, ...]
--   p_daily: [{"key": text, "limit": int}, ...]  (the first is the caller's own allowance)
-- Every burst window must have room, then every daily counter; if a daily
-- counter is full, the ones already taken are given back. Returns
--   {"ok": true, "used": <count on the first daily counter>}
--   {"ok": false, "reason": "burst" | "daily", "index": <which entry refused>}
create or replace function public.admit_lookup(p_burst jsonb, p_daily jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_item  jsonb;
  v_index integer;
  v_count integer;
  v_used  integer;
  v_taken text[] := '{}';
begin
  for v_item, v_index in
    select value, ordinality - 1 from jsonb_array_elements(p_burst) with ordinality order by ordinality
  loop
    if not public.take_token(v_item->>'key', (v_item->>'limit')::integer, (v_item->>'window')::integer) then
      return jsonb_build_object('ok', false, 'reason', 'burst', 'index', v_index);
    end if;
  end loop;

  for v_item, v_index in
    select value, ordinality - 1 from jsonb_array_elements(p_daily) with ordinality order by ordinality
  loop
    v_count := public.consume_lookup(v_item->>'key', (v_item->>'limit')::integer);
    if v_count is null then
      perform public.refund_lookups(v_taken);
      return jsonb_build_object('ok', false, 'reason', 'daily', 'index', v_index);
    end if;
    if v_index = 0 then
      v_used := v_count;
    end if;
    v_taken := v_taken || (v_item->>'key');
  end loop;

  return jsonb_build_object('ok', true, 'used', v_used);
end $$;

revoke execute on function public.take_token(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.refund_lookups(text[]) from public, anon, authenticated;
revoke execute on function public.admit_lookup(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.take_token(text, integer, integer) to service_role;
grant execute on function public.refund_lookups(text[]) to service_role;
grant execute on function public.admit_lookup(jsonb, jsonb) to service_role;
