-- The player screen wants to say "Success" or "Failure" explicitly, not just
-- show the outcome text and leave the reader to infer which one it was.
-- host_get_room already surfaces `outcome`; enter_room only ever computed it
-- internally to pick the right text and never returned the label itself.

begin;

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
  -- final outcome of yet. `outcome` rides along now too -- null for a fixed
  -- pick (no such distinction) or while still awaiting, 'success'/'failure'
  -- once the host has ruled, so the reveal can say which one explicitly
  -- rather than leaving the player to infer it from the text alone.
  select coalesce(jsonb_agg(jsonb_build_object(
    'delivery_id', d.id,
    'npc_event_id', d.npc_event_id,
    'title', e.title,
    'image_path', e.image_path,
    'description', s.description,
    'chosen_option_label', o.label,
    'effect', o.effect,
    'state', case when d.resolved_at is null then 'awaiting' else 'resolved' end,
    'outcome', d.outcome,
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
    'outcome', d.outcome,
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

commit;
