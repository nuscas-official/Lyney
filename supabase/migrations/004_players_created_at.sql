-- Fix: host_get_room selects and orders by players.created_at, which never
-- existed in 001_initial_schema.sql. The RPC failed with 42703 and the host
-- console rendered an empty roster for every room.
--
-- Existing rows fall back to last_seen so join order is preserved as closely
-- as the data allows, rather than collapsing every player onto the same now().

alter table players
  add column if not exists created_at timestamptz not null default now();

update players
   set created_at = last_seen
 where created_at > last_seen;
