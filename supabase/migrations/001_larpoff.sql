-- LARP-OFF temporary matchmaking and match state.
-- Run in the Supabase SQL editor or with: supabase db push

create extension if not exists pgcrypto;

create table if not exists public.waiting_queue (
  client_id uuid primary key,
  joined_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now()
);

create index if not exists waiting_queue_joined_at_idx on public.waiting_queue (joined_at);
create index if not exists waiting_queue_heartbeat_at_idx on public.waiting_queue (heartbeat_at);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  player_a uuid not null,
  player_b uuid not null,
  track_index smallint not null check (track_index between 1 and 3),
  status text not null default 'connecting' check (status in ('connecting', 'countdown', 'battle', 'judging', 'completed', 'abandoned')),
  result jsonb,
  judge_claim_id uuid,
  judge_claimed_at timestamptz,
  judge_attempts smallint not null default 0 check (judge_attempts between 0 and 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint different_players check (player_a <> player_b)
);

create index if not exists matches_player_a_idx on public.matches (player_a, created_at desc);
create index if not exists matches_player_b_idx on public.matches (player_b, created_at desc);
create index if not exists matches_created_at_idx on public.matches (created_at);

alter table public.waiting_queue enable row level security;
alter table public.matches enable row level security;
revoke all on public.waiting_queue from anon, authenticated;
revoke all on public.matches from anon, authenticated;

