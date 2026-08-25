-- NPC events: a host-triggered encounter, richer than an event card.
--
-- An event card is one title and one image, drawn and gone. An NPC event is a
-- cast character with several possible situations ("scenarios") that can come
-- up, each with a short description, a handful of player-facing options
-- (a phrase, e.g. "Accept and think seriously"), and a written effect that
-- only appears once the player picks one. The host triggers an NPC event on a
-- player or the whole room, either naming the scenario or letting it roll
-- randomly -- weighted, the same -ln(random())/weight scheme card draws use.
--
-- npc_event_deliveries is both the pending record and the history in one row:
-- created when the host triggers, stamped with a choice when the player
-- resolves. There is no permission-window step like draw/discard -- the host
-- pushes directly, the same shape as host_draw/grant_card.
--
-- Unlike the cards table, npc_events/npc_event_scenarios/npc_event_options
-- get no select policy at all: RLS enabled with zero policies is a default
-- deny, so the catalog is reachable only through the security-definer RPCs
-- below, gated the same way set_card_kind/set_card_weight gate the shared
-- card catalog. That is what keeps the catalog host-only and out of the
-- public Gallery -- players are meant to be surprised by it.

begin;

-- 1. Tables

create table npc_events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  image_path  text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table npc_event_scenarios (
  id            uuid primary key default gen_random_uuid(),
  npc_event_id  uuid not null references npc_events(id) on delete cascade,
  description   text not null,
  weight        int not null default 1 check (weight > 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create index idx_npc_scenarios_event on npc_event_scenarios (npc_event_id);

create table npc_event_options (
  id            uuid primary key default gen_random_uuid(),
  scenario_id   uuid not null references npc_event_scenarios(id) on delete cascade,
  label         text not null,
  effect        text not null,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);

create index idx_npc_options_scenario on npc_event_options (scenario_id);

-- FKs to the catalog are deliberately not cascading: a delivery is history as
-- much as it is a pending record, so deleting a catalog item that has ever
-- been sent out is blocked (see delete_npc_event/delete_npc_scenario/
-- delete_npc_option below) rather than silently erasing what happened at the
-- table. player_id/room_code do cascade, same as held_cards, so reset_room's
-- `delete from players` still clears a room's deliveries along with its hands.
create table npc_event_deliveries (
  id                uuid primary key default gen_random_uuid(),
  room_code         text not null references rooms(code) on delete cascade,
  player_id         uuid not null references players(id) on delete cascade,
  npc_event_id      uuid not null references npc_events(id),
  scenario_id       uuid not null references npc_event_scenarios(id),
  issued_by         uuid not null,
  issued_at         timestamptz not null default now(),
  issued_log_seq    bigint references command_log(seq),
  chosen_option_id  uuid references npc_event_options(id),
  resolved_at       timestamptz
);

create index idx_npc_deliveries_room on npc_event_deliveries (room_code);
create index idx_npc_deliveries_player on npc_event_deliveries (player_id);
create index idx_npc_deliveries_pending on npc_event_deliveries (player_id) where resolved_at is null;

-- 2. RLS

alter table npc_events enable row level security;
alter table npc_event_scenarios enable row level security;
alter table npc_event_options enable row level security;
alter table npc_event_deliveries enable row level security;

-- No select policy on the catalog tables: RLS enabled with no policy denies
-- everyone, including the host's own anon session. The catalog is only ever
-- read through host_get_npc_catalog, a security-definer RPC that checks
-- room_hosts itself.

create policy "Npc event deliveries select policy"
  on npc_event_deliveries for select
  to authenticated, anon
  using (
    player_id in (select id from players where auth_uid = auth.uid()) or
    is_room_host(room_code, auth.uid())
  );

-- 3. Storage: NPC portraits, same public-read/host-write shape as
--    card-images and avatars.

insert into storage.buckets (id, name, public)
values ('npc-images', 'npc-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Npc images public select" on storage.objects;
drop policy if exists "Npc images host insert" on storage.objects;
drop policy if exists "Npc images host update" on storage.objects;
drop policy if exists "Npc images host delete" on storage.objects;

create policy "Npc images public select"
  on storage.objects for select
  to public
  using (bucket_id = 'npc-images');

create policy "Npc images host insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'npc-images' and
    exists (select 1 from room_hosts where auth_uid = auth.uid())
  );

create policy "Npc images host update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'npc-images' and
    exists (select 1 from room_hosts where auth_uid = auth.uid())
  );

create policy "Npc images host delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'npc-images' and
    exists (select 1 from room_hosts where auth_uid = auth.uid())
  );

