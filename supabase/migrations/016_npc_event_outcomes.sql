-- Judged outcomes: some options resolve to different text depending on
-- something that happens at the table (a minigame, a roll, a vote) that the
-- app has no way to see. The host is the only one who knows the result, so
-- the host is the one who picks which text the player gets -- and neither
-- text may reach the player before that pick happens, or the "wrong" one
-- spoils the other.
--
-- Every option now has an outcome_mode:
--   'fixed'  -- one effect, shown the instant the player picks it (today's
--              behaviour, unchanged).
--   'judged' -- two effects (success_effect/failure_effect), neither shown
--              until the host calls judge_npc_event. Picking a judged option
--              only records the pick; the player sees an "awaiting" state
--              with no effect text at all.
--
-- This splits what used to be one moment (pick -> see the effect) into up to
-- three: pick (chosen_at), the host's ruling (resolved_at), and the player
-- actually looking at it (seen_at, new). The first two already existed as
-- one column (resolved_at did double duty); seen_at is what lets the client
-- tell "resolved but the player hasn't opened the reveal yet" apart from
-- "already shown and dismissed", which fixed options never needed because
-- picking and revealing were the same client-side moment. A fixed option
-- still sets chosen_at/resolved_at/seen_at together, so it never appears in
-- the new "unseen" queue -- the existing instant-reveal flow is untouched.

begin;

-- 1. Options carry either a fixed effect or a judged pair, never both -- and
--    the empty side is genuinely absent (null), not blank, so a stray
--    coalesce downstream can't accidentally show half of a judged option.
alter table npc_event_options
  add column if not exists outcome_mode text not null default 'fixed',
  add column if not exists success_effect text,
  add column if not exists failure_effect text;

alter table npc_event_options
  alter column effect drop not null;

alter table npc_event_options drop constraint if exists npc_event_options_outcome_shape;
alter table npc_event_options
  add constraint npc_event_options_outcome_shape check (
    (outcome_mode = 'fixed' and effect is not null and success_effect is null and failure_effect is null)
    or
    (outcome_mode = 'judged' and effect is null and success_effect is not null and failure_effect is not null)
  );

-- 2. Deliveries grow the two extra moments a judged option needs.
alter table npc_event_deliveries
  add column if not exists chosen_at timestamptz,
  add column if not exists outcome text,
  add column if not exists seen_at timestamptz;

alter table npc_event_deliveries drop constraint if exists npc_event_deliveries_outcome_valid;
alter table npc_event_deliveries
  add constraint npc_event_deliveries_outcome_valid check (outcome in ('success', 'failure') or outcome is null);

-- 3. Saving an option now names its mode. Signature changed (three new
--    params in the middle), so the old one is dropped rather than replaced.
drop function if exists save_npc_option(uuid, uuid, text, text, int);

