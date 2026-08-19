-- Weight 0 means "grant only": in the catalog, never in a pool.
--
-- Some cards are meant to be earned at the table rather than drawn -- the host
-- hands them out when a condition is met, and they must never come up in a
-- random draw. Deactivating them is the wrong tool: an inactive card drops out
-- of the catalog entirely, so the host cannot grant it either.
--
-- Weight already expresses how often a card turns up, so zero is the natural
-- bottom of that scale. It is not merely a very small weight: every draw query
-- filters weight > 0 explicitly, both because -ln(random()) / 0 is a division
-- by zero and because "rare" and "unobtainable by draw" are different things.
--
-- A pool made up entirely of grant-only cards counts as empty, so opening a
-- window on it fails with no_cards_in_pool (P0022) rather than handing every
-- player a permission that cannot be spent.

begin;

-- 1. Zero is allowed; negative is still nonsense.
alter table cards drop constraint if exists cards_weight_check;

alter table cards
  add constraint cards_weight_non_negative check (weight >= 0);

-- 2. Draws skip grant-only cards. Partial index matches the draw predicate.
drop index if exists idx_cards_kind_active;
create index if not exists idx_cards_drawable on cards (kind) where active and weight > 0;

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

  -- Pick card by weight, within the pool. Weight 0 is grant-only.
  select c.id into v_card_id
  from cards c
  where c.active
    and c.weight > 0
    and c.kind = any (v_kinds)
    and (not v_no_dupes or c.id not in (select card_id from held_cards where player_id = p_player_id))
  order by -ln(random()) / c.weight
  limit 1;

  -- Fallback if no_duplicates eliminated every card in the pool
  if v_card_id is null then
    select c.id into v_card_id
    from cards c
    where c.active
      and c.weight > 0
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

      -- Select card from this permission's pool, grant-only cards excluded
      select c.id into v_card_id
      from cards c
      where c.active
        and c.weight > 0
        and c.kind = any (v_kinds)
        and (v_is_event or not v_no_dupes
             or c.id not in (select card_id from held_cards where player_id = v_pending.player_id))
      order by -ln(random()) / c.weight
      limit 1;

      if v_card_id is null then
        select c.id into v_card_id
        from cards c
        where c.active and c.weight > 0 and c.kind = any (v_kinds)
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

  -- A random draw on the host's behalf is still a draw: grant-only cards are
  -- reachable through grant_card, not through this.
  select c.id into v_card_id
  from cards c
  where c.active and c.weight > 0 and c.kind = any (pool_kinds(v_pool))
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

-- 3. A pool of nothing but grant-only cards is an empty pool
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
      select 1 from cards
       where active and weight > 0 and kind = any (pool_kinds(v_pool))
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

-- 4. Setting a weight: zero is now a legal answer, and only a host may set it.
--    The old version accepted any caller, which left the shared catalog open
--    to anyone who could reach the RPC.
create or replace function set_card_weight(p_card_id uuid, p_weight int)
returns jsonb
language plpgsql
security definer
as $$
begin
  -- Same bar as set_card_kind: the catalog is shared by every room, so hosting
  -- any room is what it takes to edit it.
  if auth.uid() is null
     or not exists (select 1 from room_hosts where auth_uid = auth.uid()) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  if p_weight is null or p_weight < 0 then
    raise exception 'invalid_weight' using errcode = 'P0014';
  end if;

  update cards set weight = p_weight where id = p_card_id;

  return jsonb_build_object('success', true, 'weight', p_weight);
end;
$$;

commit;
