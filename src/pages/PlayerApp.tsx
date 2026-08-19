import React, { useState, useEffect } from 'react';
import {
  Key, User, Layers, WifiOff, AlertTriangle, CheckCircle,
  Trash2, X, Copy, ShieldAlert, ArrowRight, Plus, Minus, LogOut, Zap,
} from 'lucide-react';
import { CardView } from '../components/CardView';
import { Token, Standee } from '../components/BoardBits';
import { supabase, isDemoMode, ensureAuthSession } from '../lib/supabase';
import { CardKind, DrawPool, EventDraw, HeldCard } from '../types/database';
import {
  DRAW_POOLS, KIND_LABEL, POOL_BUTTON, POOL_DRAW_PHRASE, POOL_KINDS, POOL_LABEL, POOL_TONE,
  normalisePool,
} from '../lib/pools';

// How stale the player's screen is allowed to get. The first is the safety net
// under a healthy socket; the second is how fast the screen catches up when
// realtime is unavailable and polling is all there is.
const HEARTBEAT_MS = 30000;
const OFFLINE_POLL_MS = 5000;

// Sample fallback cards for offline / demo mode
const DEMO_CARDS: Array<{ id: string; title: string; image_path: string; kind: CardKind }> = [
  { id: '1', title: 'Shield of Faith', image_path: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?auto=format&fit=crop&w=600&q=80', kind: 'lucky' },
  { id: '2', title: 'Phoenix Flame', image_path: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=600&q=80', kind: 'lucky' },
  { id: '3', title: 'Ancient Elixir', image_path: 'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?auto=format&fit=crop&w=600&q=80', kind: 'cursed' },
  { id: '4', title: 'Shadow Cloak', image_path: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=600&q=80', kind: 'event' }
];

export const PlayerApp: React.FC = () => {
  // Session & Player state
  const [roomCode, setRoomCode] = useState('');
  const [rejoinCodeInput, setRejoinCodeInput] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [joinedPlayer, setJoinedPlayer] = useState<{
    id: string;
    name: string;
    player_code: string;
    room_code: string;
  } | null>(null);

  // App UI state
  const [hand, setHand] = useState<HeldCard[]>([]);
  // One entry per outstanding draw, oldest first, each naming the pool the
  // host opened it from. The server consumes them in this order, so the head
  // of the queue is the pool the next tap of the draw button pulls from.
  const [pendingDrawPools, setPendingDrawPools] = useState<DrawPool[]>([]);
  const [pendingDiscardCount, setPendingDiscardCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPreloading, setIsPreloading] = useState(false);
  const [preloadProgress, setPreloadProgress] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [zoomedCard, setZoomedCard] = useState<HeldCard | null>(null);
  const [cardToDiscard, setCardToDiscard] = useState<HeldCard | null>(null);
  // Events are shown once and never held, so the reveal is their whole life on
  // this screen; lastEvent keeps the most recent one reachable after a refresh.
  const [revealedEvent, setRevealedEvent] = useState<EventDraw | null>(null);
  const [lastEvent, setLastEvent] = useState<EventDraw | null>(null);
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [isRemoved, setIsRemoved] = useState(false);
  const [copied, setCopied] = useState(false);

  const pendingDrawCount = pendingDrawPools.length;
  const nextDrawPool: DrawPool = pendingDrawPools[0] ?? 'mixed';

  // Connection monitoring
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Restore saved session from localStorage on load. Fetching is left to the
  // subscription effect below: it runs the moment joinedPlayer lands and it
  // passes the rejoin code, which this path used to drop -- enter_room then
  // read the missing code as "new player" and answered name_required.
  useEffect(() => {
    const savedSession = localStorage.getItem('lyney_player_session');
    if (!savedSession) return;
    try {
      const parsed = JSON.parse(savedSession);
      setJoinedPlayer(parsed.player);
      setRoomCode(parsed.player.room_code || '');
    } catch (err) {
      console.error('Failed to restore session:', err);
    }
  }, []);

  // Leave / Reset Room Session
  const handleLeaveRoom = () => {
    localStorage.removeItem('lyney_player_session');
    setJoinedPlayer(null);
    setHand([]);
    setRevealedEvent(null);
    setLastEvent(null);
    setErrorMsg(null);
  };

  // Fetch hand and pending actions
  const fetchPlayerData = async (playerId: string, rCode: string, pCode?: string) => {
    if (isDemoMode) {
      // Demo mock data
      setHand([
        {
          held_card_id: 'h1',
          card_id: DEMO_CARDS[0].id,
          title: DEMO_CARDS[0].title,
          image_path: DEMO_CARDS[0].image_path,
          kind: DEMO_CARDS[0].kind,
          source: 'draw',
          acquired_at: new Date().toISOString(),
        },
        {
          held_card_id: 'h2',
          card_id: DEMO_CARDS[1].id,
          title: DEMO_CARDS[1].title,
          image_path: DEMO_CARDS[1].image_path,
          kind: DEMO_CARDS[1].kind,
          source: 'grant',
          acquired_at: new Date().toISOString(),
        },
      ]);
      setPendingDrawPools(['mixed']);
      return;
    }

    const code = pCode || joinedPlayer?.player_code;
    if (!code) {
      // enter_room reads an absent player code as "create a new player", so a
      // plain refresh of the hand must never be one missing argument away from
      // signing the same person up twice under a name it does not have.
      setErrorMsg('Lost track of your rejoin code. Please rejoin with it.');
      return;
    }

    try {
      const { data, error } = await supabase.rpc('enter_room', {
        p_room_code: rCode,
        p_player_code: code,
      });

      if (error) {
        if (error.code === 'P0006' || error.message.includes('player_removed')) {
          setIsRemoved(true);
        } else if (error.code === 'P0004' || error.code === 'P0003' || error.message.includes('room_not_found')) {
          // Room or player code invalid/deleted: wipe stale local session
          handleLeaveRoom();
          setErrorMsg('The room or session no longer exists. Please enter a valid room code.');
        } else {
          setErrorMsg(error.message);
        }
        return;
      }

      if (data?.hand) {
        setHand(data.hand);
      }
      setLastEvent(data?.last_event ?? null);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error fetching player data');
    }
  };

  // Fetch pending actions count for player
  const fetchPendingActions = async (playerId: string) => {
    if (isDemoMode) return;
    try {
      const { data } = await supabase
        .from('pending_actions')
        .select('*')
        .eq('player_id', playerId)
        .is('consumed_at', null)
        .is('revoked_at', null);

      if (data) {
        const draws = data
          .filter((a) => a.action === 'draw')
          .sort((a, b) => new Date(a.issued_at).getTime() - new Date(b.issued_at).getTime())
          .map((a) => normalisePool(a.pool));
        setPendingDrawPools(draws);
        setPendingDiscardCount(data.filter((a) => a.action === 'discard').length);
      }
    } catch (err) {
      console.error('Error fetching pending actions:', err);
    }
  };

  // Realtime Subscription for Player
  //
  // The player never acts on their own screen except to draw and discard, so
  // everything else they see -- a granted card, an opened window, an event the
  // host drew for them -- arrives from the host's device. Reloading to find
  // out is not a workaround on this screen: a reload that outlives the saved
  // session costs them their rejoin code.
  useEffect(() => {
    if (isDemoMode || !joinedPlayer) return;

    const { id, room_code, player_code } = joinedPlayer;
    let cancelled = false;
    let lastSync = 0;
    let socketHealthy = false;

    const refresh = () => {
      if (cancelled) return;
      lastSync = Date.now();
      fetchPlayerData(id, room_code, player_code);
      fetchPendingActions(id);
    };

    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      // A restored session reaches this effect without having signed in this
      // page load. Every RLS policy on the player's own rows keys off
      // auth.uid(), so without this the reads come back empty and realtime
      // has nothing it is allowed to deliver.
      try {
        await ensureAuthSession();
      } catch (err: any) {
        if (!cancelled) setErrorMsg(err.message || 'Could not start a session.');
        return;
      }
      if (cancelled) return;

      refresh();

      channel = supabase
        .channel(`player_realtime_${id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'held_cards', filter: `player_id=eq.${id}` }, refresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pending_actions', filter: `player_id=eq.${id}` }, refresh)
        // Event cards leave no row in held_cards, so an event the host draws
        // for this player shows up nowhere else.
        .on('postgres_changes', { event: '*', schema: 'public', table: 'command_log', filter: `player_id=eq.${id}` }, refresh)
        .subscribe((status) => {
          const wasHealthy = socketHealthy;
          socketHealthy = status === 'SUBSCRIBED';
          // Catch up on whatever landed while the socket was down.
          if (socketHealthy && !wasHealthy) refresh();
        });
    })();

    // Realtime is the fast path, not the only one. Phones suspend WebSockets
    // when the screen locks and mid-game reconnects are silent, so poll as a
    // floor: briskly while the socket is down, rarely while it is up.
    const tick = window.setInterval(() => {
      const due = socketHealthy ? HEARTBEAT_MS : OFFLINE_POLL_MS;
      if (Date.now() - lastSync >= due) refresh();
    }, 2000);

    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', refresh);

    return () => {
      cancelled = true;
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', refresh);
      if (channel) supabase.removeChannel(channel);
    };
  }, [joinedPlayer]);

  // Preload catalog images
  const runPreload = async () => {
    setIsPreloading(true);
    setPreloadProgress(10);
    const imagesToLoad = DEMO_CARDS.map((c) => c.image_path);
    let loaded = 0;

    await Promise.all(
      imagesToLoad.map(
        (url) =>
          new Promise((resolve) => {
            const img = new Image();
            img.src = url;
            img.onload = img.onerror = () => {
              loaded += 1;
              setPreloadProgress(Math.round((loaded / imagesToLoad.length) * 100));
              resolve(true);
            };
          })
      )
    );

    setIsPreloading(false);
  };

  // Join or Rejoin Room submit
  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const cleanRoom = roomCode.trim().toUpperCase();
    const cleanRejoin = rejoinCodeInput.trim().toUpperCase();

    if (!cleanRoom) {
      setErrorMsg('Please enter the join code for your table.');
      return;
    }

    if (!cleanRejoin && !playerName.trim()) {
      setErrorMsg('Display name is required for new players.');
      return;
    }

    if (isDemoMode) {
      // Mock validation logic
      if (cleanRejoin && cleanRejoin !== 'K7M4QP' && cleanRejoin !== 'K7M-4QP' && cleanRejoin !== 'DEMO12') {
        setErrorMsg("That rejoin code isn't valid for this room.");
        return;
      }

      const playerObj = {
        id: 'p-100',
        name: playerName || 'Player One',
        player_code: cleanRejoin || 'K7M4QP',
        room_code: cleanRoom,
      };

      setJoinedPlayer(playerObj);
      localStorage.setItem('lyney_player_session', JSON.stringify({ player: playerObj }));
      runPreload();
      return;
    }

    // Real Supabase join RPC call
    try {
      await ensureAuthSession();

      const { data, error } = await supabase.rpc('enter_room', {
        p_room_code: cleanRoom,
        p_player_code: cleanRejoin || null,
        p_name: playerName.trim() || null,
      });

      if (error) {
        if (error.code === 'P0003') {
          setErrorMsg("That rejoin code isn't valid for this room.");
        } else if (error.code === 'P0018' || error.message.includes('name_taken')) {
          setErrorMsg('Someone in this room is already using that name. Please pick another one.');
        } else {
          setErrorMsg(error.message);
        }
        return;
      }

      const pData = data.player;
      setJoinedPlayer(pData);
      setHand(data.hand || []);
      setLastEvent(data.last_event ?? null);
      localStorage.setItem('lyney_player_session', JSON.stringify({ player: pData }));
      runPreload();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to enter room.');
    }
  };

  // Perform Draw Action
  const handleDraw = async () => {
    if (pendingDrawCount <= 0 && !isDemoMode) return;

    if (isDemoMode) {
      const poolCards = DEMO_CARDS.filter((c) => POOL_KINDS[nextDrawPool].includes(c.kind));
      if (poolCards.length === 0) return;
      const randomCard = poolCards[Math.floor(Math.random() * poolCards.length)];
      setPendingDrawPools((prev) => prev.slice(1));

      if (randomCard.kind === 'event') {
        const event: EventDraw = {
          card_id: randomCard.id,
          title: randomCard.title,
          image_path: randomCard.image_path,
          at: new Date().toISOString(),
        };
        setRevealedEvent(event);
        setLastEvent(event);
        return;
      }

      const newCard: HeldCard = {
        held_card_id: 'h-' + Date.now(),
        card_id: randomCard.id,
        title: randomCard.title,
        image_path: randomCard.image_path,
        kind: randomCard.kind,
        source: 'draw',
        acquired_at: new Date().toISOString(),
      };
      setHand((prev) => [newCard, ...prev]);
      return;
    }

    try {
      const { data, error } = await supabase.rpc('perform_draw', {
        p_player_id: joinedPlayer?.id,
      });

      if (error) {
        if (error.code === 'P0001') {
          setErrorMsg('Permission expired or window closed by host.');
          setPendingDrawPools([]);
        } else if (error.code === 'P0008') {
          setErrorMsg('Hand is full — discard a card first.');
        } else if (error.code === 'P0022' || error.message.includes('no_cards_in_pool')) {
          setErrorMsg('That pool has no cards right now — your host needs to fix the deck.');
        } else {
          setErrorMsg(error.message);
        }
        return;
      }

      if (data) {
        setPendingDrawPools((prev) => prev.slice(1));

        // An event card is revealed once and resolved at the table; it is
        // never part of the hand, so it deliberately goes nowhere near it.
        if (data.ephemeral) {
          const event: EventDraw = {
            card_id: data.card_id,
            title: data.title,
            image_path: data.image_path,
            at: data.acquired_at,
          };
          setRevealedEvent(event);
          setLastEvent(event);
        } else {
          setHand((prev) => [data, ...prev]);
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Draw action failed');
    }
  };

  // Perform Discard Action
  const confirmDiscard = async () => {
    if (!cardToDiscard) return;

    if (isDemoMode) {
      setHand((prev) => prev.filter((c) => c.held_card_id !== cardToDiscard.held_card_id));
      setCardToDiscard(null);
      setPendingDiscardCount((prev) => Math.max(0, prev - 1));
      return;
    }

    try {
      const { error } = await supabase.rpc('perform_discard', {
        p_held_card_id: cardToDiscard.held_card_id,
      });

      if (error) {
        setErrorMsg(error.message);
      } else {
        setHand((prev) => prev.filter((c) => c.held_card_id !== cardToDiscard.held_card_id));
        setPendingDiscardCount((prev) => Math.max(0, prev - 1));
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Discard action failed');
    } finally {
      setCardToDiscard(null);
    }
  };

  const copyRejoinCode = () => {
    if (joinedPlayer) {
      navigator.clipboard.writeText(joinedPlayer.player_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Render Removed State Screen
  if (isRemoved) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <div className="panel taped max-w-sm w-full p-8 pt-9">
          <Token tone="red" size="lg" icon={ShieldAlert} className="mx-auto mb-4" />
          <h2 className="font-display text-2xl font-extrabold text-ink-800 mb-2">Off the board</h2>
          <p className="text-sm font-semibold text-ink-500 mb-6">
            Your host removed you from this room. Have a word with your table host to be put back on.
          </p>
          <button
            onClick={() => {
              localStorage.removeItem('lyney_player_session');
              setIsRemoved(false);
              setJoinedPlayer(null);
            }}
            className="btn-paper w-full text-sm"
          >
            Back to the start tile
          </button>
        </div>
      </div>
    );
  }

  // 1. JOIN SCREEN
  if (!joinedPlayer) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 py-10">
        {/* Header branding — the "START!!!!" sign of the board */}
        <div className="text-center mb-7">
          <Token tone="crimson" size="lg" imageSrc="/images/lyney.webp" className="mx-auto mb-3 animate-bob" />
          <h1 className="board-sign text-5xl leading-none -rotate-2 mb-2">Lyney</h1>
          <p className="font-display font-bold text-xs tracking-[0.18em] text-board-800">
            Card companion · NUSCASuals
          </p>
        </div>

        {/* Join Card Form */}
        <div className="w-full max-w-md panel taped p-6 sm:p-7 pt-8">
          <h2 className="font-display text-2xl font-extrabold text-ink-800 mb-1">Take your seat</h2>
          <p className="text-xs font-semibold text-ink-500 mb-5">
            Enter your table's join code to see your live hand.
          </p>

          {errorMsg && (
            <div className="mb-5 p-3 slab !border-pip-red bg-pip-red/10 text-crimson-700 text-xs font-bold flex items-center gap-2.5 animate-shake">
              <Token tone="gold" size="xs" icon={AlertTriangle} />
              <span>{errorMsg}</span>
            </div>
          )}

          <form onSubmit={handleJoin} className="space-y-4" autoComplete="off">
            <div>
              <label className="field-label">
                Join code <span className="text-pip-red">*</span>
              </label>
              <input
                type="text"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                placeholder="e.g. 9X2B7L"
                className="field uppercase"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="characters"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                required
              />
            </div>

            <div>
              <label className="field-label">
                Rejoin code{' '}
                <span className="normal-case tracking-normal text-ink-400 font-semibold">
                  (returning players)
                </span>
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={rejoinCodeInput}
                  onChange={(e) => setRejoinCodeInput(e.target.value.toUpperCase())}
                  placeholder="e.g. K7M4QP"
                  className="field uppercase pr-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                />
                <Key className="w-4 h-4 text-ink-400 absolute right-4 top-4" strokeWidth={2.75} />
              </div>
            </div>

            {/* Display name field: required only when rejoin code is empty */}
            {!rejoinCodeInput.trim() && (
              <div>
                <label className="field-label">
                  Your name <span className="text-pip-red">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={playerName}
                    onChange={(e) => setPlayerName(e.target.value)}
                    placeholder="e.g. Anikun NUSCAS"
                    className="field pr-11"
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    required
                  />
                  <User className="w-4 h-4 text-ink-400 absolute right-4 top-4" strokeWidth={2.75} />
                </div>
              </div>
            )}

            <button type="submit" className="btn-crimson w-full !py-4 text-base mt-1">
              Enter room <ArrowRight className="w-4 h-4" strokeWidth={3} />
            </button>
          </form>
        </div>
      </div>
    );
  }

  // 2. MAIN PLAYER HAND VIEW
  return (
    <div className="flex-1 flex flex-col pb-28">
      {/* Offline Status Banner */}
      {!isOnline && (
        <div className="bg-pip-gold border-b-[3px] border-ink-900 px-4 py-2 font-display font-extrabold text-xs text-ink-900 flex items-center justify-center gap-2 text-center sticky top-0 z-50">
          <WifiOff className="w-4 h-4 shrink-0" strokeWidth={2.75} />
          <span>Offline — showing your last known hand.</span>
        </div>
      )}

      {/* Catalog Preloader Banner */}
      {isPreloading && (
        <div className="path-strip border-b-[3px] border-ink-900 px-4 py-2 text-xs font-display font-bold text-ink-700 flex items-center justify-between gap-3">
          <span>Laying out the deck…</span>
          <div className="w-28 h-2.5 bg-white border-2 border-ink-900 rounded-full overflow-hidden">
            <div
              className="bg-pip-cyan h-full transition-all duration-200"
              style={{ width: `${preloadProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* App Header */}
      <header className="sticky top-0 z-40 path-strip border-b-[3px] border-ink-900 px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Standee name={joinedPlayer.name} size="md" />
          <div className="min-w-0">
            <h2 className="font-display text-base font-extrabold text-ink-800 leading-tight truncate">
              {joinedPlayer.name}
            </h2>
            <p className="text-[11px] code-stamp">{joinedPlayer.room_code}</p>
          </div>
        </div>

        {/* Rejoin Code Display Chip */}
        <button
          onClick={() => setShowCodeModal(true)}
          className="btn-paper !py-2 !px-3 !text-xs shrink-0"
          title="View rejoin code"
        >
          <Key className="w-3.5 h-3.5 text-crimson-500" strokeWidth={2.75} />
          <span className="font-mono">{joinedPlayer.player_code}</span>
        </button>
      </header>

      {/* Main Content: Player Hand */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-4 sm:p-6">
        {/* Error notification */}
        {errorMsg && (
          <div className="mb-4 p-3 slab !border-pip-red bg-pip-red/10 text-crimson-700 text-xs font-bold flex items-center justify-between gap-2">
            <span>{errorMsg}</span>
            <button
              onClick={() => setErrorMsg(null)}
              className="text-crimson-600 hover:text-crimson-800 shrink-0"
            >
              <X className="w-4 h-4" strokeWidth={3} />
            </button>
          </div>
        )}

        {/* Hand Title Header */}
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <Token tone="crimson" size="md" imageSrc="/images/lyney.webp" />
            <div>
              <h1 className="font-display text-xl font-extrabold text-ink-800 leading-tight">Your hand</h1>
              <p className="text-xs font-bold text-ink-500">
                {hand.length} {hand.length === 1 ? 'card' : 'cards'} held
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {DRAW_POOLS.filter((pool) => pendingDrawPools.includes(pool)).map((pool) => (
              <Token
                key={pool}
                tone={POOL_TONE[pool]}
                size="sm"
                label={`+${pendingDrawPools.filter((p) => p === pool).length}`}
                title={`${POOL_LABEL[pool]} draws available`}
              />
            ))}
            {pendingDiscardCount > 0 && (
              <Token tone="red" size="sm" label={`−${pendingDiscardCount}`} title="Discards required" />
            )}

            {/* Quick Demo Action Trigger for testing */}
            {isDemoMode && (
              <button
                onClick={() =>
                  setPendingDrawPools((prev) => [...prev, DRAW_POOLS[prev.length % DRAW_POOLS.length]])
                }
                className="btn-icon"
                title="Demo: queue a draw (cycles through the pools)"
              >
                <Plus className="w-4 h-4" strokeWidth={3} />
              </button>
            )}
          </div>
        </div>

        {/* The last event drawn. It never entered the hand, so this strip is
            the only way back to it after the reveal is dismissed. */}
        {lastEvent && (
          <button
            onClick={() => setRevealedEvent(lastEvent)}
            className="slab w-full mb-4 px-3 py-2.5 flex items-center gap-2.5 text-left"
          >
            <Token tone="violet" size="sm" icon={Zap} />
            <span className="min-w-0">
              <span className="block font-display font-extrabold text-xs text-ink-800 truncate">
                Latest event: {lastEvent.title}
              </span>
              <span className="block text-[11px] font-semibold text-ink-500">
                Resolved at the table, not held — tap to look again
              </span>
            </span>
          </button>
        )}

        {/* Hand Cards Grid / Stack */}
        {hand.length === 0 ? (
          <div className="path-dashed min-h-[280px] flex flex-col items-center justify-center p-6 text-center">
            <Token tone="paper" size="lg" icon={Layers} className="mb-3 opacity-70" />
            <h3 className="font-display text-base font-extrabold text-ink-700 mb-1">No cards yet</h3>
            <p className="text-xs font-semibold text-ink-500 max-w-xs">
              When your host opens a draw window, the big button below lights up.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 sm:gap-5 justify-items-center">
            {hand.map((card) => (
              <CardView
                key={card.held_card_id}
                title={card.title}
                imagePath={card.image_path}
                kind={card.kind}
                source={card.source}
                canDiscard={pendingDiscardCount > 0 || isDemoMode}
                onDiscard={() => setCardToDiscard(card)}
                onZoom={() => setZoomedCard(card)}
              />
            ))}
          </div>
        )}
      </main>

      {/* Floating Bottom Action Bar (Permission-gated Player Action) */}
      <footer className="fixed bottom-0 inset-x-0 path-strip border-t-[3px] border-ink-900 p-3 pb-4 z-40">
        <div className="max-w-md mx-auto">
          {pendingDrawCount > 0 ? (
            <button
              onClick={handleDraw}
              className={`${POOL_BUTTON[nextDrawPool]} w-full !py-4 text-lg animate-bob`}
            >
              <Token
                tone="gold"
                size="sm"
                label={nextDrawPool === 'event' ? '!' : '+'}
                className="!ring-2"
              />
              <span>
                {POOL_DRAW_PHRASE[nextDrawPool]}
                {pendingDrawCount > 1 ? ` (${pendingDrawCount} queued)` : ''}
              </span>
            </button>
          ) : (
            <div className="slab w-full py-3.5 px-4 text-center flex items-center justify-center gap-2 font-display font-bold text-sm text-ink-500">
              <span className="w-2.5 h-2.5 rounded-full bg-pip-gold border-2 border-ink-900 animate-pulse" />
              <span>Waiting for your host…</span>
            </div>
          )}
        </div>
      </footer>

      {/* Rejoin Code Modal */}
      {showCodeModal && (
        <div className="board-scrim">
          <div className="panel max-w-xs w-full p-6 text-center animate-pop">
            <button
              onClick={() => setShowCodeModal(false)}
              className="btn-icon !w-8 !h-8 absolute top-3 right-3"
            >
              <X className="w-4 h-4" strokeWidth={3} />
            </button>

            <Token tone="gold" size="lg" icon={Key} className="mx-auto mb-3" />

            <h3 className="font-display text-lg font-extrabold text-ink-800 mb-1">Your rejoin code</h3>
            <p className="text-xs font-semibold text-ink-500 mb-4">
              Keep this. It restores your hand on any device if your battery dies.
            </p>

            <div className="slab p-4 mb-4 code-stamp text-2xl select-all">
              {joinedPlayer.player_code}
            </div>

            <button onClick={copyRejoinCode} className="btn-paper w-full !py-2.5 !text-xs mb-2">
              {copied ? (
                <>
                  <CheckCircle className="w-4 h-4 text-pip-leaf" strokeWidth={2.75} /> Copied!
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" strokeWidth={2.75} /> Copy code
                </>
              )}
            </button>

            <button
              onClick={() => {
                setShowCodeModal(false);
                handleLeaveRoom();
              }}
              className="w-full py-2 font-display font-bold text-xs text-crimson-600 hover:text-crimson-800 inline-flex items-center justify-center gap-1.5"
            >
              <LogOut className="w-3.5 h-3.5" strokeWidth={2.75} /> Leave this room
            </button>
          </div>
        </div>
      )}

      {/* Card Zoom Modal */}
      {zoomedCard && (
        <div className="board-scrim" onClick={() => setZoomedCard(null)}>
          <div
            className="relative max-w-sm w-full flex flex-col items-center animate-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setZoomedCard(null)}
              className="btn-paper !py-1.5 !px-3 !text-xs absolute -top-12 right-0"
            >
              Close <X className="w-4 h-4" strokeWidth={3} />
            </button>
            <CardView
              title={zoomedCard.title}
              imagePath={zoomedCard.image_path}
              kind={zoomedCard.kind}
              source={zoomedCard.source}
              className="w-full max-w-[340px]"
            />
          </div>
        </div>
      )}

      {/* Event Reveal — shown once, kept by nobody */}
      {revealedEvent && (
        <div className="board-scrim">
          <div className="relative max-w-sm w-full flex flex-col items-center animate-pop">
            <div className="chip bg-pip-violet text-white mb-3">
              <Zap className="w-3.5 h-3.5" strokeWidth={2.75} /> {KIND_LABEL.event} card
            </div>

            <CardView
              title={revealedEvent.title}
              imagePath={revealedEvent.image_path}
              kind="event"
              className="w-full max-w-[340px]"
            />

            <p className="text-[11px] font-semibold text-parchment-50 text-center mt-3 mb-3 max-w-[300px]">
              Show this to your table and resolve it now. Event cards are not kept, so it
              will not appear in your hand.
            </p>

            <button
              onClick={() => setRevealedEvent(null)}
              className="btn-violet w-full max-w-[340px] !py-3 !text-sm"
            >
              Resolved
            </button>
          </div>
        </div>
      )}

      {/* Discard Confirmation Modal */}
      {cardToDiscard && (
        <div className="board-scrim">
          <div className="panel max-w-xs w-full p-6 text-center animate-pop">
            <Token tone="red" size="lg" icon={Trash2} className="mx-auto mb-3" />
            <h3 className="font-display text-lg font-extrabold text-ink-800 mb-1">Discard this card?</h3>
            <p className="text-xs font-semibold text-ink-500 mb-5">
              <strong className="text-ink-800">{cardToDiscard.title}</strong> leaves your hand for good —
              only your host can put it back.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setCardToDiscard(null)} className="btn-paper flex-1 !py-2.5 !text-xs">
                Keep it
              </button>
              <button onClick={confirmDiscard} className="btn-danger flex-1 !py-2.5 !text-xs">
                <Minus className="w-3.5 h-3.5" strokeWidth={3} /> Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