create or replace function save_npc_option(
  p_id uuid default null,
  p_scenario_id uuid default null,
  p_label text default null,
  p_outcome_mode text default 'fixed',
  p_effect text default null,
  p_success_effect text default null,
  p_failure_effect text default null,
  p_sort_order int default 0
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_label text := trim(coalesce(p_label, ''));
  v_mode text := lower(trim(coalesce(p_outcome_mode, 'fixed')));
  v_effect text := nullif(trim(coalesce(p_effect, '')), '');
  v_success text := nullif(trim(coalesce(p_success_effect, '')), '');
  v_failure text := nullif(trim(coalesce(p_failure_effect, '')), '');
  v_row record;
begin
  if v_caller_uid is null or not exists (select 1 from room_hosts where auth_uid = v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  if v_label = '' then
    raise exception 'npc_option_fields_required' using errcode = 'P0039';
  end if;

  if v_mode not in ('fixed', 'judged') then
    raise exception 'invalid_outcome_mode' using errcode = 'P0043';
  end if;

  -- The unused side is discarded rather than left stale: switching a option
  -- from judged back to fixed (or back again) in the editor must not leave a
  -- success_effect sitting behind a fixed effect where nothing shows it.
  if v_mode = 'fixed' then
    if v_effect is null then
      raise exception 'npc_option_fields_required' using errcode = 'P0039';
    end if;
    v_success := null;
    v_failure := null;
  else
    if v_success is null or v_failure is null then
      raise exception 'npc_option_fields_required' using errcode = 'P0039';
    end if;
    v_effect := null;
  end if;

  if p_id is null then
    if p_scenario_id is null or not exists (select 1 from npc_event_scenarios where id = p_scenario_id) then
      raise exception 'npc_event_not_found' using errcode = 'P0029';
    end if;

    insert into npc_event_options (scenario_id, label, outcome_mode, effect, success_effect, failure_effect, sort_order)
    values (p_scenario_id, v_label, v_mode, v_effect, v_success, v_failure, coalesce(p_sort_order, 0))
    returning * into v_row;
  else
    update npc_event_options
       set label = v_label,
           outcome_mode = v_mode,
           effect = v_effect,
           success_effect = v_success,
           failure_effect = v_failure,
           sort_order = coalesce(p_sort_order, 0)
     where id = p_id
    returning * into v_row;

    if v_row.id is null then
      raise exception 'npc_event_not_found' using errcode = 'P0029';
    end if;
  end if;

  return row_to_json(v_row)::jsonb;
end;
$$;

-- 4. host_get_npc_catalog carries both effects through -- this is the one
--    place a judged option's texts are meant to be readable together, since
--    it is reachable by a host only.
create or replace function host_get_npc_catalog()
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_catalog jsonb;
begin
  if v_caller_uid is null or not exists (select 1 from room_hosts where auth_uid = v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'title', e.title,
    'image_path', e.image_path,
    'active', e.active,
    'scenarios', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id,
        'npc_event_id', s.npc_event_id,
        'description', s.description,
        'weight', s.weight,
        'active', s.active,
        'options', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', o.id,
            'scenario_id', o.scenario_id,
            'label', o.label,
            'outcome_mode', o.outcome_mode,
            'effect', o.effect,
            'success_effect', o.success_effect,
            'failure_effect', o.failure_effect,
            'sort_order', o.sort_order
          ) order by o.sort_order, o.created_at), '[]'::jsonb)
          from npc_event_options o
          where o.scenario_id = s.id
        )
      ) order by s.created_at), '[]'::jsonb)
      from npc_event_scenarios s
      where s.npc_event_id = e.id
    )
  ) order by e.title), '[]'::jsonb)
  into v_catalog
  from npc_events e;

  return v_catalog;
end;
$$;

