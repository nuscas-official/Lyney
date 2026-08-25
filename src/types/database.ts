/** Which group a card belongs to. Events resolve at the table and are never held. */
export type CardKind = 'lucky' | 'cursed' | 'event';

/** The set of kinds a single draw permission may pull from. */
export type DrawPool = 'lucky' | 'cursed' | 'mixed' | 'event';

export interface Card {
  id: string;
  title: string;
  image_path: string;
  weight: number;
  active: boolean;
  kind: CardKind;
}

export interface Room {
  code: string;
  label: string;
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
  active: boolean;
  removed_at?: string | null;
  last_seen: string;
  created_at: string;
  /** Chosen on the join form. Null for players seated before profiles existed. */
  race?: string | null;
  codename?: string | null;
  reason?: string | null;
  /** Object name in the `avatars` bucket, or a bundled fallback path. */
  avatar_path?: string | null;
  /** Scoreboard total the host nudges via adjust_points. No floor. */
  points: number;
}

export interface HeldCard {
  held_card_id: string;
  card_id: string;
  title: string;
  image_path: string;
  kind?: CardKind;
  source: 'draw' | 'grant';
  acquired_at: string;
}

/** An event card as it comes back from a draw: shown, resolved, never held. */
export interface EventDraw {
  card_id: string;
  title: string;
  image_path: string;
  at?: string;
}

export interface PendingAction {
  id: string;
  player_id: string;
  room_code: string;
  action: 'draw' | 'discard';
  /** Null for discards; the pool to draw from otherwise. */
  pool: DrawPool | null;
  issued_by: string;
  issued_at: string;
  consumed_at?: string | null;
  revoked_at?: string | null;
}

/** Whether an option's effect is fixed (shown the instant it's picked) or
 *  judged (the host decides success vs. failure afterward, and only that one
 *  text ever reaches the player). */
export type NpcOutcomeMode = 'fixed' | 'judged';

/** One selectable choice inside a scenario, as the host's catalog sees it —
 *  every text it could resolve to, fixed or judged. Never sent to a player
 *  in this shape: a pending delivery only ever carries `{id, label}`. */
export interface NpcEventOption {
  id: string;
  scenario_id: string;
  label: string;
  outcome_mode: NpcOutcomeMode;
  /** Always set. For 'fixed' this is the whole outcome, shown the instant
   *  the option is picked. For 'judged' it's the prompt shown at that same
   *  moment ("this is a skill check") -- never the success/failure text,
   *  which is withheld until the host rules on it. */
  effect: string;
  /** Set when outcome_mode is 'judged'; null otherwise. */
  success_effect: string | null;
  /** Set when outcome_mode is 'judged'; null otherwise. */
  failure_effect: string | null;
  sort_order: number;
}

/** One of the situations that can come up for an NPC event. */
export interface NpcEventScenario {
  id: string;
  npc_event_id: string;
  description: string;
  weight: number;
  active: boolean;
  options: NpcEventOption[];
}

/** The NPC event itself, as the host's catalog sees it — every scenario and
 *  option nested underneath, image and all. Never sent to a player. */
export interface NpcEventCatalogEntry {
  id: string;
  title: string;
  image_path: string | null;
  active: boolean;
  scenarios: NpcEventScenario[];
}

/** What a player sees while a delivery is unresolved — the scenario's
 *  description and the option labels, but no effect text yet. */
export interface PendingNpcEvent {
  delivery_id: string;
  npc_event_id: string;
  title: string;
  image_path: string | null;
  scenario_id: string;
  description: string;
  options: Array<{ id: string; label: string }>;
  issued_at: string;
}

/** A delivery the player has picked an option for but hasn't seen the final
 *  outcome of yet. `effect` -- the prompt ("this is a skill check") -- is
 *  always here regardless of state; it isn't a spoiler. `outcome_effect` is
 *  the success/failure text and stays null until the host rules, which is
 *  what 'awaiting' vs. 'resolved' tracks. Once the player looks,
 *  acknowledge_npc_event drops this out of the list and it becomes the
 *  ResolvedNpcEvent recall strip below. */
export interface UnseenNpcEvent {
  delivery_id: string;
  npc_event_id: string;
  title: string;
  image_path: string | null;
  description: string;
  chosen_option_label: string;
  effect: string;
  state: 'awaiting' | 'resolved';
  outcome_effect: string | null;
  chosen_at: string;
  resolved_at: string | null;
}

/** What's left once the player has seen the outcome — kept for the recall
 *  strip after the reveal is dismissed and acknowledged. `outcome_effect` is
 *  null for a fixed pick, whose `effect` already was the whole outcome. */
export interface ResolvedNpcEvent {
  delivery_id: string;
  title: string;
  image_path: string | null;
  description: string;
  chosen_option_label: string;
  effect: string;
  outcome_effect: string | null;
  resolved_at: string;
}

/** A row in the host's room-wide NPC event feed — resolved or still pending.
 *  Both judged texts ride along for a pending judged pick so the host can
 *  read each before ruling; chosen_effect is the one the player actually
 *  gets, filled in only once that ruling (or a fixed pick) has happened. */
export interface RoomNpcDelivery {
  delivery_id: string;
  player_id: string;
  npc_event_id: string;
  title: string;
  image_path: string | null;
  description: string;
  chosen_option_label: string | null;
  /** The chosen option's prompt text, known as soon as chosen_option_label is. */
  effect: string | null;
  outcome_mode: NpcOutcomeMode | null;
  success_effect: string | null;
  failure_effect: string | null;
  outcome: 'success' | 'failure' | null;
  chosen_effect: string | null;
  issued_at: string;
  chosen_at: string | null;
  resolved_at: string | null;
  seen_at: string | null;
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
  card_kind?: CardKind | null;
}
