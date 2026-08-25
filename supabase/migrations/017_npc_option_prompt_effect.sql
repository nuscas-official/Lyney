-- A judged option needs its own "what's happening" text too.
--
-- 016 made a judged option withhold everything until the host rules, but
-- that went one step too far: the player still needs to see *something* the
-- instant they pick it -- "this is a skill check", "you attempt the ritual"
-- -- distinct from the success/failure text, which stays hidden. Without it,
-- a judged option's "awaiting" screen had nothing to show but a generic
-- "your host is deciding" placeholder, and a host writing one had nowhere to
-- put the flavour that used to live in `effect` before 016 forced it to null.
--
-- `effect` goes back to being required for every option, fixed or judged.
-- For a fixed option it's still the whole outcome, unchanged. For a judged
-- option it's the prompt shown immediately -- never the success/failure text
-- itself, which still only exists in success_effect/failure_effect until
-- judge_npc_event picks one.

begin;

-- Any judged row created under 016 has effect = null; give it a
-- placeholder derived from its label so the new not-null constraint below
-- doesn't strand a row nobody can otherwise fix without SQL. A host can
-- rewrite it from the catalog editor like any other text.
update npc_event_options
   set effect = 'Waiting to see what happens with "' || label || '"...'
 where outcome_mode = 'judged' and effect is null;

alter table npc_event_options drop constraint if exists npc_event_options_outcome_shape;

alter table npc_event_options
  alter column effect set not null;

alter table npc_event_options
  add constraint npc_event_options_outcome_shape check (
    (outcome_mode = 'fixed' and success_effect is null and failure_effect is null)
    or
    (outcome_mode = 'judged' and success_effect is not null and failure_effect is not null)
  );

-- save_npc_option: effect is required either way now; only the
-- success/failure requirement still depends on the mode.
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

  -- Required for both modes now: it's what the player sees the instant they
  -- pick, fixed or judged -- for judged it's the prompt, not the outcome.
  if v_effect is null then
    raise exception 'npc_option_fields_required' using errcode = 'P0039';
  end if;

  if v_mode = 'fixed' then
    v_success := null;
    v_failure := null;
  else
    if v_success is null or v_failure is null then
      raise exception 'npc_option_fields_required' using errcode = 'P0039';
    end if;
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

-- resolve_npc_event: a judged pick now returns its prompt effect right
-- away, alongside awaiting_host -- there is still nothing of the
-- success/failure text in this response.
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
      'effect', v_option.effect,
      'awaiting_host', true
    );
  end if;

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

-- enter_room: unseen_npc_events now carries the prompt effect regardless of
-- state, plus outcome_effect (the success/failure text) which stays null
-- until resolved. last_npc_event splits the same way.
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
  -- final outcome of yet. `effect` (the prompt) is always here regardless of
  -- state -- it's not a spoiler. `outcome_effect` is the success/failure
  -- text, null until the host rules.
  select coalesce(jsonb_agg(jsonb_build_object(
    'delivery_id', d.id,
    'npc_event_id', d.npc_event_id,
    'title', e.title,
    'image_path', e.image_path,
    'description', s.description,
    'chosen_option_label', o.label,
    'effect', o.effect,
    'state', case when d.resolved_at is null then 'awaiting' else 'resolved' end,
    'outcome_effect', case d.outcome when 'success' then o.success_effect when 'failure' then o.failure_effect else null end,
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
    'effect', o.effect,
    'outcome_effect', case d.outcome when 'success' then o.success_effect when 'failure' then o.failure_effect else null end,
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

-- host_get_room's feed gains the prompt effect alongside what it already had.
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'delivery_id', d.id,
    'player_id', d.player_id,
    'npc_event_id', d.npc_event_id,
    'title', e2.title,
    'image_path', e2.image_path,
    'description', s.description,
    'chosen_option_label', o.label,
    'effect', o.effect,
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

commit;
