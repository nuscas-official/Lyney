-- One room per physical table; join codes are generated, not chosen.
--
-- Multiple tables inside a single room added a grouping layer that bought
-- nothing: every table already needs its own permission window, so a room per
-- table is the same thing with less state. players.table_label and the 'table'
-- permission scope are gone.
--
-- Rooms now carry a host-set label ("Table 3") for identification and a
-- server-generated join code as the player credential, kept separate from the
-- host PIN. Hand-picked codes collided on obvious names and were guessable
-- enough for players to wander into a neighbouring table's room.
--
-- WIPES existing rooms so every room in the database has a generated code.

begin;

delete from command_log;
delete from rooms;  -- cascades to players, held_cards, pending_actions

alter table rooms   add column if not exists label text not null default '';
alter table players drop column if exists table_label;

-- Repeated from 005 so this migration stands alone if 005 was never applied.
create unique index if not exists idx_players_room_name_unique
  on players (room_code, lower(name));

-- Signatures change, so these cannot be replaced in place.
drop function if exists enter_room(text, text, text, text);
drop function if exists issue_permission(text, text, text, int, uuid, text);
drop function if exists close_window(text, text, text, boolean, text, uuid);
drop function if exists bulk_grant(text, text, uuid, text);
drop function if exists update_player(uuid, text, text);
drop function if exists create_room(text, text);

