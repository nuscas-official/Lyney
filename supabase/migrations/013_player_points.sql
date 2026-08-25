-- Players carry a points total the host can nudge up or down from the
-- console -- a scoreboard alongside the hand, not a currency spent on cards.
--
-- Stored as a plain int with no floor: a house rule might dock points below
-- zero, and clamping here would just mean re-deriving the true score off the
-- command log instead.

alter table players
  add column if not exists points int not null default 0;

-- undo_last needs to know how much an adjust_points call moved the total by
-- so it can move it back. Every other action undo_last reverses is a fully
-- self-describing row (a grant points at its own card_id, a remove_player
-- flips its own boolean) -- a points change is the first one whose reverse
-- needs a magnitude, so it is the first row to need one recorded.
alter table command_log
  add column if not exists delta int;

alter table command_log drop constraint if exists command_log_action_check;
alter table command_log
  add constraint command_log_action_check check (action in
    ('draw','auto_draw','discard','grant','revoke',
     'permit','unpermit','remove_player','restore_player','adjust_points'));

-- p_delta is added to the player's current total; pass a negative number to
-- subtract. Zero is rejected so an accidental blank submit from the console
-- doesn't spam the command log with no-op rows a host would then have to
-- undo through.
create or replace function adjust_points(p_player_id uuid, p_delta int)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_room_code text;
  v_new_points int;
  v_caller_uid uuid := auth.uid();
begin
  if p_delta = 0 then
    raise exception 'delta_required' using errcode = 'P0028';
  end if;

  select room_code into v_room_code from players where id = p_player_id;
  if not is_room_host(v_room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  update players
     set points = points + p_delta
   where id = p_player_id
  returning points into v_new_points;

  insert into command_log (room_code, player_id, action, actor, actor_uid, delta)
  values (v_room_code, p_player_id, 'adjust_points', 'host', v_caller_uid, p_delta);

  return jsonb_build_object('success', true, 'points', v_new_points);
end;
$$;

-- undo_last grows a reverse case for adjust_points alongside the actions it
-- already knows how to walk back.
create or replace function undo_last(p_room_code text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_last record;
begin
  if not is_room_host(p_room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  select * into v_last
  from command_log
  where room_code = p_room_code
    and actor = 'host'
    and undone = false
    and action in ('grant', 'revoke', 'draw', 'discard', 'remove_player', 'restore_player', 'adjust_points')
  order by seq desc
  limit 1;

  if v_last.seq is null then
    raise exception 'nothing_to_undo' using errcode = 'P0015';
  end if;

  -- Reverse action
  if v_last.action = 'grant' then
    delete from held_cards
    where id = (select id from held_cards where player_id = v_last.player_id and card_id = v_last.card_id order by acquired_at desc limit 1);
  elsif v_last.action = 'remove_player' then
    update players set active = true, removed_at = null where id = v_last.player_id;
  elsif v_last.action = 'restore_player' then
    update players set active = false, removed_at = now() where id = v_last.player_id;
  elsif v_last.action = 'adjust_points' then
    update players set points = points - v_last.delta where id = v_last.player_id;
  end if;

  update command_log set undone = true where seq = v_last.seq;

  return jsonb_build_object('success', true, 'undone_seq', v_last.seq, 'action', v_last.action);
end;
$$;

-- The roster carries points through to the console, same as every other
-- per-player field host_get_room already surfaces.
create or replace function host_get_room(p_room_code text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_code text := upper(trim(p_room_code));
  v_room record;
  v_players jsonb;
  v_held jsonb;
  v_pending jsonb;
  v_cards jsonb;
  v_events jsonb;
begin
  select code, label into v_room from rooms where code = v_code;

  -- Players in room
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'player_code', p.player_code,
    'active', p.active,
    'created_at', p.created_at,
    'race', p.race,
    'codename', p.codename,
    'reason', p.reason,
    'avatar_path', p.avatar_path,
    'points', p.points
  ) order by p.created_at), '[]'::jsonb)
  into v_players
  from players p
  where p.room_code = v_code;

  -- Held cards with card details
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', h.id,
    'player_id', h.player_id,
    'card_id', h.card_id,
    'source', h.source,
    'title', c.title,
    'image_path', c.image_path,
    'kind', c.kind
  )), '[]'::jsonb)
  into v_held
  from held_cards h
  join cards c on h.card_id = c.id
  where h.room_code = v_code;

  -- Pending actions
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', pa.id,
    'player_id', pa.player_id,
    'action', pa.action,
    'pool', pa.pool,
    'issued_at', pa.issued_at
  )), '[]'::jsonb)
  into v_pending
  from pending_actions pa
  where pa.room_code = v_code
    and pa.consumed_at is null
    and pa.revoked_at is null;

  -- Cards catalog (every group, including events)
  select coalesce(jsonb_agg(row_to_json(c) order by c.kind, c.title), '[]'::jsonb)
  into v_cards
  from cards c
  where c.active = true;

  -- Recent event draws. Nothing lands in a hand, so this feed is the only
  -- place the host can see which events came up and for whom.
  select coalesce(jsonb_agg(jsonb_build_object(
    'seq', e.seq,
    'player_id', e.player_id,
    'card_id', e.card_id,
    'title', e.title,
    'image_path', e.image_path,
    'at', e.at
  ) order by e.seq desc), '[]'::jsonb)
  into v_events
  from (
    select l.seq, l.player_id, l.card_id, c.title, c.image_path, l.at
    from command_log l
    join cards c on l.card_id = c.id
    where l.room_code = v_code
      and c.kind = 'event'
      and l.action in ('draw', 'auto_draw')
    order by l.seq desc
    limit 20
  ) e;

  return jsonb_build_object(
    'room', jsonb_build_object('code', v_room.code, 'label', v_room.label),
    'players', v_players,
    'held_cards', v_held,
    'pending_actions', v_pending,
    'cards', v_cards,
    'recent_events', v_events
  );
end;
$$;

-- enter_room already returns row_to_json(v_player) for the player's own
-- record, so it picks up the new points column with no change of its own.
