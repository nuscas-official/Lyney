-- Cards belong to a group, and a draw permission names the pool it draws from.
--
-- Every card was previously one undifferentiated deck. Play needs three:
-- lucky and cursed cards go into a hand and stay there, while an event card is
-- announced, resolved at the table, and gone. The host decides which pool a
-- draw comes from when opening the window, so the pool rides on the permission
-- (pending_actions.pool) rather than on the room or the player.
--
--   lucky  -> lucky cards only
--   cursed -> cursed cards only
--   mixed  -> lucky and cursed together (the old behaviour)
--   event  -> event cards only; the draw is logged and shown, never held
--
-- Event cards never enter held_cards, so there is nothing for a host to
-- manually discard afterwards. grant_card and bulk_grant refuse them for the
-- same reason: a granted event would be a permanent card of a kind that is
-- meant to be transient. The host sees what was drawn through host_get_room's
-- recent_events feed, and the player keeps their most recent one via
-- enter_room's last_event, so a refresh mid-reveal does not lose it.
--
-- Existing cards become 'lucky' and existing draw permissions become 'mixed':
-- both preserve current behaviour for a room that is mid-session.

begin;

-- 1. Card groups
alter table cards
  add column if not exists kind text not null default 'lucky';

alter table cards
  add constraint cards_kind_valid check (kind in ('lucky', 'cursed', 'event'));

-- Pool draws filter on (active, kind) before weighting, on every draw.
create index if not exists idx_cards_kind_active on cards (kind) where active;

-- 2. The pool a draw permission draws from
alter table pending_actions
  add column if not exists pool text;

update pending_actions set pool = 'mixed' where action = 'draw' and pool is null;

-- Discards have no pool: null there is the absence of a pool, not a default.
-- The explicit "is not null" matters: a check whose expression evaluates to
-- null passes, so `pool in (...)` alone would let a pool-less draw through and
-- leave the pool to a coalesce somewhere downstream.
alter table pending_actions
  add constraint pending_actions_pool_valid check (
    (action = 'draw' and pool is not null and pool in ('lucky', 'cursed', 'mixed', 'event'))
    or (action <> 'draw' and pool is null)
  );

-- 3. Pool -> card kinds. One definition, used by every draw path.
create or replace function pool_kinds(p_pool text)
returns text[]
language sql
immutable
as $$
  select case coalesce(p_pool, 'mixed')
    when 'lucky'  then array['lucky']
    when 'cursed' then array['cursed']
    when 'event'  then array['event']
    else array['lucky', 'cursed']
  end;
$$;

-- Signatures change, so these cannot be replaced in place.
drop function if exists issue_permission(text, text, text, int, uuid);
drop function if exists host_draw(uuid);