-- 5. Picking an option: a judged pick only records itself and stops there --
--    it deliberately returns no effect text, because there isn't one yet.
create or replace function resolve_npc_event(p_delivery_id uuid, p_option_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_delivery record;
  v_option record;
begin
  select * into v_delivery from npc_event_deliveries where id = p_delivery_id;
  if v_delivery.id is null then
    raise exception 'npc_event_not_found' using errcode = 'P0029';
  end if;

  -- A pick is final the moment it's made, whether or not it's judged yet --
  -- checked on chosen_option_id rather than resolved_at, since a judged pick
  -- leaves resolved_at null for a while but must still block a second pick.
  if v_delivery.chosen_option_id is not null then
    raise exception 'npc_event_already_resolved' using errcode = 'P0034';
  end if;

  select * into v_option
  from npc_event_options
  where id = p_option_id and scenario_id = v_delivery.scenario_id;

  if v_option.id is null then
    raise exception 'npc_option_invalid' using errcode = 'P0035';
  end if;

  if v_option.outcome_mode = 'judged' then
    update npc_event_deliveries
       set chosen_option_id = p_option_id,
           chosen_at = now()
     where id = p_delivery_id;

    return jsonb_build_object(
      'success', true,
      'delivery_id', p_delivery_id,
      'option_id', v_option.id,
      'label', v_option.label,
      'awaiting_host', true
    );
  end if;

  -- Fixed effect: nothing left to decide. chosen/resolved/seen all land
  -- together because the client shows the effect immediately, with no second
  -- round trip -- so a fixed pick never shows up in the "unseen" queue below.
  update npc_event_deliveries
     set chosen_option_id = p_option_id,
         chosen_at = now(),
         resolved_at = now(),
         seen_at = now()
   where id = p_delivery_id;

  return jsonb_build_object(
    'success', true,
    'delivery_id', p_delivery_id,
    'option_id', v_option.id,
    'label', v_option.label,
    'effect', v_option.effect,
    'awaiting_host', false
  );
end;
$$;

-- 6. The host's ruling on a judged pick. Re-callable on purpose: fixing a
--    misclicked Success/Failure is clicking the other button, not a separate
--    undo path. seen_at is left alone if a re-judge happens after the player
--    already looked -- rare, and the host correcting it wins.
create or replace function judge_npc_event(p_delivery_id uuid, p_outcome text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_delivery record;
  v_option record;
  v_outcome text := lower(trim(coalesce(p_outcome, '')));
  v_effect text;
begin
  select * into v_delivery from npc_event_deliveries where id = p_delivery_id;
  if v_delivery.id is null then
    raise exception 'npc_event_not_found' using errcode = 'P0029';
  end if;

  if not is_room_host(v_delivery.room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  if v_delivery.chosen_option_id is null then
    raise exception 'npc_event_not_chosen' using errcode = 'P0040';
  end if;

  select * into v_option from npc_event_options where id = v_delivery.chosen_option_id;
  if v_option.outcome_mode <> 'judged' then
    raise exception 'npc_option_not_judged' using errcode = 'P0041';
  end if;

  if v_outcome not in ('success', 'failure') then
    raise exception 'invalid_outcome' using errcode = 'P0042';
  end if;

  v_effect := case v_outcome when 'success' then v_option.success_effect else v_option.failure_effect end;

  update npc_event_deliveries
     set outcome = v_outcome,
         resolved_at = now()
   where id = p_delivery_id;

  return jsonb_build_object(
    'success', true,
    'delivery_id', p_delivery_id,
    'outcome', v_outcome,
    'label', v_option.label,
    'effect', v_effect
  );
end;
$$;

-- 7. The player marking a reveal as seen -- the only thing that drops a
--    resolved delivery out of the "unseen" queue and into last_npc_event.
create or replace function acknowledge_npc_event(p_delivery_id uuid)
returns jsonb
language plpgsql
security definer
as $$
begin
  update npc_event_deliveries
     set seen_at = now()
   where id = p_delivery_id
     and resolved_at is not null
     and seen_at is null;

  return jsonb_build_object('success', true);
end;
$$;

-- 8. Reads: enter_room grows a second queue (unseen -- chosen but not yet
--    looked at, awaiting or resolved), and last_npc_event now gates on
--    seen_at instead of resolved_at, since the two can now be far apart in
--    time for a judged pick.

create or replace function enter_room(
  p_room_code text,
  p_player_code text default null,
  p_name text default null,
  p_race text default null,
  p_codename text default null,
  p_reason text default null,
  p_avatar_path text default null
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
  v_pending_npc jsonb;
  v_unseen_npc jsonb;
  v_last_npc jsonb;
  v_caller_uid uuid := auth.uid();
begin
  select exists(select 1 from rooms where code = p_room_code) into v_room_exists;
  if not v_room_exists then
    raise exception 'room_not_found' using errcode = 'P0004';
  end if;

  if p_player_code is null or trim(p_player_code) = '' then
    if p_name is null or trim(p_name) = '' then
      raise exception 'name_required' using errcode = 'P0005';
    end if;

    if p_race is null or trim(p_race) = ''
       or p_codename is null or trim(p_codename) = ''
       or p_reason is null or trim(p_reason) = ''
       or p_avatar_path is null or trim(p_avatar_path) = '' then
      raise exception 'profile_required' using errcode = 'P0027';
    end if;

    if exists (
      select 1 from players
       where room_code = p_room_code
         and lower(name) = lower(trim(p_name))
    ) then
      raise exception 'name_taken' using errcode = 'P0018';
    end if;

    loop
      v_new_code := generate_player_code();
      exit when not exists (
        select 1 from players where room_code = p_room_code and player_code = v_new_code
      );
    end loop;

    insert into players (room_code, player_code, auth_uid, name, race, codename, reason, avatar_path)
    values (
      p_room_code, v_new_code, v_caller_uid, trim(p_name),
      trim(p_race), trim(p_codename), trim(p_reason), trim(p_avatar_path)
    )
    returning * into v_player;
  else
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

    update players
       set auth_uid = v_caller_uid,
           last_seen = now()
     where id = v_player.id
    returning * into v_player;
  end if;

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

  -- Deliveries this player hasn't picked an option for yet. Options carry no
  -- effect text yet either way, judged or fixed -- the suspense holds until
  -- they choose, same as before this migration.
  select coalesce(jsonb_agg(jsonb_build_object(
    'delivery_id', d.id,
    'npc_event_id', d.npc_event_id,
    'title', e.title,
    'image_path', e.image_path,
    'scenario_id', d.scenario_id,
    'description', s.description,
    'options', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'label', o.label
      ) order by o.sort_order, o.created_at), '[]'::jsonb)
      from npc_event_options o
      where o.scenario_id = d.scenario_id
    ),
    'issued_at', d.issued_at
  ) order by d.issued_at), '[]'::jsonb)
  into v_pending_npc
  from npc_event_deliveries d
  join npc_events e on d.npc_event_id = e.id
  join npc_event_scenarios s on d.scenario_id = s.id
  where d.player_id = v_player.id and d.chosen_option_id is null;

  -- Deliveries this player has picked an option for but hasn't seen the
  -- outcome of yet. 'awaiting' means the host hasn't judged it -- effect is
  -- null, on purpose, so no client build can leak it early. 'resolved' means
  -- it's ready to reveal; the client shows it and then calls
  -- acknowledge_npc_event to drop it out of this list for good.
  select coalesce(jsonb_agg(jsonb_build_object(
    'delivery_id', d.id,
    'npc_event_id', d.npc_event_id,
    'title', e.title,
    'image_path', e.image_path,
    'description', s.description,
    'chosen_option_label', o.label,
    'state', case when d.resolved_at is null then 'awaiting' else 'resolved' end,
    'effect', case
        when d.resolved_at is null then null
        when o.outcome_mode = 'judged' then
          case d.outcome when 'success' then o.success_effect when 'failure' then o.failure_effect else null end
        else o.effect
      end,
    'chosen_at', d.chosen_at,
    'resolved_at', d.resolved_at
  ) order by d.chosen_at), '[]'::jsonb)
  into v_unseen_npc
  from npc_event_deliveries d
  join npc_events e on d.npc_event_id = e.id
  join npc_event_scenarios s on d.scenario_id = s.id
  join npc_event_options o on d.chosen_option_id = o.id
  where d.player_id = v_player.id
    and d.chosen_option_id is not null
    and d.seen_at is null;

  select jsonb_build_object(
    'delivery_id', d.id,
    'title', e.title,
    'image_path', e.image_path,
    'description', s.description,
    'chosen_option_label', o.label,
    'chosen_effect', case
        when o.outcome_mode = 'judged' then
          case d.outcome when 'success' then o.success_effect when 'failure' then o.failure_effect else null end
        else o.effect
      end,
    'resolved_at', d.resolved_at
  )
  into v_last_npc
  from npc_event_deliveries d
  join npc_events e on d.npc_event_id = e.id
  join npc_event_scenarios s on d.scenario_id = s.id
  join npc_event_options o on d.chosen_option_id = o.id
  where d.player_id = v_player.id and d.seen_at is not null
  order by d.seen_at desc
  limit 1;

  return jsonb_build_object(
    'player', row_to_json(v_player),
    'hand', v_hand,
    'last_event', v_last_event,
    'pending_npc_events', coalesce(v_pending_npc, '[]'::jsonb),
    'unseen_npc_events', coalesce(v_unseen_npc, '[]'::jsonb),
    'last_npc_event', v_last_npc
  );
