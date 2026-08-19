import { CardKind, DrawPool } from '../types/database';
import { TokenTone } from '../components/BoardBits';

/* The shared vocabulary for card groups and draw pools, so the host console
   and the player app label and colour them identically. Mirrors pool_kinds()
   in migration 009. */

export const CARD_KINDS: CardKind[] = ['lucky', 'cursed', 'event'];

export const KIND_LABEL: Record<CardKind, string> = {
  lucky: 'Lucky',
  cursed: 'Cursed',
  event: 'Event',
};

export const KIND_TONE: Record<CardKind, TokenTone> = {
  lucky: 'leaf',
  cursed: 'red',
  event: 'violet',
};

export const DRAW_POOLS: DrawPool[] = ['lucky', 'cursed', 'mixed', 'event'];

export const POOL_LABEL: Record<DrawPool, string> = {
  lucky: 'Lucky',
  cursed: 'Cursed',
  mixed: 'Lucky + Cursed',
  event: 'Event',
};

export const POOL_KINDS: Record<DrawPool, CardKind[]> = {
  lucky: ['lucky'],
  cursed: ['cursed'],
  mixed: ['lucky', 'cursed'],
  event: ['event'],
};

export const POOL_TONE: Record<DrawPool, TokenTone> = {
  lucky: 'leaf',
  cursed: 'red',
  mixed: 'cyan',
  event: 'violet',
};

/** The board's button skin for each pool, so the draw button reads as the
    pool it will pull from before the player taps it. */
export const POOL_BUTTON: Record<DrawPool, string> = {
  lucky: 'btn-leaf',
  cursed: 'btn-danger',
  mixed: 'btn-cyan',
  event: 'btn-violet',
};

/** What the player's draw button says, with the article the pool needs. */
export const POOL_DRAW_PHRASE: Record<DrawPool, string> = {
  lucky: 'Draw a lucky card',
  cursed: 'Draw a cursed card',
  mixed: 'Draw a card',
  event: 'Draw an event card',
};

/** Kept for rooms that were mid-session when pools arrived: their permissions
    carry no pool and behave the way every draw used to. */
export function normalisePool(pool: string | null | undefined): DrawPool {
  return (DRAW_POOLS as string[]).includes(pool ?? '') ? (pool as DrawPool) : 'mixed';
}
