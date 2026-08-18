# Card Draw System — Implementation Plan

A web app for running a physical board game activity without printing cards. Players hold a hand of
cards on their phone. **A card is an image** — everything the player needs to know is drawn on it. The
host controls when actions are permitted; players perform the action themselves. The host can also
directly edit any player's hand.

**Scale:** ~100 participants, ~12 per group, ~9 concurrent rooms, one session of a few hours.
Peak write volume is under 5 operations/second. Design for clarity and recoverability, not throughput.

---

## 1. Scope

### The core interaction

Actions are **permission-gated, player-performed**. The host opens a window ("everyone at table 4 may
draw one card"); the player's Draw button becomes live; the player taps it and the card appears in
their hand. The tap matters — it preserves the moment of drawing at the table — but the host controls
pacing so every table moves through phases together.

Permissions **persist until used or revoked**; they do not expire on their own. They **stack**, so
issuing "draw" twice means the player may draw two cards.

The host retains a direct override: draw, discard, grant, or revoke on a player's behalf without
issuing a permission. This is for correcting mistakes and for players away from their phone.

### Cards are images

The backend knows almost nothing about a card: an id, a human-readable title used only by the host
dashboard, a draw weight, and a path to an image in Supabase Storage. All game text lives in the
artwork. The player app renders the image at a fixed aspect ratio and nothing else.

This makes the backend very thin, and it makes **image delivery a correctness concern rather than a
polish concern**. If an image fails to load, the player cannot read their card at all. See §6 and §8.

### In scope

- Players join a room by code, receive a **rejoin code**, and can return on any device using it.
- A player holds a **hand** of cards drawn from an infinite weighted pool. Duplicates are possible;
  nothing is ever exhausted.
- Player actions, each consuming an outstanding permission: draw one card, discard one card.
- Host dashboard: every player's hand in the room, grouped by table, live.
- Host permission control: issue permissions per player, per table, or room-wide, with visible
  progress on who has acted, and a close-window action that **auto-draws for anyone who never tapped**.
- Host direct actions: draw, discard, grant a specific card, revoke a specific card, plus bulk grants.
- Host player management: rename, reassign table, remove and restore a player, read back a rejoin code,
  and view a player's full action history including discarded cards.
- Undo for the last host action.
- Card catalog built by **syncing from the Storage bucket**, plus per-card weight editing.

### Explicitly out of scope

Do not build these unless asked:

- Accounts, passwords, email, or any PII beyond a display name.
- Chat, scoring, turn order, timers, or any game logic beyond hand contents and permissions.
- Card body text, rules text, or any player-facing text on a card. The image carries it.
- Native mobile apps. Mobile web only.
- A discard pile or discard history visible to *players*. Discarded cards vanish from the hand; only
  the host sees what was discarded.
- Multiple decks. One card catalog serves the whole event.
- Image editing, cropping, or filters in-app.
- Offline play. The app requires connectivity; it must degrade honestly, not fake it.

### Success condition

A host can run nine tables, open a draw window for all of them, watch hands populate live, spot the
three players who haven't tapped, close the window so those three are drawn for automatically, and fix
a mis-granted card — all without touching a database. A player whose phone dies can borrow another and
be back in their exact hand in under a minute. No player ever sees a card they cannot read.

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Database, realtime, auth, storage | Supabase | Postgres, Realtime, RLS, anonymous auth, Storage |
| Frontend | React + TypeScript + Vite | Two routes in one app: `/play` and `/host` |
| Styling | Tailwind | No component library needed at this size |
| Hosting | Vercel or Netlify | Static SPA |
| Mutations | Postgres RPC functions | Clients never write tables directly |

Use current stable versions of everything; do not pin to versions from memory.

**Why RPC-only writes:** every mutation carries a rule — weighted selection, permission consumption,
duplicate suppression, hand limits, host-role checks, audit logging. Putting that in `SECURITY DEFINER`
Postgres functions means it cannot be bypassed by a modified client, and both clients share one
implementation.

---

## 3. Data model

All timestamps `timestamptz default now()`.

```sql
create table cards (
  id         uuid primary key default gen_random_uuid(),
  title      text not null unique,
  image_path text not null unique,
  weight     int  not null default 1 check (weight > 0),
  active     boolean not null default true
);

create table rooms (
  code        text primary key,
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
  table_label  text,
  active       boolean not null default true,
  removed_at   timestamptz,
  last_seen    timestamptz not null default now(),
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

create index on held_cards (player_id);
create index on held_cards (room_code);
create index on players (room_code);
create index on pending_actions (player_id) where consumed_at is null and revoked_at is null;
create index on command_log (room_code, seq desc);
create index on command_log (player_id, seq desc);
```

### Model notes the implementation must respect

**`cards` has no body text.** Title exists only for the host dashboard, the audit log, alt text, and
the degraded state described in §6. It is never shown to a player under normal conditions.

**`cards.image_path` is a Storage object path, not a URL** — store `cards/shield.webp`, not a public or
signed URL. URLs change with project config and expiry; paths don't. Resolve to a URL client-side. It
is `not null` and unique: every card has exactly one image, and one image backs exactly one card.

**`held_cards` is one row per card, never a quantity.** Duplicates are expected. The host must be able
to revoke one specific copy, which a count column cannot express.

**`room_code` is denormalised onto `held_cards` and `pending_actions`** so each client can open a
single Realtime subscription filtered by room. Keep it in sync in the RPCs; do not drop it as redundant.

**`cards.weight` is the only game semantics the backend holds.** Weight 5 means five times likelier
than weight 1 — not five copies.

**`players.player_code` is the rejoin credential**, unique *within a room*. Six characters from the
alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` — no `0/O`, `1/I/L`. Generate on first join, never change
it, format for reading aloud (`K7M-4QP`). It must be typeable by a stressed person on a phone.

**`players.auth_uid` is mutable and nullable.** It points at whichever browser session currently owns
this player. Rejoining from a new device reassigns it, **revoking the old device's access** — intended,
and prevents two phones fighting over one hand.

**Players and cards are never hard-deleted.** Removal sets `active = false` (and `removed_at` for
players). Hands and log entries stay intact as a record; the rejoin code stops working. Removal is
reversible via `restore_player`.

**`pending_actions` rows are never deleted**, only stamped `consumed_at` or `revoked_at`. This is what
lets the dashboard show "9 of 12 have drawn."

---

## 4. Server API

All mutations are Postgres functions, `SECURITY DEFINER`, invoked via `supabase.rpc()`. Clients have no
direct `insert`/`update`/`delete` grant on any table. Every function resolves the caller's role from
`auth.uid()` — never trust a role passed as an argument.

### Player-callable

| Function | Behaviour |
|---|---|
| `enter_room(room_code, player_code, name, table_label)` | Single entry point. See below. |
| `perform_draw(player_id)` | Consumes one outstanding `draw` permission, selects a card by weight, applies room rules, inserts `held_cards` with `source='draw'`, logs `draw`. Returns the card. |
| `perform_discard(held_card_id)` | Consumes one outstanding `discard` permission, deletes the row, logs `discard`. |

### `enter_room` behaviour

The room code is always required. The rejoin code is optional and decides which path runs:

- **`player_code` empty** → create a new player, generate a unique code within that room, bind
  `auth_uid`. `name` is required here.
- **`player_code` given** → look it up *scoped to that room*. If it exists and the player is active,
  rebind `auth_uid` to the caller and return the player with their full hand.
- **`player_code` given but invalid, inactive, or from another room** → raise a distinct error. **Do
  not silently fall through to creating a new player** — a typo must not quietly hand someone a blank
  hand they think is a restored one.

Rate-limit failed rejoin attempts to 5 per uid per minute.

### Host-only

| Function | Behaviour |
|---|---|
| `claim_host(code, pin)` | Verifies the PIN, inserts into `room_hosts`. Rate-limit to 5 attempts per uid per minute. |
| `issue_permission(scope, action, n)` | Scope is one player, one `table_label`, or the whole room. Inserts `n` rows per **active** player in scope. |
| `close_window(scope, action, fulfil)` | Ends outstanding permissions in scope. See below. |
| `host_draw(player_id)` | Direct draw, no permission consumed. |
| `host_discard(held_card_id)` | Direct discard, no permission consumed. |
| `grant_card(player_id, card_id)` | Inserts with `source='grant'`, logs. |
| `revoke_card(held_card_id)` | Deletes the row, logs `revoke`. |
| `bulk_grant(scope, card_id)` | Grants one card to every active player in scope. |
| `update_player(player_id, name, table_label)` | Rename or reassign table. |
| `remove_player(player_id)` | Sets `active = false`, stamps `removed_at`, revokes outstanding permissions, logs. |
| `restore_player(player_id)` | Reverses removal. Their rejoin code works again. |
| `player_history(player_id)` | That player's `command_log` entries joined to card titles, newest first. Includes discards. |
| `sync_catalog(objects)` | Reconciles the card catalog against the Storage bucket. See §6. |
| `set_card_weight(card_id, weight)` | Adjusts draw weight. |
| `undo_last(room_code)` | Reverses the most recent non-undone host action in the room. |

**Removed players are excluded from every scope.** Permissions, bulk grants, and the "9 of 12"
progress denominator all count active players only.

### `close_window` and auto-fulfilment

Closing a **draw** window with `fulfil = true` (the default) performs the draw for every player with an
outstanding permission, then stamps them consumed. Log these as `auto_draw`, not `draw`, so the history
distinguishes a card the player chose to take from one the system handed them.

Closing a **discard** window never auto-fulfils, regardless of the flag. There is no non-arbitrary way
to pick which card to destroy. `fulfil = true` on a discard scope must be rejected as an error, not
silently ignored.

### Consuming a permission atomically

A double-tap must not spend one permission twice. Do the consume as a conditional update and branch on
the row count:

```sql
update pending_actions
   set consumed_at = now()
 where id = (
   select id from pending_actions
    where player_id = p and action = act
      and consumed_at is null and revoked_at is null
    order by issued_at
    limit 1
    for update skip locked)
returning id into consumed;

if consumed is null then
  raise exception 'no_permission' using errcode = 'P0001';
end if;
```

Only after this succeeds does the draw or discard happen. The client must treat `no_permission` as a
normal state, not a crash — it means the window closed or the tap was a duplicate.

### Weighted draw

```sql
select c.id into picked
from cards c
where c.active
  and (not no_dupes or c.id not in (
        select h.card_id from held_cards h where h.player_id = p))
order by -ln(random()) / c.weight
limit 1;
```

If the duplicate filter eliminates every card, retry once without the filter rather than failing — the
player should always get a card.

### RLS policies

- `players`: a caller may `select` their own row; a host of that room may `select` all rows in it.
  **`player_code` must be readable by the owning player and by hosts of that room, and by nobody else.**
- `held_cards` and `pending_actions`: same shape — own rows, or all rows in a room you host.
- `cards`: `select` for any authenticated user. `rooms`: `select` with `host_pin` excluded via a view
  or column-level grant.
- `command_log`: hosts only.
- No `insert`, `update`, or `delete` policies on any table.

**Verify RLS with a test that authenticates as player A and attempts to read player B's hand and player
code.** Both must return zero rows. This is the single most important test in the suite.

### Storage policies

Bucket `card-images`, **public read**. The catalog is not secret, and public read means images are
CDN-cached with no signing round-trip — which matters on venue wifi and matters more now that the image
*is* the card. Insert, update, and delete restricted to authenticated users holding a `room_hosts` row.

---

## 5. Room rules

`rooms.rules` is a JSONB object evaluated inside `perform_draw`, `host_draw`, and auto-fulfilment.
Implement exactly two rules, both optional and defaulting to off:

```json
{ "no_duplicates_in_hand": true, "hand_limit": 5 }
```

- `no_duplicates_in_hand` — exclude cards already in the player's hand, with the fallback above.
- `hand_limit` — reject the draw with a clear error when the hand is at the limit. The player app must
  surface this as "Discard something first", not a generic failure. **Auto-fulfilment must respect the
  limit too**, and skip rather than fail the whole batch.

Design the rules block so a third rule is an additive change to one function.

---

## 6. Client surfaces

### Card rendering

One shared component. A fixed-aspect container (**3:4 unless told otherwise** — enforce it at upload so
nothing letterboxes), the image filling it, `alt` set to the card title. No text overlay.

**The degraded state is mandatory, not optional.** Because the image carries all the rules text, a
failed load leaves the player with a blank rectangle and no way to play. When an image fails or is
still loading:

- Show a placeholder frame at the same size — never collapse the layout.
- After a failed load, show the **card title** as large text plus a tap-to-retry affordance. The title
  is the fallback that keeps the game moving.
- Retry automatically with backoff; do not require the tap.

### Player app (`/play`)

**Join screen.** One form: room code (required), rejoin code (optional), display name (required only
when the rejoin code is empty — hide or disable it once a code is entered). Make it obvious that
leaving the rejoin code blank starts fresh. An invalid code shows a specific message ("That rejoin code
isn't valid for this room") and does not proceed.

Persist the Supabase anonymous session so a refresh returns the player to their hand without typing.

**Catalog preload.** Immediately after entering, preload every active card image before showing the
hand, with a short progress indicator. This is the one moment the player is calm and stationary; do the
network work here rather than mid-game. Proceed anyway if some fail — the degraded state covers it.

**Rejoin code display.** Persistent but unobtrusive — a small chip in the header, tappable to enlarge.
This is what a player needs when their phone dies, so it must be findable while panicking and readable
across a table.

**Hand screen.** Cards as a swipeable stack or vertical list, tappable to view full-screen (the artwork
carries fine print, so a zoomed view matters). A draw button and per-card discard affordances, both
**disabled by default**. The permission state must be obvious at a glance:

- No permission: button visibly inert, with a quiet line like "Waiting for the host".
- Permission outstanding: button live and prominent. Stacked permissions show a count ("Draw ×2").
- Permission consumed: immediate feedback, button returns to inert.

Discard requires confirmation — an accidental discard is unrecoverable for the player.

**Auto-drawn cards** (from a closed window) appear with a distinct, gentle marker so a player who
looked away understands where the card came from. **Host-granted cards** arrive live, are marked as
host-given, and animate in — otherwise players believe the app glitched.

**Removed players** see a clear terminal state, not a broken screen.

**Connection indicator.** When the socket drops, say so plainly and keep the last known hand on screen
rather than blanking it.

### Host dashboard (`/host`)

**Entry.** Room code plus PIN, calls `claim_host`.

**Room view.** Collapsed cards per table label, expanding to the players at that table. Nine tables of
twelve must be scannable without endless scrolling. At the collapsed level show hand size and
permission progress per table ("9 / 12 drawn").

**Removed players stay visible, greyed out**, sorted to the bottom of their table and excluded from
counts. Their hand and history remain expandable as a record, and a restore action sits on the row.

**Permission bar.** The primary control. Scope selector (whole room / one table / one player), action
(draw / discard), count, then issue. A "close window" action that shows how many will be auto-drawn
before confirming. Progress updates live as players tap.

**Player row.** Name, table, hand as small card thumbnails with per-card revoke, rejoin code on demand,
and a history panel (`player_history`) showing draws, discards, grants, and revokes in order. Actions:
issue permission, draw for them, discard for them, grant a card, rename, reassign, remove or restore.

Card pickers throughout the dashboard should show thumbnails alongside titles — the host will recognise
the artwork faster than the name.

**Undo.** A persistent control showing the last host action in plain language ("Gave Shield to Priya"),
one tap to reverse.

**Catalog screen.** Since the images already live in the bucket, the catalog is derived from it rather
than authored by hand:

1. *Sync.* List the bucket, compare against `cards.image_path`, and show a diff — new objects to import,
   card rows whose object has vanished. Importing derives the title from the filename
   (`shield-of-faith.webp` → "Shield of faith"), which the host can edit. A vanished object deactivates
   its card rather than deleting it.
2. *Weights.* A simple table of active cards with thumbnail, title, and weight. Show each card's
   resulting draw probability as a percentage, since weights are unintuitive in isolation.
3. *Upload.* A drop target for adding images without leaving the app, writing into the same bucket and
   then re-syncing.

Sync must be idempotent and must never touch `held_cards`.

### Realtime

- Player subscribes to `held_cards` and `pending_actions` filtered `player_id=eq.<id>`.
- Host subscribes to `held_cards`, `pending_actions`, and `players` filtered `room_code=eq.<code>`.
- On reconnect, refetch full state rather than assuming the delta stream was continuous.

---

## 7. Milestones

Complete each milestone fully, including its acceptance check, before starting the next.

**M1 — Schema and functions.** Migrations for all tables, every RPC, all RLS and Storage policies, and
a seed catalog of ~12 cards with placeholder images.
*Accept:* SQL-level tests covering weighted draw distribution over 1000 samples, duplicate suppression,
hand limit rejection, host-only permission on `grant_card`, atomic single-consumption under concurrent
calls, rejection of `fulfil=true` on a discard scope, exclusion of removed players from scopes, and the
cross-player read isolation test from §4.

**M2 — Entry, preload, and hand.** Player app: combined join/rejoin form, session persistence, catalog
preload, rejoin code display, hand view with the card component and its degraded state.
*Accept:* joining returns a readable code. Clearing browser storage and rejoining with room code plus
that code on a second browser restores the exact hand, and the first browser loses access. A wrong
rejoin code shows a specific error and creates nothing. **Blocking one image URL in devtools produces
the titled fallback card, not a blank rectangle.**

**M3 — Permission loop.** `issue_permission`, `perform_draw`, `perform_discard`, player-side
enabled/disabled states.
*Accept:* a permission issued from a SQL console lights up the player's button; tapping twice rapidly
draws exactly one card; revoking disables the button live; stacked permissions show a count and can be
spent one at a time.

**M4 — Host dashboard.** Claim host, room view grouped by table, permission bar with live progress,
close-window with auto-draw, per-player grant and revoke.
*Accept:* a draw window opened for a table lights up all twelve phones in under two seconds; the
progress counter increments as players tap; closing the window draws for exactly the players who hadn't
tapped and logs those as `auto_draw`.

**M5 — Player management, history, undo.** Rename, reassign, remove, restore, rejoin-code lookup,
history panel, bulk grant, undo.
*Accept:* removing a player greys them out, disables their rejoin code, excludes them from the "of 12"
denominator, and shows a clear terminal state in their app — while their hand and history remain
readable to the host. Restoring reverses all of it. Undo of a bulk grant reverses all of it; undo of an
already-undone action is refused, not double-applied.

**M6 — Catalog and rules.** Bucket sync with diff preview, title derivation, weights table with
probability display, upload, rules toggles.
*Accept:* dropping a new image in the bucket and syncing creates a card that is immediately drawable.
Removing an object deactivates its card without breaking hands that already hold it. Changing a weight
shifts observed draw frequency.

**M7 — Resilience and deploy.** Reconnect handling, connection indicator, error states, deploy.
*Accept:* killing wifi mid-session and restoring it returns both surfaces to correct state with no
manual refresh, no lost cards, and no permissions double-spent.

---

## 8. Non-functional requirements

- **Mobile first.** The player app is used one-handed at a table. Tap targets ≥ 44px.
- **Venue wifi is bad, and the image is the card.** Preload the whole catalog at join. Resize to a max
  edge of ~1200px (the artwork carries readable text, so don't over-compress), encode WebP, target
  under 200KB. Set long cache headers; images are immutable per path. Never render a card frame without
  either the image or the titled fallback.
- **Fixed aspect ratio, enforced at upload.** Reject or letterbox-warn on mismatched images at the
  catalog screen rather than discovering it in the hand view.
- **Errors name the fix.** "Hand is full — discard a card first", not "Error 400". `no_permission` is
  an expected state and must read as "The host hasn't opened this yet", not as a failure.
- **No data retention beyond the event.** A scheduled job or documented manual step deleting rooms
  older than 24 hours, cascading to players, hands, and permissions. Cards and images persist.
- **Accessibility floor:** visible keyboard focus, sufficient contrast, no colour-only state. The
  enabled/disabled button distinction must not rely on colour alone. Every card image needs `alt` text
  set to its title, and the greyed-out removed state must carry a text label, not just opacity.
- Do not use browser `localStorage` for game state — only for the Supabase session token and a cached
  copy of the player's own rejoin code.

---

## 9. Resolve before starting

Ask rather than assume:

1. Confirm the aspect ratio. The plan assumes **3:4 portrait**; changing it is a one-line constant but
   should be settled before any image is uploaded.
2. Roughly how many card types, and are weights uniform? If every card is weight 1, the weights table
   in M6 can be deferred and the catalog screen becomes sync-only.
3. Do the images embed a title that a host would recognise, or are filenames the only handle? If
   filenames are cryptic, the host will need to rename cards after import — budget UI for it.
4. Should a player be able to see their own history (what they've discarded), or is that host-only as
   currently specified?