end;
$$;

-- 9. host_get_room's feed carries both judged texts and the current state,
--    so the host has what they need to rule on a pending one right there.
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
  v_npc_deliveries jsonb;
begin
  select code, label into v_room from rooms where code = v_code;

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

  select coalesce(jsonb_agg(row_to_json(c) order by c.kind, c.title), '[]'::jsonb)
  into v_cards
  from cards c
  where c.active = true;

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

  -- NPC event deliveries, recent first. success_effect/failure_effect ride
  -- along for any judged pick so the host can read both before ruling --
  -- chosen_effect is the one the player actually gets, filled in only once
  -- outcome is decided (or immediately, for a fixed option).
  select coalesce(jsonb_agg(jsonb_build_object(
    'delivery_id', d.id,
    'player_id', d.player_id,
    'npc_event_id', d.npc_event_id,
    'title', e2.title,
    'image_path', e2.image_path,
    'description', s.description,
    'chosen_option_label', o.label,
    'outcome_mode', o.outcome_mode,
    'success_effect', o.success_effect,
    'failure_effect', o.failure_effect,
    'outcome', d.outcome,
    'chosen_effect', case
        when o.outcome_mode = 'judged' then
          case d.outcome when 'success' then o.success_effect when 'failure' then o.failure_effect else null end
        else o.effect
      end,
    'issued_at', d.issued_at,
    'chosen_at', d.chosen_at,
    'resolved_at', d.resolved_at,
    'seen_at', d.seen_at
  ) order by d.issued_at desc), '[]'::jsonb)
  into v_npc_deliveries
  from (
    select * from npc_event_deliveries
    where room_code = v_code
    order by issued_at desc
    limit 30
  ) d
  join npc_events e2 on d.npc_event_id = e2.id
  join npc_event_scenarios s on d.scenario_id = s.id
  left join npc_event_options o on d.chosen_option_id = o.id;

  return jsonb_build_object(
    'room', jsonb_build_object('code', v_room.code, 'label', v_room.label),
    'players', v_players,
    'held_cards', v_held,
    'pending_actions', v_pending,
    'cards', v_cards,
    'recent_events', v_events,
    'npc_deliveries', coalesce(v_npc_deliveries, '[]'::jsonb)
  );
