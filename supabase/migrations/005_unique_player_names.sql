-- Enforce unique display names within a room.
--
-- Two players called the same thing are indistinguishable in the host roster,
-- the grant/revoke menus and the command log. enter_room now rejects a taken
-- name (P0018) and a unique index makes the rule hold even if a future code
-- path bypasses the RPC.
--
-- If the index fails with "could not create unique index", the room already
-- contains duplicates. Find them with:
--   select room_code, lower(name), count(*) from players
--    group by 1,2 having count(*) > 1;
-- then rename the extras before re-running.

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

create unique index if not exists idx_players_room_name_unique
  on players (room_code, lower(name));
