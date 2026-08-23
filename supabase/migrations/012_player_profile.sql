-- Players introduce themselves with a profile, not just a name.
--
-- The join screen asks new players for a race, a codename, a reason for
-- applying and a profile icon, so the host roster shows a person rather than
-- an initial on a disc. All four are chosen from fixed lists on the client --
-- the columns are plain text because the lists are flavour that will be
-- rewritten between events, and pinning them into an enum would mean a
-- migration every time somebody thinks of a funnier codename.
--
-- The columns are nullable on purpose: players seated before this migration
-- have no profile and must keep working untouched. enter_room requires the
-- full set from anyone joining from here on, but never re-asks a returning
-- player -- their rejoin code already identifies them, and the profile they
-- filled in the first time is the one the host knows them by.

alter table players
  add column if not exists race        text,
  add column if not exists codename    text,
  add column if not exists reason      text,
  add column if not exists avatar_path text;

-- Profile icons live in their own public bucket. Players only ever read from
-- it -- the set of icons on offer is whatever the host has uploaded through
-- the Supabase dashboard, so write access matches card-images: hosts only.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

-- Policies are dropped first so the migration can be re-applied against a
-- database that already has them.
drop policy if exists "Avatars public select" on storage.objects;
drop policy if exists "Avatars host insert" on storage.objects;
drop policy if exists "Avatars host update" on storage.objects;
drop policy if exists "Avatars host delete" on storage.objects;

create policy "Avatars public select"
  on storage.objects for select
  to public
  using (bucket_id = 'avatars');

create policy "Avatars host insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars' and
    exists (select 1 from room_hosts where auth_uid = auth.uid())
  );

create policy "Avatars host update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars' and
    exists (select 1 from room_hosts where auth_uid = auth.uid())
  );

create policy "Avatars host delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars' and
    exists (select 1 from room_hosts where auth_uid = auth.uid())
  );

-- enter_room grows four arguments. Postgres would treat the wider signature as
-- an overload rather than a replacement, leaving the old three-argument call
-- ambiguous, so the previous version is dropped first.
drop function if exists enter_room(text, text, text);

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

  return jsonb_build_object(
    'player', row_to_json(v_player),
    'hand', v_hand,
    'last_event', v_last_event
  );
end;
$$;

-- The roster carries the profile through, so the host sees who a player says
-- they are rather than the first letter of their name.
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
    'avatar_path', p.avatar_path
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
