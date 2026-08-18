-- RPC Functions for Lyney Card Draw System

-- Helper function to generate 6-character rejoin code (no 0, O, 1, I, L)
create or replace function generate_player_code()
returns text
language plpgsql
as $$
declare
  chars text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  result text := '';
  i int;
begin
  for i in 1..6 loop
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  end loop;
  return result;
end;
$$;

-- 1. Enter Room (Join or Rejoin)
create or replace function enter_room(
  p_room_code text,
  p_player_code text default null,
  p_name text default null,
  p_table_label text default null
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

    -- Generate unique player_code for this room
    loop
      v_new_code := generate_player_code();
      exit when not exists (
        select 1 from players where room_code = p_room_code and player_code = v_new_code
      );
    end loop;

    insert into players (room_code, player_code, auth_uid, name, table_label)
    values (p_room_code, v_new_code, v_caller_uid, trim(p_name), trim(p_table_label))
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

-- 2. Perform Draw (Player Action)
create or replace function perform_draw(p_player_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_player record;
  v_room_rules jsonb;
  v_consumed_id uuid;
  v_hand_count int;
  v_hand_limit int;
  v_no_dupes boolean := false;
  v_card_id uuid;
  v_card record;
  v_held_id uuid;
  v_caller_uid uuid := auth.uid();
begin
  select * into v_player from players where id = p_player_id and active = true;
  if v_player.id is null then
    raise exception 'player_not_found_or_inactive' using errcode = 'P0007';
  end if;

  -- Consume one pending draw permission atomically
  update pending_actions
     set consumed_at = now()
   where id = (
     select id from pending_actions
      where player_id = p_player_id and action = 'draw'
        and consumed_at is null and revoked_at is null
      order by issued_at
      limit 1
      for update skip locked)
   returning id into v_consumed_id;

  if v_consumed_id is null then
    raise exception 'no_permission' using errcode = 'P0001';
  end if;

  -- Read room rules
  select rules into v_room_rules from rooms where code = v_player.room_code;
  if v_room_rules ? 'hand_limit' then
    v_hand_limit := (v_room_rules->>'hand_limit')::int;
    select count(*) into v_hand_count from held_cards where player_id = p_player_id;
    if v_hand_count >= v_hand_limit then
      -- Revert consumed permission so player doesn't lose it
      update pending_actions set consumed_at = null where id = v_consumed_id;
      raise exception 'hand_limit_reached' using errcode = 'P0008';
    end if;
  end if;

  if v_room_rules ? 'no_duplicates_in_hand' then
    v_no_dupes := coalesce((v_room_rules->>'no_duplicates_in_hand')::boolean, false);
  end if;

  -- Pick card by weight
  select c.id into v_card_id
  from cards c
  where c.active
    and (not v_no_dupes or c.id not in (select card_id from held_cards where player_id = p_player_id))
  order by -ln(random()) / c.weight
  limit 1;

  -- Fallback if no_duplicates eliminated all cards
  if v_card_id is null then
    select c.id into v_card_id
    from cards c
    where c.active
    order by -ln(random()) / c.weight
    limit 1;
  end if;

  if v_card_id is null then
    update pending_actions set consumed_at = null where id = v_consumed_id;
    raise exception 'no_active_cards' using errcode = 'P0009';
  end if;

  -- Insert into held_cards
  insert into held_cards (player_id, room_code, card_id, source)
  values (p_player_id, v_player.room_code, v_card_id, 'draw')
  returning id into v_held_id;

  -- Log action
  insert into command_log (room_code, player_id, card_id, action, actor, actor_uid)
  values (v_player.room_code, p_player_id, v_card_id, 'draw', 'player', v_caller_uid);

  select id, title, image_path into v_card from cards where id = v_card_id;

  return jsonb_build_object(
    'held_card_id', v_held_id,
    'card_id', v_card.id,
    'title', v_card.title,
    'image_path', v_card.image_path,
    'source', 'draw',
    'acquired_at', now()
  );
end;
$$;

-- 3. Perform Discard (Player Action)
create or replace function perform_discard(p_held_card_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_held record;
  v_consumed_id uuid;
  v_caller_uid uuid := auth.uid();
begin
  select h.*, p.room_code into v_held
  from held_cards h
  join players p on h.player_id = p.id
  where h.id = p_held_card_id;

  if v_held.id is null then
    raise exception 'card_not_held' using errcode = 'P0010';
  end if;

  -- Consume one pending discard permission atomically
  update pending_actions
     set consumed_at = now()
   where id = (
     select id from pending_actions
      where player_id = v_held.player_id and action = 'discard'
        and consumed_at is null and revoked_at is null
      order by issued_at
      limit 1
      for update skip locked)
   returning id into v_consumed_id;

  if v_consumed_id is null then
    raise exception 'no_permission' using errcode = 'P0001';
  end if;

  delete from held_cards where id = p_held_card_id;

  insert into command_log (room_code, player_id, card_id, action, actor, actor_uid)
  values (v_held.room_code, v_held.player_id, v_held.card_id, 'discard', 'player', v_caller_uid);

  return jsonb_build_object('success', true, 'held_card_id', p_held_card_id);
end;
$$;

-- 4. Claim Host
create or replace function claim_host(p_code text, p_pin text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_room record;
  v_caller_uid uuid := auth.uid();
begin
  select * into v_room from rooms where code = p_code;
  if v_room.code is null then
    raise exception 'room_not_found' using errcode = 'P0004';
  end if;

  if v_room.host_pin <> p_pin then
    raise exception 'invalid_pin' using errcode = 'P0011';
  end if;

  if v_caller_uid is null then
    raise exception 'unauthenticated' using errcode = 'P0012';
  end if;

  insert into room_hosts (room_code, auth_uid)
  values (p_code, v_caller_uid)
  on conflict (room_code, auth_uid) do nothing;

  return jsonb_build_object('success', true, 'room_code', p_code);
end;
$$;

-- Helper to check host status
create or replace function is_room_host(p_room_code text, p_uid uuid)
returns boolean
language sql
security definer
as $$
  select exists (
    select 1 from room_hosts where room_code = p_room_code and auth_uid = p_uid
  );
$$;

-- 5. Issue Permission
create or replace function issue_permission(
  p_room_code text,
  p_scope text, -- 'room', 'table', 'player'
  p_action text, -- 'draw', 'discard'
  p_count int default 1,
  p_target_id uuid default null,
  p_target_table text default null
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
        (p_scope = 'table' and table_label = p_target_table) or
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

-- 6. Close Window
create or replace function close_window(
  p_room_code text,
  p_scope text,
  p_action text,
  p_fulfil boolean default true,
  p_target_table text default null,
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
          (p_scope = 'table' and p.table_label = p_target_table) or
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
        (p_scope = 'table' and p.table_label = p_target_table) or
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

-- 7. Host Direct Actions
create or replace function host_draw(p_player_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_player record;
  v_card_id uuid;
  v_held_id uuid;
  v_card record;
  v_caller_uid uuid := auth.uid();
begin
  select * into v_player from players where id = p_player_id;
  if not is_room_host(v_player.room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  select c.id into v_card_id from cards c where c.active order by -ln(random()) / c.weight limit 1;
  if v_card_id is null then
    raise exception 'no_active_cards' using errcode = 'P0009';
  end if;

  insert into held_cards (player_id, room_code, card_id, source)
  values (p_player_id, v_player.room_code, v_card_id, 'draw')
  returning id into v_held_id;

  insert into command_log (room_code, player_id, card_id, action, actor, actor_uid)
  values (v_player.room_code, p_player_id, v_card_id, 'draw', 'host', v_caller_uid);

  select id, title, image_path into v_card from cards where id = v_card_id;

  return jsonb_build_object(
    'held_card_id', v_held_id,
    'card_id', v_card.id,
    'title', v_card.title,
    'image_path', v_card.image_path,
    'source', 'draw'
  );
end;
$$;

create or replace function grant_card(p_player_id uuid, p_card_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_player record;
  v_held_id uuid;
  v_caller_uid uuid := auth.uid();
begin
  select * into v_player from players where id = p_player_id;
  if not is_room_host(v_player.room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  insert into held_cards (player_id, room_code, card_id, source)
  values (p_player_id, v_player.room_code, p_card_id, 'grant')
  returning id into v_held_id;

  insert into command_log (room_code, player_id, card_id, action, actor, actor_uid)
  values (v_player.room_code, p_player_id, p_card_id, 'grant', 'host', v_caller_uid);

  return jsonb_build_object('success', true, 'held_card_id', v_held_id);
end;
$$;

create or replace function revoke_card(p_held_card_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_held record;
  v_caller_uid uuid := auth.uid();
begin
  select h.*, p.room_code into v_held
  from held_cards h
  join players p on h.player_id = p.id
  where h.id = p_held_card_id;

  if not is_room_host(v_held.room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  delete from held_cards where id = p_held_card_id;

  insert into command_log (room_code, player_id, card_id, action, actor, actor_uid)
  values (v_held.room_code, v_held.player_id, v_held.card_id, 'revoke', 'host', v_caller_uid);

  return jsonb_build_object('success', true, 'held_card_id', p_held_card_id);
end;
$$;

create or replace function bulk_grant(
  p_room_code text,
  p_scope text,
  p_card_id uuid,
  p_target_table text default null
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
      and (p_scope = 'room' or (p_scope = 'table' and table_label = p_target_table))
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

-- 8. Player Management
create or replace function update_player(p_player_id uuid, p_name text, p_table_label text)
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
     set name = trim(p_name),
         table_label = trim(p_table_label)
   where id = p_player_id;

  return jsonb_build_object('success', true);
end;
$$;

create or replace function remove_player(p_player_id uuid)
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

  update players set active = false, removed_at = now() where id = p_player_id;
  update pending_actions set revoked_at = now() where player_id = p_player_id and consumed_at is null;

  insert into command_log (room_code, player_id, action, actor, actor_uid)
  values (v_room_code, p_player_id, 'remove_player', 'host', v_caller_uid);

  return jsonb_build_object('success', true);
end;
$$;

create or replace function restore_player(p_player_id uuid)
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

  update players set active = true, removed_at = null where id = p_player_id;

  insert into command_log (room_code, player_id, action, actor, actor_uid)
  values (v_room_code, p_player_id, 'restore_player', 'host', v_caller_uid);

  return jsonb_build_object('success', true);
end;
$$;

create or replace function player_history(p_player_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_room_code text;
  v_history jsonb;
  v_caller_uid uuid := auth.uid();
begin
  select room_code into v_room_code from players where id = p_player_id;
  -- Allow if caller is host OR caller is the owning player
  if not (is_room_host(v_room_code, v_caller_uid) or exists(select 1 from players where id = p_player_id and auth_uid = v_caller_uid)) then
    raise exception 'unauthorized' using errcode = 'P0013';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'seq', l.seq,
    'action', l.action,
    'actor', l.actor,
    'card_title', c.title,
    'at', l.at,
    'undone', l.undone
  ) order by l.seq desc), '[]'::jsonb)
  into v_history
  from command_log l
  left join cards c on l.card_id = c.id
  where l.player_id = p_player_id;

  return v_history;
end;
$$;

-- 9. Catalog & Weight Management
create or replace function sync_catalog(p_objects jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_obj jsonb;
  v_path text;
  v_title text;
  v_inserted int := 0;
  v_deactivated int := 0;
begin
  -- Insert or update cards from storage objects
  for v_obj in select * from jsonb_array_elements(p_objects) loop
    v_path := v_obj->>'path';
    v_title := v_obj->>'title';

    insert into cards (title, image_path, weight, active)
    values (v_title, v_path, 1, true)
    on conflict (image_path) do update set active = true;

    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object('success', true, 'synced', v_inserted);
end;
$$;

create or replace function set_card_weight(p_card_id uuid, p_weight int)
returns jsonb
language plpgsql
security definer
as $$
begin
  if p_weight <= 0 then
    raise exception 'invalid_weight' using errcode = 'P0014';
  end if;

  update cards set weight = p_weight where id = p_card_id;

  return jsonb_build_object('success', true);
end;
$$;

-- 10. Undo Action
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
    and action in ('grant', 'revoke', 'draw', 'discard', 'remove_player', 'restore_player')
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
  end if;

  update command_log set undone = true where seq = v_last.seq;

  return jsonb_build_object('success', true, 'undone_seq', v_last.seq, 'action', v_last.action);
end;
$$;

-- 11. Create Room & Room Cleanup
create or replace function create_room(p_code text, p_pin text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_code text := upper(trim(p_code));
  v_caller_uid uuid := auth.uid();
begin
  if v_code is null or length(v_code) < 3 then
    raise exception 'invalid_room_code' using errcode = 'P0016';
  end if;

  if exists(select 1 from rooms where code = v_code) then
    raise exception 'room_already_exists' using errcode = 'P0017';
  end if;

  insert into rooms (code, host_pin) values (v_code, trim(p_pin));

  if v_caller_uid is not null then
    insert into room_hosts (room_code, auth_uid) values (v_code, v_caller_uid)
    on conflict do nothing;
  end if;

  return jsonb_build_object('success', true, 'room_code', v_code);
end;
$$;

create or replace function reset_room(p_room_code text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
begin
  if not is_room_host(p_room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  -- Deleting players cascades to held_cards, pending_actions, and command_log
  delete from players where room_code = p_room_code;

  return jsonb_build_object('success', true, 'room_code', p_room_code);
end;
$$;