create or replace function public.join_larp_queue(p_client_id uuid)
returns table (
  match_id uuid, queue_status text, player_a uuid, player_b uuid,
  track_index smallint, match_status text, result jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_opponent uuid;
  v_match public.matches%rowtype;
begin
  if p_client_id is null then raise exception 'client_id is required'; end if;

  -- A single transaction lock keeps selection + deletion + insertion atomic.
  perform pg_advisory_xact_lock(hashtext('larpoff_matchmaking_v1'));
  delete from public.waiting_queue where heartbeat_at < now() - interval '30 seconds';
  delete from public.matches where created_at < now() - interval '2 hours';

  select m.* into v_match
  from public.matches m
  where (m.player_a = p_client_id or m.player_b = p_client_id)
    and m.status in ('connecting', 'countdown', 'battle', 'judging')
    and m.created_at > now() - interval '10 minutes'
  order by m.created_at desc limit 1;

  if found then
    return query select v_match.id, 'MATCHED'::text, v_match.player_a, v_match.player_b,
      v_match.track_index, v_match.status, v_match.result;
    return;
  end if;

  select q.client_id into v_opponent
  from public.waiting_queue q
  where q.client_id <> p_client_id and q.heartbeat_at >= now() - interval '30 seconds'
  order by q.joined_at asc
  limit 1 for update skip locked;

  if v_opponent is null then
    insert into public.waiting_queue (client_id, joined_at, heartbeat_at)
    values (p_client_id, now(), now())
    on conflict (client_id) do update set heartbeat_at = now();
    return query select null::uuid, 'WAITING'::text, null::uuid, null::uuid,
      null::smallint, null::text, null::jsonb;
    return;
  end if;

  delete from public.waiting_queue where client_id in (v_opponent, p_client_id);
  insert into public.matches (player_a, player_b, track_index)
  values (v_opponent, p_client_id, (floor(random() * 3) + 1)::smallint)
  returning * into v_match;

  return query select v_match.id, 'MATCHED'::text, v_match.player_a, v_match.player_b,
    v_match.track_index, v_match.status, v_match.result;
end;
$$;

create or replace function public.check_larp_match(p_client_id uuid)
returns table (
  match_id uuid, queue_status text, player_a uuid, player_b uuid,
  track_index smallint, match_status text, result jsonb
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select m.id, 'MATCHED'::text, m.player_a, m.player_b, m.track_index, m.status, m.result
  from public.matches m
  where (m.player_a = p_client_id or m.player_b = p_client_id)
    and m.status in ('connecting', 'countdown', 'battle', 'judging')
    and m.created_at > now() - interval '10 minutes'
  order by m.created_at desc limit 1;
$$;

create or replace function public.heartbeat_larp_queue(p_client_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$ update public.waiting_queue set heartbeat_at = now() where client_id = p_client_id; $$;

create or replace function public.leave_larp_queue(p_client_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$ delete from public.waiting_queue where client_id = p_client_id; $$;

create or replace function public.update_larp_match_status(p_match_id uuid, p_client_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_status not in ('countdown', 'battle', 'judging') then return false; end if;
  update public.matches set status = p_status, updated_at = now()
  where id = p_match_id and player_a = p_client_id and status not in ('completed', 'abandoned');
  return found;
end;
$$;

create or replace function public.abandon_larp_match(p_match_id uuid, p_client_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.matches set status = 'abandoned', updated_at = now()
  where id = p_match_id and p_client_id in (player_a, player_b) and status <> 'completed';
  return found;
end;
$$;

create or replace function public.get_larp_match(p_match_id uuid, p_client_id uuid)
returns table (
  match_id uuid, queue_status text, player_a uuid, player_b uuid,
  track_index smallint, match_status text, result jsonb
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select m.id, 'MATCHED'::text, m.player_a, m.player_b, m.track_index, m.status, m.result
  from public.matches m where m.id = p_match_id and p_client_id in (m.player_a, m.player_b) limit 1;
$$;

-- Called only by the Edge Function using the service role. This is an atomic,
-- three-attempt lease that prevents duplicate OpenAI calls.
create or replace function public.claim_larp_judging(p_match_id uuid, p_client_id uuid, p_claim_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_match public.matches%rowtype;
begin
  select * into v_match from public.matches where id = p_match_id for update;
  if not found then return jsonb_build_object('state', 'not_found'); end if;
  if v_match.player_a <> p_client_id then return jsonb_build_object('state', 'forbidden'); end if;
  if v_match.result is not null then return jsonb_build_object('state', 'complete', 'result', v_match.result); end if;
  if v_match.status not in ('battle', 'judging') then return jsonb_build_object('state', 'invalid_status'); end if;
  if v_match.judge_attempts >= 3 then return jsonb_build_object('state', 'attempts_exhausted'); end if;
  if v_match.judge_claim_id is not null and v_match.judge_claimed_at > now() - interval '60 seconds' then
    return jsonb_build_object('state', 'busy');
  end if;
  update public.matches set judge_claim_id = p_claim_id, judge_claimed_at = now(),
    judge_attempts = judge_attempts + 1, status = 'judging', updated_at = now()
  where id = p_match_id;
  return jsonb_build_object('state', 'claimed');
end;
$$;

create or replace function public.complete_larp_judging(p_match_id uuid, p_claim_id uuid, p_result jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.matches set result = p_result, status = 'completed', judge_claim_id = null,
    judge_claimed_at = null, updated_at = now()
  where id = p_match_id and judge_claim_id = p_claim_id and result is null;
  return found;
end;
$$;

create or replace function public.release_larp_judging(p_match_id uuid, p_claim_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.matches set judge_claim_id = null, judge_claimed_at = null, updated_at = now()
  where id = p_match_id and judge_claim_id = p_claim_id and result is null;
$$;

revoke all on function public.join_larp_queue(uuid) from public;
revoke all on function public.check_larp_match(uuid) from public;
revoke all on function public.heartbeat_larp_queue(uuid) from public;
revoke all on function public.leave_larp_queue(uuid) from public;
revoke all on function public.update_larp_match_status(uuid, uuid, text) from public;
revoke all on function public.abandon_larp_match(uuid, uuid) from public;
revoke all on function public.get_larp_match(uuid, uuid) from public;
revoke all on function public.claim_larp_judging(uuid, uuid, uuid) from public;
revoke all on function public.complete_larp_judging(uuid, uuid, jsonb) from public;
revoke all on function public.release_larp_judging(uuid, uuid) from public;

grant execute on function public.join_larp_queue(uuid) to anon, authenticated;
grant execute on function public.check_larp_match(uuid) to anon, authenticated;
grant execute on function public.heartbeat_larp_queue(uuid) to anon, authenticated;
grant execute on function public.leave_larp_queue(uuid) to anon, authenticated;
grant execute on function public.update_larp_match_status(uuid, uuid, text) to anon, authenticated;
grant execute on function public.abandon_larp_match(uuid, uuid) to anon, authenticated;
grant execute on function public.get_larp_match(uuid, uuid) to anon, authenticated;
grant execute on function public.claim_larp_judging(uuid, uuid, uuid) to service_role;
grant execute on function public.complete_larp_judging(uuid, uuid, jsonb) to service_role;
grant execute on function public.release_larp_judging(uuid, uuid) to service_role;