end;
$$;

-- 10. undo_last's npc_event_trigger case now guards on chosen_option_id
--     rather than resolved_at: a judged pick leaves resolved_at null for a
--     while it's awaiting the host, and undoing the trigger must not delete
--     out from under a player who has already picked, judged or not.
create or replace function undo_last(p_room_code text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_last record;
  v_revoked_count int := 0;
begin
  if not is_room_host(p_room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  select * into v_last
  from command_log
  where room_code = p_room_code
    and actor = 'host'
    and undone = false
    and action in ('grant', 'revoke', 'draw', 'discard', 'auto_draw',
                    'permit', 'remove_player', 'restore_player', 'adjust_points',
                    'npc_event_trigger')
  order by seq desc
  limit 1;

  if v_last.seq is null then
    raise exception 'nothing_to_undo' using errcode = 'P0015';
  end if;

  -- Reverse action
  if v_last.action = 'grant' or v_last.action = 'auto_draw' then
    delete from held_cards
    where id = (select id from held_cards where player_id = v_last.player_id and card_id = v_last.card_id order by acquired_at desc limit 1);
  elsif v_last.action = 'permit' then
    update pending_actions
       set revoked_at = now()
     where issued_log_seq = v_last.seq
       and consumed_at is null
       and revoked_at is null;
    get diagnostics v_revoked_count = row_count;
  elsif v_last.action = 'npc_event_trigger' then
    delete from npc_event_deliveries
     where issued_log_seq = v_last.seq
       and chosen_option_id is null;
    get diagnostics v_revoked_count = row_count;
  elsif v_last.action = 'remove_player' then
    update players set active = true, removed_at = null where id = v_last.player_id;
  elsif v_last.action = 'restore_player' then
    update players set active = false, removed_at = now() where id = v_last.player_id;
  elsif v_last.action = 'adjust_points' then
    update players set points = points - v_last.delta where id = v_last.player_id;
  end if;

  update command_log set undone = true where seq = v_last.seq;

  return jsonb_build_object('success', true, 'undone_seq', v_last.seq, 'action', v_last.action, 'revoked', v_revoked_count);
end;
$$;

commit;
