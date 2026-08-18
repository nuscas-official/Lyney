-- Initial Schema Migration for Lyney Card Draw System

create table cards (
  id         uuid primary key default gen_random_uuid(),
  title      text not null unique,
  image_path text not null unique,
  weight     int  not null default 1 check (weight > 0),
  active     boolean not null default true
);

create table rooms (
  code        text primary key,
  label       text not null default '',
  host_pin    text not null,
  rules       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table players (
  id           uuid primary key default gen_random_uuid(),
  room_code    text not null references rooms(code) on delete cascade,
  player_code  text not null,
  auth_uid     uuid,
  name         text not null,
  active       boolean not null default true,
  removed_at   timestamptz,
  last_seen    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (room_code, player_code)
);

create table held_cards (
  id           uuid primary key default gen_random_uuid(),
  player_id    uuid not null references players(id) on delete cascade,
  room_code    text not null references rooms(code) on delete cascade,
  card_id      uuid not null references cards(id),
  source       text not null check (source in ('draw','grant')),
  acquired_at  timestamptz not null default now()
);

create table pending_actions (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references players(id) on delete cascade,
  room_code   text not null references rooms(code) on delete cascade,
  action      text not null check (action in ('draw','discard')),
  issued_by   uuid not null,
  issued_at   timestamptz not null default now(),
  consumed_at timestamptz,
  revoked_at  timestamptz
);

create table command_log (
  seq        bigserial primary key,
  room_code  text not null,
  player_id  uuid,
  card_id    uuid,
  action     text not null check (action in
               ('draw','auto_draw','discard','grant','revoke',
                'permit','unpermit','remove_player','restore_player')),
  actor      text not null check (actor in ('player','host')),
  actor_uid  uuid,
  undone     boolean not null default false,
  at         timestamptz not null default now()
);

create table room_hosts (
  room_code  text not null references rooms(code) on delete cascade,
  auth_uid   uuid not null,
  primary key (room_code, auth_uid)
);

-- Performance & Lookup Indexes
create index idx_held_cards_player_id on held_cards (player_id);
create index idx_held_cards_room_code on held_cards (room_code);
create index idx_players_room_code on players (room_code);
create index idx_pending_actions_active on pending_actions (player_id) where consumed_at is null and revoked_at is null;
create index idx_command_log_room_seq on command_log (room_code, seq desc);
create index idx_command_log_player_seq on command_log (player_id, seq desc);
