-- RLS Policies & Storage Configuration for Lyney

-- Enable RLS on all tables
alter table cards enable row level security;
alter table rooms enable row level security;
alter table players enable row level security;
alter table held_cards enable row level security;
alter table pending_actions enable row level security;
alter table command_log enable row level security;
alter table room_hosts enable row level security;

-- 1. Cards Table Policies
create policy "Cards readable by all authenticated users"
  on cards for select
  to authenticated, anon
  using (true);

-- 2. Rooms Table Policies (Excluding PIN visibility)
create policy "Rooms readable by authenticated and anon users"
  on rooms for select
  to authenticated, anon
  using (true);

-- 3. Players Table Policies
create policy "Players select policy"
  on players for select
  to authenticated, anon
  using (
    auth_uid = auth.uid() or
    is_room_host(room_code, auth.uid())
  );

-- 4. Held Cards Table Policies
create policy "Held cards select policy"
  on held_cards for select
  to authenticated, anon
  using (
    player_id in (select id from players where auth_uid = auth.uid()) or
    is_room_host(room_code, auth.uid())
  );

-- 5. Pending Actions Table Policies
create policy "Pending actions select policy"
  on pending_actions for select
  to authenticated, anon
  using (
    player_id in (select id from players where auth_uid = auth.uid()) or
    is_room_host(room_code, auth.uid())
  );

-- 6. Command Log Table Policies
create policy "Command log select policy"
  on command_log for select
  to authenticated, anon
  using (
    is_room_host(room_code, auth.uid()) or
    player_id in (select id from players where auth_uid = auth.uid())
  );

-- 7. Room Hosts Table Policies
create policy "Room hosts select policy"
  on room_hosts for select
  to authenticated
  using (auth_uid = auth.uid());

-- Storage Bucket Setup for card-images
insert into storage.buckets (id, name, public)
values ('card-images', 'card-images', true)
on conflict (id) do update set public = true;

-- Storage Read Policy (Public)
create policy "Card images public select"
  on storage.objects for select
  to public
  using (bucket_id = 'card-images');

-- Storage Write Policy (Hosts only)
create policy "Card images host insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'card-images' and
    exists (select 1 from room_hosts where auth_uid = auth.uid())
  );

create policy "Card images host update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'card-images' and
    exists (select 1 from room_hosts where auth_uid = auth.uid())
  );

create policy "Card images host delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'card-images' and
    exists (select 1 from room_hosts where auth_uid = auth.uid())
  );