-- 4. Issuing a permission names the pool
create or replace function issue_permission(
  p_room_code text,
  p_scope text,  -- 'room', 'player'
  p_action text, -- 'draw', 'discard'
  p_count int default 1,
  p_target_id uuid default null,
  p_pool text default 'mixed'
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_player record;
  v_pool text;
  i int;
  v_issued_count int := 0;
begin
  if not is_room_host(p_room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  if p_action = 'draw' then
    v_pool := coalesce(nullif(trim(p_pool), ''), 'mixed');
    if v_pool not in ('lucky', 'cursed', 'mixed', 'event') then
      raise exception 'invalid_pool' using errcode = 'P0024';
    end if;

    -- Fail on the host's click rather than on every player's draw button.
    if not exists (
      select 1 from cards where active and kind = any (pool_kinds(v_pool))
    ) then
      raise exception 'no_cards_in_pool' using errcode = 'P0022';
    end if;
  else
    v_pool := null;
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
      insert into pending_actions (player_id, room_code, action, issued_by, pool)
      values (v_player.id, p_room_code, p_action, v_caller_uid, v_pool);
      v_issued_count := v_issued_count + 1;
    end loop;
  end loop;

  insert into command_log (room_code, action, actor, actor_uid)
  values (p_room_code, 'permit', 'host', v_caller_uid);

  return jsonb_build_object('success', true, 'issued_count', v_issued_count, 'pool', v_pool);
end;
$$;

-- 5. Drawing reads the pool off the permission being consumed
create or replace function perform_draw(p_player_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_player record;
  v_room_rules jsonb;
  v_consumed_id uuid;
  v_pool text;
  v_kinds text[];
  v_is_event boolean;
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

  -- Consume one pending draw permission atomically. Permissions are consumed
  -- oldest first, so the pool the host opened first resolves first; the player
  -- never picks which pool they draw from.
  update pending_actions
     set consumed_at = now()
   where id = (
     select id from pending_actions
      where player_id = p_player_id and action = 'draw'
        and consumed_at is null and revoked_at is null
      order by issued_at
      limit 1
      for update skip locked)
   returning id, pool into v_consumed_id, v_pool;

  if v_consumed_id is null then
    raise exception 'no_permission' using errcode = 'P0001';
  end if;

  v_pool := coalesce(v_pool, 'mixed');
  v_kinds := pool_kinds(v_pool);
  v_is_event := v_pool = 'event';

  select rules into v_room_rules from rooms where code = v_player.room_code;

  -- Hand rules govern cards that end up in the hand. An event card does not.
  if not v_is_event then
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
  end if;

  -- Pick card by weight, within the pool
  select c.id into v_card_id
  from cards c
  where c.active
    and c.kind = any (v_kinds)
    and (not v_no_dupes or c.id not in (select card_id from held_cards where player_id = p_player_id))
  order by -ln(random()) / c.weight
  limit 1;

  -- Fallback if no_duplicates eliminated every card in the pool
  if v_card_id is null then
    select c.id into v_card_id
    from cards c
    where c.active
      and c.kind = any (v_kinds)
    order by -ln(random()) / c.weight
    limit 1;
  end if;

  if v_card_id is null then
    update pending_actions set consumed_at = null where id = v_consumed_id;
    raise exception 'no_cards_in_pool' using errcode = 'P0022';
  end if;

  select id, title, image_path, kind into v_card from cards where id = v_card_id;

  -- An event card is announced and resolved at the table; it is deliberately
  -- never written to held_cards, so there is nothing to discard afterwards.
  if not v_is_event then
    insert into held_cards (player_id, room_code, card_id, source)
    values (p_player_id, v_player.room_code, v_card_id, 'draw')
    returning id into v_held_id;
  end if;

  -- Logged either way: the log is the only record an event draw leaves.
  insert into command_log (room_code, player_id, card_id, action, actor, actor_uid)
  values (v_player.room_code, p_player_id, v_card_id, 'draw', 'player', v_caller_uid);

  return jsonb_build_object(
    'held_card_id', v_held_id,
    'card_id', v_card.id,
    'title', v_card.title,
    'image_path', v_card.image_path,
    'kind', v_card.kind,
    'pool', v_pool,
    'ephemeral', v_is_event,
    'source', 'draw',
    'acquired_at', now()
  );
end;
$$;

-- 6. Closing a window fulfils each outstanding permission from its own pool
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
  v_pool text;
  v_kinds text[];
  v_is_event boolean;
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
      select pa.id as pending_id, pa.player_id, pa.pool
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
      v_pool := coalesce(v_pending.pool, 'mixed');
      v_kinds := pool_kinds(v_pool);
      v_is_event := v_pool = 'event';

      -- Check hand limit (an event card never reaches the hand)
      if v_hand_limit is not null and not v_is_event then
        select count(*) into v_hand_count from held_cards where player_id = v_pending.player_id;
        if v_hand_count >= v_hand_limit then
          -- Skip draw due to hand limit, revoke permission
          update pending_actions set revoked_at = now() where id = v_pending.pending_id;
          continue;
        end if;
      end if;

      -- Select card from this permission's pool
      select c.id into v_card_id
      from cards c
      where c.active
        and c.kind = any (v_kinds)
        and (v_is_event or not v_no_dupes
             or c.id not in (select card_id from held_cards where player_id = v_pending.player_id))
      order by -ln(random()) / c.weight
      limit 1;

      if v_card_id is null then
        select c.id into v_card_id
        from cards c
        where c.active and c.kind = any (v_kinds)
        order by -ln(random()) / c.weight
        limit 1;
      end if;

      if v_card_id is not null then
        update pending_actions set consumed_at = now() where id = v_pending.pending_id;

        if not v_is_event then
          insert into held_cards (player_id, room_code, card_id, source)
          values (v_pending.player_id, p_room_code, v_card_id, 'draw');
        end if;

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

-- 7. Host-side draws and grants respect the groups
create or replace function host_draw(p_player_id uuid, p_pool text default 'mixed')
returns jsonb
language plpgsql
security definer
as $$
declare
  v_player record;
  v_pool text := coalesce(nullif(trim(p_pool), ''), 'mixed');
  v_is_event boolean;
  v_card_id uuid;
  v_held_id uuid;
  v_card record;
  v_caller_uid uuid := auth.uid();
begin
  select * into v_player from players where id = p_player_id;
  if not is_room_host(v_player.room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  if v_pool not in ('lucky', 'cursed', 'mixed', 'event') then
    raise exception 'invalid_pool' using errcode = 'P0024';
  end if;
  v_is_event := v_pool = 'event';

  select c.id into v_card_id
  from cards c
  where c.active and c.kind = any (pool_kinds(v_pool))
  order by -ln(random()) / c.weight
  limit 1;

  if v_card_id is null then
    raise exception 'no_cards_in_pool' using errcode = 'P0022';
  end if;

  if not v_is_event then
    insert into held_cards (player_id, room_code, card_id, source)
    values (p_player_id, v_player.room_code, v_card_id, 'draw')
    returning id into v_held_id;
  end if;

  insert into command_log (room_code, player_id, card_id, action, actor, actor_uid)
  values (v_player.room_code, p_player_id, v_card_id, 'draw', 'host', v_caller_uid);

  select id, title, image_path, kind into v_card from cards where id = v_card_id;

  return jsonb_build_object(
    'held_card_id', v_held_id,
    'card_id', v_card.id,
    'title', v_card.title,
    'image_path', v_card.image_path,
    'kind', v_card.kind,
    'pool', v_pool,
    'ephemeral', v_is_event,
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
  v_kind text;
  v_held_id uuid;
  v_caller_uid uuid := auth.uid();
begin
  select * into v_player from players where id = p_player_id;
  if not is_room_host(v_player.room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  -- Events resolve at the table and are never held, so granting one would put
  -- a permanent card of a transient kind into a hand. Open an event draw
  -- window for the player instead.
  select kind into v_kind from cards where id = p_card_id;
  if v_kind = 'event' then
    raise exception 'event_card_not_grantable' using errcode = 'P0023';
  end if;

  insert into held_cards (player_id, room_code, card_id, source)
  values (p_player_id, v_player.room_code, p_card_id, 'grant')
  returning id into v_held_id;

  insert into command_log (room_code, player_id, card_id, action, actor, actor_uid)
  values (v_player.room_code, p_player_id, p_card_id, 'grant', 'host', v_caller_uid);

  return jsonb_build_object('success', true, 'held_card_id', v_held_id);
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
  v_kind text;
  v_count int := 0;
begin
  if not is_room_host(p_room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  select kind into v_kind from cards where id = p_card_id;
  if v_kind = 'event' then
    raise exception 'event_card_not_grantable' using errcode = 'P0023';
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

-- 8. Catalog management knows about groups
create or replace function set_card_kind(p_card_id uuid, p_kind text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_kind text := lower(trim(p_kind));
  v_held_count int;
begin
  -- The catalog is shared by every room, so hosting any room is the bar here,
  -- the same rule the card-image storage policies use.
  if auth.uid() is null
     or not exists (select 1 from room_hosts where auth_uid = auth.uid()) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  if v_kind not in ('lucky', 'cursed', 'event') then
    raise exception 'invalid_kind' using errcode = 'P0025';
  end if;

  -- Events are never held, so a card cannot move into that group while it
  -- sits in someone's hand. Refused rather than resolved by deleting those
  -- cards: taking cards off players mid-game is the host's call to make
  -- explicitly, with revoke, not a side effect of tidying the catalog.
  if v_kind = 'event' then
    select count(*) into v_held_count from held_cards where card_id = p_card_id;
    if v_held_count > 0 then
      raise exception 'card_in_hands' using errcode = 'P0026',
        detail = v_held_count || ' player(s) still hold this card';
    end if;
  end if;

  update cards set kind = v_kind where id = p_card_id;

  return jsonb_build_object('success', true, 'kind', v_kind);
end;
$$;

create or replace function sync_catalog(p_objects jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_obj jsonb;
  v_path text;
  v_title text;
  v_kind text;
  v_inserted int := 0;
begin
  -- Insert or update cards from storage objects
  for v_obj in select * from jsonb_array_elements(p_objects) loop
    v_path := v_obj->>'path';
    v_title := v_obj->>'title';

    -- Kind comes from the caller, or from the folder the artwork sits in
    -- ("cursed/skull.webp"), so a synced bucket lands in the right groups
    -- without a second pass over the catalog.
    v_kind := lower(trim(coalesce(v_obj->>'kind', split_part(v_path, '/', 1))));
    if v_kind not in ('lucky', 'cursed', 'event') then
      v_kind := 'lucky';
    end if;

    -- Reactivate only: a card the host reclassified by hand in the console
    -- keeps that group when the bucket is synced again.
    insert into cards (title, image_path, weight, active, kind)
    values (v_title, v_path, 1, true, v_kind)
    on conflict (image_path) do update set active = true;

    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object('success', true, 'synced', v_inserted);
end;
$$;

-- 9. Reads carry the group through to both consoles
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
  v_last_event jsonb;
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
    'kind', c.kind,
    'source', h.source,
    'acquired_at', h.acquired_at
  ) order by h.acquired_at desc), '[]'::jsonb)
  into v_hand
  from held_cards h
  join cards c on h.card_id = c.id
  where h.player_id = v_player.id;

  -- The most recent event this player drew. Event cards leave no row in
  -- held_cards, so without this a refresh mid-reveal would lose the card the
  -- player is still resolving.
  select jsonb_build_object(
    'card_id', c.id,
    'title', c.title,
    'image_path', c.image_path,
    'kind', c.kind,
    'at', l.at
  )
  into v_last_event
  from command_log l
  join cards c on l.card_id = c.id
  where l.player_id = v_player.id
    and c.kind = 'event'
    and l.action in ('draw', 'auto_draw')
  order by l.seq desc
  limit 1;

  return jsonb_build_object(
    'player', row_to_json(v_player),
    'hand', v_hand,
    'last_event', v_last_event
  );
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
  v_events jsonb;
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
    'card_kind', c.kind,
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

commit;
