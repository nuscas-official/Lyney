-- Host identity is the caller's auth uid, and nothing else.
--
-- claim_host and create_room fell back to gen_random_uuid() when auth.uid()
-- was null, so a host with no session minted a fresh identity on every call.
-- The restore-session effect re-claims on each mount, so every reopened tab
-- inserted another room_hosts row for the same person.
--
-- is_room_host hid the damage: it returned true whenever the caller's uid was
-- null, or whenever the room had any host row at all, which made every
-- host-only RPC reachable by anyone holding the room code.
--
-- REQUIRES anonymous sign-ins enabled on the project (Authentication ->
-- Sign In / Providers -> Anonymous sign-ins). Without a session auth.uid() is
-- null, and after this migration a null uid can no longer host anything.

begin;

-- 1. A host is a uid present in room_hosts for that room. No escape hatches.
create or replace function is_room_host(p_room_code text, p_uid uuid)
returns boolean
language sql
security definer
stable
as $$
  select p_uid is not null and exists (
    select 1 from room_hosts
     where room_code = p_room_code
       and auth_uid = p_uid
  );
$$;

-- 2. Fabricated uids are indistinguishable from real ones, so the accumulated
--    rows cannot be sorted out -- clear them and let each host re-claim with
--    the room PIN, which is the same one-form step as a first login.
delete from room_hosts;

-- 3. No session, no host. Fail loudly instead of inventing an identity.
create or replace function claim_host(p_code text, p_pin text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_room record;
  v_code text := upper(trim(p_code));
  v_caller_uid uuid := auth.uid();
begin
  if v_caller_uid is null then
    raise exception 'auth_required' using errcode = 'P0020';
  end if;

  select * into v_room from rooms where code = v_code;
  if v_room.code is null then
    raise exception 'room_not_found' using errcode = 'P0004';
  end if;

  if v_room.host_pin <> trim(p_pin) then
    raise exception 'invalid_pin' using errcode = 'P0011';
  end if;

  insert into room_hosts (room_code, auth_uid)
  values (v_code, v_caller_uid)
  on conflict (room_code, auth_uid) do nothing;

  return jsonb_build_object('success', true, 'room_code', v_code);
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
  v_caller_uid uuid := auth.uid();
begin
  if v_caller_uid is null then
    raise exception 'auth_required' using errcode = 'P0020';
  end if;

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
  on conflict (room_code, auth_uid) do nothing;

  return jsonb_build_object('success', true, 'room_code', v_code, 'label', v_label);
end;
$$;

commit;