-- 4. Realtime: same publication both consoles already listen on.

alter table npc_event_deliveries replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'npc_event_deliveries'
  ) then
    execute 'alter publication supabase_realtime add table public.npc_event_deliveries';
  end if;
end;
$$;

-- 5. command_log grows one more host action, so undo_last can reverse a
--    trigger the same way it reverses 'permit'. The player's resolve is not
--    logged here -- the delivery row's resolved_at is already the record, and
--    undo_last only ever reverses actor = 'host' rows.

alter table command_log drop constraint if exists command_log_action_check;
alter table command_log
  add constraint command_log_action_check check (action in
    ('draw','auto_draw','discard','grant','revoke',
     'permit','unpermit','remove_player','restore_player','adjust_points',
     'npc_event_trigger'));

-- 6. Catalog CRUD. Same bar as set_card_kind/set_card_weight: the catalog is
--    shared by every room, so hosting any room is what it takes to edit it.

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
            'effect', o.effect,
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

create or replace function save_npc_event(
  p_id uuid default null,
  p_title text default null,
  p_image_path text default null,
  p_active boolean default true
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_title text := trim(coalesce(p_title, ''));
  v_row record;
begin
  if v_caller_uid is null or not exists (select 1 from room_hosts where auth_uid = v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  if v_title = '' then
    raise exception 'npc_title_required' using errcode = 'P0037';
  end if;

  if p_id is null then
    insert into npc_events (title, image_path, active)
    values (v_title, nullif(trim(coalesce(p_image_path, '')), ''), coalesce(p_active, true))
    returning * into v_row;
  else
    update npc_events
       set title = v_title,
           image_path = nullif(trim(coalesce(p_image_path, '')), ''),
           active = coalesce(p_active, true)
     where id = p_id
    returning * into v_row;

    if v_row.id is null then
      raise exception 'npc_event_not_found' using errcode = 'P0029';
    end if;
  end if;

  return row_to_json(v_row)::jsonb;
end;
$$;

create or replace function delete_npc_event(p_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_in_use int;
begin
  if v_caller_uid is null or not exists (select 1 from room_hosts where auth_uid = v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  select count(*) into v_in_use from npc_event_deliveries where npc_event_id = p_id;
  if v_in_use > 0 then
    raise exception 'npc_event_in_use' using errcode = 'P0030',
      detail = v_in_use || ' player(s) have already received this event';
  end if;

  delete from npc_events where id = p_id;

  return jsonb_build_object('success', true);
end;
$$;

create or replace function save_npc_scenario(
  p_id uuid default null,
  p_npc_event_id uuid default null,
  p_description text default null,
  p_weight int default 1,
  p_active boolean default true
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_description text := trim(coalesce(p_description, ''));
  v_weight int := coalesce(p_weight, 1);
  v_row record;
begin
  if v_caller_uid is null or not exists (select 1 from room_hosts where auth_uid = v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  if v_description = '' then
    raise exception 'npc_description_required' using errcode = 'P0038';
  end if;
  if v_weight <= 0 then
    raise exception 'invalid_weight' using errcode = 'P0014';
  end if;

  if p_id is null then
    if p_npc_event_id is null or not exists (select 1 from npc_events where id = p_npc_event_id) then
      raise exception 'npc_event_not_found' using errcode = 'P0029';
    end if;

    insert into npc_event_scenarios (npc_event_id, description, weight, active)
    values (p_npc_event_id, v_description, v_weight, coalesce(p_active, true))
    returning * into v_row;
  else
    update npc_event_scenarios
       set description = v_description,
           weight = v_weight,
           active = coalesce(p_active, true)
     where id = p_id
    returning * into v_row;

    if v_row.id is null then
      raise exception 'npc_event_not_found' using errcode = 'P0029';
    end if;
  end if;

  return row_to_json(v_row)::jsonb;
end;
$$;

create or replace function delete_npc_scenario(p_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_in_use int;
begin
  if v_caller_uid is null or not exists (select 1 from room_hosts where auth_uid = v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  select count(*) into v_in_use from npc_event_deliveries where scenario_id = p_id;
  if v_in_use > 0 then
    raise exception 'npc_scenario_in_use' using errcode = 'P0031',
      detail = v_in_use || ' player(s) have already received this scenario';
  end if;

  delete from npc_event_scenarios where id = p_id;

  return jsonb_build_object('success', true);
end;
$$;

create or replace function save_npc_option(
  p_id uuid default null,
  p_scenario_id uuid default null,
  p_label text default null,
  p_effect text default null,
  p_sort_order int default 0
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_label text := trim(coalesce(p_label, ''));
  v_effect text := trim(coalesce(p_effect, ''));
  v_row record;
begin
  if v_caller_uid is null or not exists (select 1 from room_hosts where auth_uid = v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  if v_label = '' or v_effect = '' then
    raise exception 'npc_option_fields_required' using errcode = 'P0039';
  end if;

  if p_id is null then
    if p_scenario_id is null or not exists (select 1 from npc_event_scenarios where id = p_scenario_id) then
      raise exception 'npc_event_not_found' using errcode = 'P0029';
    end if;

    insert into npc_event_options (scenario_id, label, effect, sort_order)
    values (p_scenario_id, v_label, v_effect, coalesce(p_sort_order, 0))
    returning * into v_row;
  else
    update npc_event_options
       set label = v_label,
           effect = v_effect,
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

create or replace function delete_npc_option(p_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_in_use int;
begin
  if v_caller_uid is null or not exists (select 1 from room_hosts where auth_uid = v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  select count(*) into v_in_use from npc_event_deliveries where chosen_option_id = p_id;
  if v_in_use > 0 then
    raise exception 'npc_option_in_use' using errcode = 'P0032',
      detail = v_in_use || ' player(s) already chose this option';
  end if;

  delete from npc_event_options where id = p_id;

  return jsonb_build_object('success', true);
end;
$$;

-- 7. Trigger: the host pushing an event at a player or the room, immediately
--    -- no permission-window step, same shape as host_draw/grant_card.

create or replace function trigger_npc_event(
  p_room_code text,
  p_scope text,  -- 'room', 'player'
  p_npc_event_id uuid,
  p_target_id uuid default null,
  p_scenario_id uuid default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_scenario_id uuid;
  v_log_seq bigint;
  v_player record;
  v_issued_count int := 0;
begin
  if not is_room_host(p_room_code, v_caller_uid) then
    raise exception 'host_unauthorized' using errcode = 'P0013';
  end if;

  if p_scenario_id is not null then
    -- A specific scenario was named: it must actually belong to this event
    -- and still be active, or the host's pick silently drew nothing.
    select id into v_scenario_id
    from npc_event_scenarios
    where id = p_scenario_id and npc_event_id = p_npc_event_id and active;
  else
    -- No scenario named: roll one, weighted the same way card draws are.
    select id into v_scenario_id
    from npc_event_scenarios
    where npc_event_id = p_npc_event_id and active
    order by -ln(random()) / weight
    limit 1;
  end if;

  if v_scenario_id is null then
    raise exception 'no_active_scenarios' using errcode = 'P0033';
  end if;

  insert into command_log (room_code, action, actor, actor_uid)
  values (p_room_code, 'npc_event_trigger', 'host', v_caller_uid)
  returning seq into v_log_seq;

  for v_player in
    select id from players
    where room_code = p_room_code
      and active = true
      and (
        p_scope = 'room' or
        (p_scope = 'player' and id = p_target_id)
      )
  loop
    insert into npc_event_deliveries
      (room_code, player_id, npc_event_id, scenario_id, issued_by, issued_log_seq)
    values
      (p_room_code, v_player.id, p_npc_event_id, v_scenario_id, v_caller_uid, v_log_seq);
    v_issued_count := v_issued_count + 1;
  end loop;

  return jsonb_build_object('success', true, 'issued_count', v_issued_count, 'scenario_id', v_scenario_id);
end;
$$;

-- 8. Resolve: the player choosing an option. No ownership check against
--    auth.uid() -- consistent with perform_draw/perform_discard, which trust
--    the id the client passes rather than cross-checking the caller's session.

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

  if v_delivery.resolved_at is not null then
    raise exception 'npc_event_already_resolved' using errcode = 'P0034';
  end if;

  select * into v_option
  from npc_event_options
  where id = p_option_id and scenario_id = v_delivery.scenario_id;

  if v_option.id is null then
    raise exception 'npc_option_invalid' using errcode = 'P0035';
  end if;

  update npc_event_deliveries
     set chosen_option_id = p_option_id,
         resolved_at = now()
   where id = p_delivery_id;

  return jsonb_build_object(
    'success', true,
    'delivery_id', p_delivery_id,
    'option_id', v_option.id,
    'label', v_option.label,
    'effect', v_option.effect
  );
end;
$$;

-- 9. Reads: enter_room and host_get_room carry NPC events through, same as
--    every other room-state field they already return.

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
  v_last_npc jsonb;
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

    -- name_required stays the first thing a nameless call hears: the join
    -- screen asks for the codes alone and probes with neither name nor
    -- profile to find out whether a room exists and whether this is somebody
    -- new, and it reads that error as "the room is real, go ask for details".
    if p_race is null or trim(p_race) = ''
       or p_codename is null or trim(p_codename) = ''
       or p_reason is null or trim(p_reason) = ''
       or p_avatar_path is null or trim(p_avatar_path) = '' then
      raise exception 'profile_required' using errcode = 'P0027';
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

    insert into players (room_code, player_code, auth_uid, name, race, codename, reason, avatar_path)
    values (
      p_room_code, v_new_code, v_caller_uid, trim(p_name),
      trim(p_race), trim(p_codename), trim(p_reason), trim(p_avatar_path)
    )
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

  -- Pending NPC event deliveries for this player, oldest first. Options carry
  -- no effect text yet -- the reveal holds that until resolve_npc_event.
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
  where d.player_id = v_player.id and d.resolved_at is null;

  -- The most recently resolved NPC event, full detail including the effect --
  -- so a refresh right after choosing doesn't lose what they just read.
  select jsonb_build_object(
    'delivery_id', d.id,
    'title', e.title,
    'image_path', e.image_path,
    'description', s.description,
    'chosen_option_label', o.label,
    'chosen_effect', o.effect,
    'resolved_at', d.resolved_at
  )
  into v_last_npc
  from npc_event_deliveries d
  join npc_events e on d.npc_event_id = e.id
  join npc_event_scenarios s on d.scenario_id = s.id
  join npc_event_options o on d.chosen_option_id = o.id
  where d.player_id = v_player.id and d.resolved_at is not null
  order by d.resolved_at desc
  limit 1;

  return jsonb_build_object(
    'player', row_to_json(v_player),
    'hand', v_hand,
    'last_event', v_last_event,
    'pending_npc_events', coalesce(v_pending_npc, '[]'::jsonb),
    'last_npc_event', v_last_npc
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
  v_npc_deliveries jsonb;
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

  -- NPC event deliveries, recent first, resolved and unresolved -- the only
  -- place the host can see who has one pending and what everyone chose.
  select coalesce(jsonb_agg(jsonb_build_object(
    'delivery_id', d.id,
    'player_id', d.player_id,
    'npc_event_id', d.npc_event_id,
    'title', e2.title,
    'image_path', e2.image_path,
    'description', s.description,
    'chosen_option_label', o.label,
    'chosen_effect', o.effect,
    'issued_at', d.issued_at,
    'resolved_at', d.resolved_at
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

-- 10. undo_last grows a reverse case for 'npc_event_trigger', mirroring
--     'permit': revoke exactly the deliveries this trigger created that
--     nobody has resolved yet.

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
       and resolved_at is null;
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
