# Lyney — Card Draw System

<img width="2561" height="1186" alt="redacted-lyney vercel app_host" src="https://github.com/user-attachments/assets/f4b13296-07d4-4c18-becf-4b3885c60f28" />

Lyney is a high-reliability, real-time web application designed for running physical board game activities without printed cards (~100 participants, ~12 per group, ~9 concurrent rooms).

## Tech Stack
- **Database & Realtime**: Supabase (Postgres, Realtime, RLS, Storage)
- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS
- **Mutations**: `SECURITY DEFINER` Postgres RPC functions only

## Database Setup & Migrations
SQL migrations are located in the `supabase/migrations/` folder:
1. `001_initial_schema.sql` — Defines core tables (`cards`, `rooms`, `players`, `held_cards`, `pending_actions`, `command_log`, `room_hosts`) and indexes.
2. `002_rpc_functions.sql` — Implements atomic RPC functions (`enter_room`, `perform_draw`, `perform_discard`, `claim_host`, `issue_permission`, `close_window`, `host_draw`, `grant_card`, `revoke_card`, `bulk_grant`, `update_player`, `remove_player`, `restore_player`, `player_history`, `sync_catalog`, `set_card_weight`, `undo_last`).
3. `003_rls_and_storage.sql` — Configures row-level security and `card-images` storage bucket policies.

## Local Frontend Development
```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

## Connecting to Supabase
Create a `.env` or `.env.local` file in the project root:
```env
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_pub_your_publishable_key_here
```

Routes:
- `/play` — Player app (Join/Rejoin screen, live hand view, permission-gated action buttons).
- `/host` — Host dashboard (Table-grouped player management, permission controller, auto-draw window closing, catalog sync).
