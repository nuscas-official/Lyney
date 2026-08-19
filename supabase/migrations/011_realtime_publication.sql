-- Realtime: publish the tables both consoles subscribe to.
--
-- Both PlayerApp and HostDashboard have listened on postgres_changes since the
-- first version, but nothing ever added these tables to the supabase_realtime
-- publication, so Postgres never sent a single row change. The subscriptions
-- connected, reported SUBSCRIBED, and then sat silent -- which is why a player
-- had to reload to see a granted card or an opened window, and reloading costs
-- them their rejoin code.
--
-- Replica identity full is not optional here. Every subscription filters on a
-- non-key column (player_id, room_code), and for UPDATE and DELETE the filter
-- is matched against the old row, which by default carries the primary key and
-- nothing else. Without this, a discard would never reach the other console.
-- The tables are small and the write rate is a few rows per turn, so the extra
-- WAL volume is not worth optimising against.

begin;

alter table players         replica identity full;
alter table held_cards      replica identity full;
alter table pending_actions replica identity full;
alter table command_log     replica identity full;

do $$
declare
  v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  -- Adding a table that is already published is an error, not a no-op, so each
  -- one is checked. This keeps the migration re-runnable on a project where
  -- some tables were switched on by hand in the dashboard.
  foreach v_table in array array['players', 'held_cards', 'pending_actions', 'command_log']
  loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end;
$$;

commit;