create or replace function enter_room(
  p_room_code text,
  p_player_code text default null,
  p_name text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_player record;
  v_new_code text;
  v_room_exists boolean;
  v_hand jsonb;
  v_caller_uid uuid := auth.uid();
begin
  select exists(select 1 from rooms where code = p_room_code) into v_room_exists;
  if not v_room_exists then
    raise exception 'room_not_found' using errcode = 'P0004';
  end if;

  if p_player_code is null or trim(p_player_code) = '' then
    -- New player creation
    if p_name is null or trim(p_name) = '' then
      raise exception 'name_required' using errcode = 'P0005';
    end if;

    -- Names must be unique per room so the host can identify players at a
    -- glance. Removed players are included: restore_player could otherwise
    -- resurrect a name that has since been taken.
    if exists (
      select 1 from players
       where room_code = p_room_code
         and lower(name) = lower(trim(p_name))
    ) then
      raise exception 'name_taken' using errcode = 'P0018';
    end if;

    -- Generate unique player_code for this room
    loop
      v_new_code := generate_player_code();
      exit when not exists (
        select 1 from players where room_code = p_room_code and player_code = v_new_code
      );
    end loop;

    insert into players (room_code, player_code, auth_uid, name)
    values (p_room_code, v_new_code, v_caller_uid, trim(p_name))
    returning * into v_player;
  else
    -- Rejoin existing player
    p_player_code := upper(trim(p_player_code));
    select * into v_player
      from players
     where room_code = p_room_code
       and player_code = p_player_code;

    if v_player.id is null then
      raise exception 'invalid_player_code' using errcode = 'P0003';
    end if;

    if not v_player.active then
      raise exception 'player_removed' using errcode = 'P0006';
    end if;

    -- Rebind auth_uid to caller and update last_seen
    update players
       set auth_uid = v_caller_uid,
           last_seen = now()
     where id = v_player.id
    returning * into v_player;
  end if;

  -- Fetch player's current hand
  select coalesce(jsonb_agg(jsonb_build_object(
    'held_card_id', h.id,
    'card_id', c.id,
    'title', c.title,
    'image_path', c.image_path,
    'source', h.source,
    'acquired_at', h.acquired_at
  ) order by h.acquired_at desc), '[]'::jsonb)
  into v_hand
  from held_cards h
  join cards c on h.card_id = c.id
  where h.player_id = v_player.id;

  return jsonb_build_object(
    'player', row_to_json(v_player),
    'hand', v_hand
  );
end;
$$;

create or replace function issue_permission(
  p_room_code text,
  p_scope text, -- 'room', 'player'
  p_action text, -- 'draw', 'discard'
  p_count int default 1,
  p_target_id uuid default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_player record;
  i int;
  v_issued_count int := 0;
begin
  if not is_room_host(p_room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  for v_player in
    select id from players
    where room_code = p_room_code
      and active = true
      and (
        p_scope = 'room' or
        (p_scope = 'player' and id = p_target_id)
      )
  loop
    for i in 1..p_count loop
      insert into pending_actions (player_id, room_code, action, issued_by)
      values (v_player.id, p_room_code, p_action, v_caller_uid);
      v_issued_count := v_issued_count + 1;
    end loop;
  end loop;

  insert into command_log (room_code, action, actor, actor_uid)
  values (p_room_code, 'permit', 'host', v_caller_uid);

  return jsonb_build_object('success', true, 'issued_count', v_issued_count);
end;
$$;

create or replace function close_window(
  p_room_code text,
  p_scope text,
  p_action text,
  p_fulfil boolean default true,
  p_target_id uuid default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_pending record;
  v_room_rules jsonb;
  v_hand_limit int;
  v_hand_count int;
  v_no_dupes boolean := false;
  v_card_id uuid;
  v_auto_draw_count int := 0;
  v_revoked_count int := 0;
begin
  if not is_room_host(p_room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  if p_action = 'discard' and p_fulfil = true then
    raise exception 'fulfil_discard_not_allowed' using errcode = 'P0002';
  end if;

  select rules into v_room_rules from rooms where code = p_room_code;
  if v_room_rules ? 'hand_limit' then
    v_hand_limit := (v_room_rules->>'hand_limit')::int;
  end if;
  if v_room_rules ? 'no_duplicates_in_hand' then
    v_no_dupes := coalesce((v_room_rules->>'no_duplicates_in_hand')::boolean, false);
  end if;

  if p_action = 'draw' and p_fulfil = true then
    -- Auto-draw for outstanding permissions
    for v_pending in
      select pa.id as pending_id, pa.player_id
      from pending_actions pa
      join players p on pa.player_id = p.id
      where pa.room_code = p_room_code
        and pa.action = 'draw'
        and pa.consumed_at is null
        and pa.revoked_at is null
        and p.active = true
        and (
          p_scope = 'room' or
          (p_scope = 'player' and p.id = p_target_id)
        )
      order by pa.issued_at
    loop
      -- Check hand limit
      if v_hand_limit is not null then
        select count(*) into v_hand_count from held_cards where player_id = v_pending.player_id;
        if v_hand_count >= v_hand_limit then
          -- Skip draw due to hand limit, revoke permission
          update pending_actions set revoked_at = now() where id = v_pending.pending_id;
          continue;
        end if;
      end if;

      -- Select card
      select c.id into v_card_id
      from cards c
      where c.active
        and (not v_no_dupes or c.id not in (select card_id from held_cards where player_id = v_pending.player_id))
      order by -ln(random()) / c.weight
      limit 1;

      if v_card_id is null then
        select c.id into v_card_id from cards c where c.active order by -ln(random()) / c.weight limit 1;
      end if;

      if v_card_id is not null then
        update pending_actions set consumed_at = now() where id = v_pending.pending_id;
        insert into held_cards (player_id, room_code, card_id, source)
        values (v_pending.player_id, p_room_code, v_card_id, 'draw');

        insert into command_log (room_code, player_id, card_id, action, actor, actor_uid)
        values (p_room_code, v_pending.player_id, v_card_id, 'auto_draw', 'host', v_caller_uid);
        v_auto_draw_count := v_auto_draw_count + 1;
      end if;
    end loop;
  end if;

  -- Revoke any remaining unconsumed permissions in scope
  with updated as (
    update pending_actions pa
       set revoked_at = now()
     from players p
    where pa.player_id = p.id
      and pa.room_code = p_room_code
      and pa.action = p_action
      and pa.consumed_at is null
      and pa.revoked_at is null
      and p.active = true
      and (
        p_scope = 'room' or
        (p_scope = 'player' and p.id = p_target_id)
      )
    returning pa.id
  )
  select count(*) into v_revoked_count from updated;

  insert into command_log (room_code, action, actor, actor_uid)
  values (p_room_code, 'unpermit', 'host', v_caller_uid);

  return jsonb_build_object('success', true, 'auto_drawn', v_auto_draw_count, 'revoked', v_revoked_count);
end;
$$;

create or replace function bulk_grant(
  p_room_code text,
  p_scope text,
  p_card_id uuid
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_player record;
  v_count int := 0;
begin
  if not is_room_host(p_room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  for v_player in
    select id from players
    where room_code = p_room_code
      and active = true
      and p_scope = 'room'
  loop
    insert into held_cards (player_id, room_code, card_id, source)
    values (v_player.id, p_room_code, p_card_id, 'grant');

    insert into command_log (room_code, player_id, card_id, action, actor, actor_uid)
    values (p_room_code, v_player.id, p_card_id, 'grant', 'host', v_caller_uid);
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('success', true, 'granted_count', v_count);
end;
$$;

create or replace function update_player(p_player_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_room_code text;
  v_caller_uid uuid := auth.uid();
begin
  select room_code into v_room_code from players where id = p_player_id;
  if not is_room_host(v_room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  update players
     set name = trim(p_name)
   where id = p_player_id;

  return jsonb_build_object('success', true);
end;
$$;

create or replace function create_room(p_label text, p_pin text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_label text := trim(p_label);
  v_code text;
  v_caller_uid uuid := coalesce(auth.uid(), gen_random_uuid());
begin
  if v_label is null or v_label = '' then
    raise exception 'label_required' using errcode = 'P0019';
  end if;

  -- The join code is generated, never chosen: hosts running one table each
  -- would otherwise collide on the obvious names, and a guessable code lets
  -- players wander into the wrong table's room.
  loop
    v_code := generate_player_code();
    exit when not exists (select 1 from rooms where code = v_code);
  end loop;

  insert into rooms (code, label, host_pin) values (v_code, v_label, trim(p_pin));

  insert into room_hosts (room_code, auth_uid) values (v_code, v_caller_uid)
  on conflict do nothing;

  return jsonb_build_object('success', true, 'room_code', v_code, 'label', v_label);
end;
$$;

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
begin
  select code, label into v_room from rooms where code = v_code;

  -- Players in room
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'player_code', p.player_code,
    'active', p.active,
    'created_at', p.created_at
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
    'image_path', c.image_path
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
    'issued_at', pa.issued_at
  )), '[]'::jsonb)
  into v_pending
  from pending_actions pa
  where pa.room_code = v_code
    and pa.consumed_at is null
    and pa.revoked_at is null;

  -- Cards catalog
  select coalesce(jsonb_agg(row_to_json(c) order by c.title), '[]'::jsonb)
  into v_cards
  from cards c
  where c.active = true;

  return jsonb_build_object(
    'room', jsonb_build_object('code', v_room.code, 'label', v_room.label),
    'players', v_players,
    'held_cards', v_held,
    'pending_actions', v_pending,
    'cards', v_cards
  );
end;
$$;

commit;
