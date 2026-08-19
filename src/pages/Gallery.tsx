import React, { useEffect, useMemo, useState } from 'react';
import { Images, RefreshCw, AlertCircle } from 'lucide-react';
import { supabase, isDemoMode } from '../lib/supabase';
import { CardView } from '../components/CardView';
import { Token, BoardHeading } from '../components/BoardBits';
import { Card, CardKind } from '../types/database';
import { CARD_KINDS, KIND_LABEL, KIND_TONE } from '../lib/pools';

// Same sample catalog the other screens fall back to, so the gallery has
// something to show before a Supabase project is wired up.
const DEMO_CARDS: Card[] = [
  { id: 'c1', title: 'Shield of Faith', image_path: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?auto=format&fit=crop&w=600&q=80', weight: 1, active: true, kind: 'lucky' },
  { id: 'c2', title: 'Phoenix Flame', image_path: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=600&q=80', weight: 2, active: true, kind: 'lucky' },
  { id: 'c3', title: 'Ancient Elixir', image_path: 'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?auto=format&fit=crop&w=600&q=80', weight: 1, active: true, kind: 'cursed' },
  { id: 'c4', title: 'Shadow Cloak', image_path: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=600&q=80', weight: 1, active: true, kind: 'event' },
  { id: 'c5', title: 'Sealed Relic', image_path: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=600&q=80', weight: 0, active: true, kind: 'lucky' },
];

type KindFilter = 'all' | CardKind;

/** A read-only browse of the whole card catalog — every card in the game,
    with its artwork, filterable by group. No room or host session needed:
    the `cards` table is readable by anyone, so this is just a shared look
    at what's in the deck. */
export const Gallery: React.FC = () => {
  const [cards, setCards] = useState<Card[]>(isDemoMode ? DEMO_CARDS : []);
  const [loading, setLoading] = useState(!isDemoMode);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<KindFilter>('all');

  const fetchCards = async () => {
    if (isDemoMode) return;
    setLoading(true);
    setError(null);
    const { data, error: fetchError } = await supabase
      .from('cards')
      .select('*')
      .order('kind', { ascending: true })
      .order('title', { ascending: true });

    if (fetchError) {
      setError(fetchError.message);
    } else {
      setCards(data || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchCards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => {
    const c: Record<KindFilter, number> = { all: cards.length, lucky: 0, cursed: 0, event: 0 };
    cards.forEach((card) => { c[card.kind] += 1; });
    return c;
  }, [cards]);

  const visibleCards = useMemo(
    () => (filter === 'all' ? cards : cards.filter((c) => c.kind === filter)),
    [cards, filter]
  );

  return (
    <div className="flex-1 flex flex-col">
      {/* App Header */}
      <header className="sticky top-0 z-40 path-strip border-b-[3px] border-ink-900 px-4 py-3">
        <div className="max-w-5xl w-full mx-auto flex items-center justify-between gap-3">
          <BoardHeading icon={Images} tone="cyan" title="Card gallery" subtitle="Every card in the deck, at a glance" />
          <button onClick={fetchCards} className="btn-icon shrink-0" title="Refresh" disabled={loading || isDemoMode}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} strokeWidth={2.75} />
          </button>
        </div>

        {/* Kind Filter Chips */}
        <div className="max-w-5xl w-full mx-auto flex items-center gap-2 mt-3 overflow-x-auto pb-0.5">
          <button
            onClick={() => setFilter('all')}
            className={`chip shrink-0 transition-colors ${
              filter === 'all' ? 'bg-ink-900 text-parchment-50' : 'bg-parchment-100 text-ink-700 hover:bg-parchment-200'
            }`}
          >
            All <span className="opacity-70">({counts.all})</span>
          </button>
          {CARD_KINDS.map((kind) => (
            <button
              key={kind}
              onClick={() => setFilter(kind)}
              className={`chip shrink-0 transition-colors ${
                filter === kind ? 'bg-ink-900 text-parchment-50' : 'bg-parchment-100 text-ink-700 hover:bg-parchment-200'
              }`}
            >
              <Token tone={KIND_TONE[kind]} size="xs" label={KIND_LABEL[kind].charAt(0)} />
              {KIND_LABEL[kind]} <span className="opacity-70">({counts[kind]})</span>
            </button>
          ))}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-4 sm:p-6">
        {error && (
          <div className="mb-4 p-3 slab !border-pip-red bg-pip-red/10 text-crimson-700 text-xs font-bold flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={2.75} />
            <span>Couldn't load the catalog: {error}</span>
          </div>
        )}

        {loading && cards.length === 0 ? (
          <div className="path-dashed min-h-[280px] flex flex-col items-center justify-center p-6 text-center">
            <Token tone="paper" size="lg" icon={Images} className="mb-3 opacity-70 animate-pulse" />
            <p className="text-xs font-semibold text-ink-500">Loading the catalog…</p>
          </div>
        ) : visibleCards.length === 0 ? (
          <div className="path-dashed min-h-[280px] flex flex-col items-center justify-center p-6 text-center">
            <Token tone="paper" size="lg" icon={Images} className="mb-3 opacity-70" />
            <h3 className="font-display text-base font-extrabold text-ink-700 mb-1">No cards here</h3>
            <p className="text-xs font-semibold text-ink-500 max-w-xs">
              {filter === 'all' ? 'The catalog is empty.' : `No ${KIND_LABEL[filter as CardKind].toLowerCase()} cards yet.`}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 sm:gap-5 justify-items-center">
            {visibleCards.map((card) => (
              <CardView key={card.id} title={card.title} imagePath={card.image_path} kind={card.kind} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
};
