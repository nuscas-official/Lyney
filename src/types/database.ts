export interface Card {
  id: string;
  title: string;
  image_path: string;
  weight: number;
  active: boolean;
}

export interface Room {
  code: string;
  host_pin: string;
  rules: {
    no_duplicates_in_hand?: boolean;
    hand_limit?: number;
    [key: string]: unknown;
  };
  created_at: string;
}

export interface Player {
  id: string;
  room_code: string;
  player_code: string;
  auth_uid?: string | null;
  name: string;
  table_label?: string | null;
  active: boolean;
  removed_at?: string | null;
  last_seen: string;
  created_at: string;
}

export interface HeldCard {
  held_card_id: string;
  card_id: string;
  title: string;
  image_path: string;
  source: 'draw' | 'grant';
  acquired_at: string;
}

export interface PendingAction {
  id: string;
  player_id: string;
  room_code: string;
  action: 'draw' | 'discard';
  issued_by: string;
  issued_at: string;
  consumed_at?: string | null;
  revoked_at?: string | null;
}

export interface CommandLogEntry {
  seq: number;
  room_code: string;
  player_id?: string | null;
  card_id?: string | null;
  action: 'draw' | 'auto_draw' | 'discard' | 'grant' | 'revoke' | 'permit' | 'unpermit' | 'remove_player' | 'restore_player';
  actor: 'player' | 'host';
  actor_uid?: string | null;
  undone: boolean;
  at: string;
  card_title?: string | null;
}
