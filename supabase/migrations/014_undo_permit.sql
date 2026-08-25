-- undo_last could never actually undo the most common host action.
--
-- issue_permission logs a 'permit' row and close_window logs 'unpermit' and
-- 'auto_draw' rows, but undo_last's action list only ever matched
-- ('grant','revoke','draw','discard','remove_player','restore_player',
-- 'adjust_points') -- so any session whose most recent host action was
-- opening or closing a window (the two things a host does over and over)
-- had nothing eligible to undo yet, and the button surfaced the raw
-- 'nothing_to_undo' error instead of reversing the window. Draw/discard
-- windows are opened far more often than cards are granted or players
-- removed, so this was the common case, not an edge case.
--
-- Fixing this needs to know which pending_actions rows a given 'permit' call
-- created, so it can revoke exactly those and no others on undo. Nothing
-- linked pending_actions back to the command_log row that issued them, so
-- that link is added here.

alter table pending_actions
  add column if not exists issued_log_seq bigint references command_log(seq);

-- issue_permission: log the command first so its seq can be stamped onto
-- every pending_actions row it creates, then undo_last can find exactly the
-- rows this call (and no other) issued.
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
  v_log_seq bigint;
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

  insert into command_log (room_code, action, actor, actor_uid)
  values (p_room_code, 'permit', 'host', v_caller_uid)
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
    for i in 1..p_count loop
      insert into pending_actions (player_id, room_code, action, issued_by, pool, issued_log_seq)
      values (v_player.id, p_room_code, p_action, v_caller_uid, v_pool, v_log_seq);
      v_issued_count := v_issued_count + 1;
    end loop;
  end loop;

  return jsonb_build_object('success', true, 'issued_count', v_issued_count, 'pool', v_pool);
end;
$$;

-- undo_last grows two more reverse cases: 'auto_draw' undoes exactly like
-- 'draw' (drop the held card it granted), and 'permit' revokes whatever of
-- its own pending_actions are still outstanding. A permit that a player has
-- already fully acted on (nothing left with issued_log_seq = v_last.seq and
-- no consumed/revoked timestamp) simply has nothing left to revoke -- the
-- log row still gets marked undone so a second click of Undo does not land
-- on it again.
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
                    'permit', 'remove_player', 'restore_player', 'adjust_points')
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
