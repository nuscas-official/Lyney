-- Room names are unique across the database.
--
-- The label is how a host recognises their own room -- in the login form, the
-- console header and anything printed for the table. Two rooms called
-- "CASuals 4" leave a host guessing which join code belongs to which table,
-- and the label is the only human-readable handle a room has.
--
-- create_room now rejects a taken label (P0021) and a unique index on
-- lower(label) makes the rule hold even if a future code path bypasses the
-- RPC. Comparison is case-insensitive and trimmed, so "casuals 4" and
-- "CASuals 4 " are the same name.
--
-- If the index fails with "could not create unique index", rooms already
-- share a label. Find them with:
--   select lower(trim(label)), count(*) from rooms group by 1 having count(*) > 1;
-- then rename the extras (update rooms set label = ... where code = '...')
-- before re-running. The blank-label check below fails the same way on a room
-- left unnamed by an older create_room; name it and re-run.

begin;

-- Labels default to '' at the table level, which would collide the moment two
-- rooms were created without one. create_room already rejects a blank label;
-- this stops any other writer from parking a second room on ''.
alter table rooms add constraint rooms_label_not_blank check (trim(label) <> '');

create unique index if not exists idx_rooms_label_unique
  on rooms (lower(trim(label)));

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

  -- Checked up front so the host gets a named error rather than a raw
  -- constraint violation; the insert below still catches the race.
  if exists (select 1 from rooms where lower(trim(label)) = lower(v_label)) then
    raise exception 'label_taken' using errcode = 'P0021';
  end if;

  -- The join code is generated, never chosen: hosts running one table each
  -- would otherwise collide on the obvious names, and a guessable code lets
  -- players wander into the wrong table's room.
  loop
    v_code := generate_player_code();
    exit when not exists (select 1 from rooms where code = v_code);
  end loop;

  begin
    insert into rooms (code, label, host_pin) values (v_code, v_label, trim(p_pin));
  exception when unique_violation then
    -- Either the label was taken between the check and the insert, or the
    -- generated code collided. Only the first is the host's problem.
    if exists (select 1 from rooms where lower(trim(label)) = lower(v_label)) then
      raise exception 'label_taken' using errcode = 'P0021';
    end if;
    raise;
  end;

  insert into room_hosts (room_code, auth_uid) values (v_code, v_caller_uid)
  on conflict (room_code, auth_uid) do nothing;

  return jsonb_build_object('success', true, 'room_code', v_code, 'label', v_label);
end;
$$;

commit;
