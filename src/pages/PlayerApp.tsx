import React, { useState, useEffect } from 'react';
import {
  Key, User, Layers, WifiOff, AlertTriangle, CheckCircle,
  Trash2, X, Copy, ShieldAlert, ArrowRight, Plus, Minus, LogOut,
} from 'lucide-react';
import { CardView } from '../components/CardView';
import { Token, Standee } from '../components/BoardBits';
import { supabase, isDemoMode, ensureAuthSession } from '../lib/supabase';
import { HeldCard } from '../types/database';

// Sample fallback cards for offline / demo mode
const DEMO_CARDS = [
  { id: '1', title: 'Shield of Faith', image_path: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?auto=format&fit=crop&w=600&q=80' },
  { id: '2', title: 'Phoenix Flame', image_path: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=600&q=80' },
  { id: '3', title: 'Ancient Elixir', image_path: 'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?auto=format&fit=crop&w=600&q=80' },
  { id: '4', title: 'Shadow Cloak', image_path: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=600&q=80' }
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
  const [pendingDrawCount, setPendingDrawCount] = useState(0);
  const [pendingDiscardCount, setPendingDiscardCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPreloading, setIsPreloading] = useState(false);
  const [preloadProgress, setPreloadProgress] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [zoomedCard, setZoomedCard] = useState<HeldCard | null>(null);
  const [cardToDiscard, setCardToDiscard] = useState<HeldCard | null>(null);
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [isRemoved, setIsRemoved] = useState(false);
  const [copied, setCopied] = useState(false);

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

  // Restore saved session from localStorage on load
  useEffect(() => {
    const savedSession = localStorage.getItem('lyney_player_session');
    if (savedSession) {
      try {
        const parsed = JSON.parse(savedSession);
        setJoinedPlayer(parsed.player);
        setRoomCode(parsed.player.room_code || '');
        fetchPlayerData(parsed.player.id, parsed.player.room_code);
      } catch (err) {
        console.error('Failed to restore session:', err);
      }
    }
  }, []);

  // Leave / Reset Room Session
  const handleLeaveRoom = () => {
    localStorage.removeItem('lyney_player_session');
    setJoinedPlayer(null);
    setHand([]);
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
          source: 'draw',
          acquired_at: new Date().toISOString(),
        },
        {
          held_card_id: 'h2',
          card_id: DEMO_CARDS[1].id,
          title: DEMO_CARDS[1].title,
          image_path: DEMO_CARDS[1].image_path,
          source: 'grant',
          acquired_at: new Date().toISOString(),
        },
      ]);
      setPendingDrawCount(1);
      return;
    }

    try {
      const { data, error } = await supabase.rpc('enter_room', {
        p_room_code: rCode,
        p_player_code: pCode || joinedPlayer?.player_code,
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
        const draws = data.filter((a) => a.action === 'draw').length;
        const discards = data.filter((a) => a.action === 'discard').length;
        setPendingDrawCount(draws);
        setPendingDiscardCount(discards);
      }
    } catch (err) {
      console.error('Error fetching pending actions:', err);
    }
  };

  // Realtime Subscription for Player
  useEffect(() => {
    if (isDemoMode || !joinedPlayer) return;

    fetchPlayerData(joinedPlayer.id, joinedPlayer.room_code, joinedPlayer.player_code);
    fetchPendingActions(joinedPlayer.id);

    const channel = supabase
      .channel(`player_realtime_${joinedPlayer.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'held_cards', filter: `player_id=eq.${joinedPlayer.id}` }, () => {
        fetchPlayerData(joinedPlayer.id, joinedPlayer.room_code, joinedPlayer.player_code);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pending_actions', filter: `player_id=eq.${joinedPlayer.id}` }, () => {
        fetchPlayerData(joinedPlayer.id, joinedPlayer.room_code, joinedPlayer.player_code);
        fetchPendingActions(joinedPlayer.id);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
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
      const randomCard = DEMO_CARDS[Math.floor(Math.random() * DEMO_CARDS.length)];
      const newCard: HeldCard = {
        held_card_id: 'h-' + Date.now(),
        card_id: randomCard.id,
        title: randomCard.title,
        image_path: randomCard.image_path,
        source: 'draw',
        acquired_at: new Date().toISOString(),
      };
      setHand((prev) => [newCard, ...prev]);
      setPendingDrawCount((prev) => Math.max(0, prev - 1));
      return;
    }

    try {
      const { data, error } = await supabase.rpc('perform_draw', {
        p_player_id: joinedPlayer?.id,
      });

      if (error) {
        if (error.code === 'P0001') {
          setErrorMsg('Permission expired or window closed by host.');
          setPendingDrawCount(0);
        } else if (error.code === 'P0008') {
          setErrorMsg('Hand is full — discard a card first.');
        } else {
          setErrorMsg(error.message);
        }
        return;
      }

      if (data) {
        setHand((prev) => [data, ...prev]);
        setPendingDrawCount((prev) => Math.max(0, prev - 1));
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

          <form onSubmit={handleJoin} className="space-y-4">
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
            {pendingDrawCount > 0 && (
              <Token tone="cyan" size="sm" label={`+${pendingDrawCount}`} title="Draws available" />
            )}
            {pendingDiscardCount > 0 && (
              <Token tone="red" size="sm" label={`−${pendingDiscardCount}`} title="Discards required" />
            )}

            {/* Quick Demo Action Trigger for testing */}
            {isDemoMode && (
              <button
                onClick={() => setPendingDrawCount((prev) => prev + 1)}
                className="btn-icon"
                title="Demo: grant a draw"
              >
                <Plus className="w-4 h-4" strokeWidth={3} />
              </button>
            )}
          </div>
        </div>

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
            <button onClick={handleDraw} className="btn-cyan w-full !py-4 text-lg animate-bob">
              <Token tone="gold" size="sm" label="+" className="!ring-2" />
              <span>Draw a card{pendingDrawCount > 1 ? ` ×${pendingDrawCount}` : ''}</span>
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
              source={zoomedCard.source}
              className="w-full max-w-[340px]"
            />
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
