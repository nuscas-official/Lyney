import React, { useState, useEffect } from 'react';
import { 
  Key, User, Layers, WifiOff, AlertTriangle, CheckCircle, 
  Sparkles, Eye, Trash2, X, RefreshCcw, Copy, ShieldAlert,
  ArrowRight
} from 'lucide-react';
import { CardView } from '../components/CardView';
import { supabase, isDemoMode, ensureAuthSession } from '../lib/supabase';
import { HeldCard, PendingAction } from '../types/database';

// Sample fallback cards for offline / demo mode
const DEMO_CARDS = [
  { id: '1', title: 'Shield of Faith', image_path: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?auto=format&fit=crop&w=600&q=80' },
  { id: '2', title: 'Phoenix Flame', image_path: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=600&q=80' },
  { id: '3', title: 'Ancient Elixir', image_path: 'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?auto=format&fit=crop&w=600&q=80' },
  { id: '4', title: 'Shadow Cloak', image_path: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=600&q=80' }
];

export const PlayerApp: React.FC = () => {
  // Session & Player state
  const [roomCode, setRoomCode] = useState('DEMO1');
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
        setRoomCode(parsed.player.room_code || 'DEMO1');
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
      if (cleanRejoin && cleanRejoin !== 'K7M-4QP' && cleanRejoin !== 'DEMO12') {
        setErrorMsg("That rejoin code isn't valid for this room.");
        return;
      }

      const playerObj = {
        id: 'p-100',
        name: playerName || 'Player One',
        player_code: cleanRejoin || 'K7M-4QP',
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
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-16 h-16 rounded-full bg-rose-500/10 border border-rose-500/30 text-rose-500 flex items-center justify-center mb-4">
          <ShieldAlert className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-bold text-slate-100 mb-2">Session Deactivated</h2>
        <p className="text-slate-400 text-sm max-w-xs mb-6">
          You have been removed from this room by the host. Please speak to your table host to be restored.
        </p>
        <button
          onClick={() => {
            localStorage.removeItem('lyney_player_session');
            setIsRemoved(false);
            setJoinedPlayer(null);
          }}
          className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold rounded-xl"
        >
          Return to Join Screen
        </button>
      </div>
    );
  }

  // 1. JOIN SCREEN
  if (!joinedPlayer) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-indigo-950/30 flex flex-col items-center justify-center p-4">
        {/* Header Branding */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center p-3 bg-indigo-500/10 border border-indigo-500/30 rounded-2xl mb-3 shadow-lg shadow-indigo-500/10">
            <Layers className="w-8 h-8 text-indigo-400" />
          </div>
          <h1 className="text-4xl font-black tracking-tight text-white mb-1 font-['Outfit']">
            Lyney
          </h1>
          <p className="text-xs font-semibold text-indigo-300 uppercase tracking-widest">
            Physical Board Game Companion
          </p>
        </div>

        {/* Join Card Form */}
        <div className="w-full max-w-md glass-panel rounded-2xl p-6 sm:p-8 shadow-2xl border border-slate-800">
          <h2 className="text-xl font-bold text-slate-100 mb-1">Join Room</h2>
          <p className="text-xs text-slate-400 mb-6">
            Enter room details to view your live card hand.
          </p>

          {errorMsg && (
            <div className="mb-5 p-3.5 bg-rose-950/70 border border-rose-500/40 rounded-xl text-rose-300 text-xs flex items-center gap-2.5 animate-shake">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Join Code <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                placeholder="e.g. K7M4QP"
                className="w-full px-4 py-3 bg-slate-900/90 border border-slate-700/80 rounded-xl text-slate-100 placeholder-slate-500 font-mono tracking-wider focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors uppercase"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Rejoin Code <span className="text-slate-500 text-[10px] font-normal lowercase">(optional for returning players)</span>
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={rejoinCodeInput}
                  onChange={(e) => setRejoinCodeInput(e.target.value.toUpperCase())}
                  placeholder="e.g. K7M-4QP"
                  className="w-full px-4 py-3 bg-slate-900/90 border border-slate-700/80 rounded-xl text-slate-100 placeholder-slate-500 font-mono tracking-wider focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors uppercase"
                />
                <Key className="w-4 h-4 text-slate-500 absolute right-3.5 top-3.5" />
              </div>
            </div>

            {/* Display name field: required only when rejoin code is empty */}
            {!rejoinCodeInput.trim() && (
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  Your Display Name <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={playerName}
                    onChange={(e) => setPlayerName(e.target.value)}
                    placeholder="e.g. Alex Morgan"
                    className="w-full px-4 py-3 bg-slate-900/90 border border-slate-700/80 rounded-xl text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                    required
                  />
                  <User className="w-4 h-4 text-slate-500 absolute right-3.5 top-3.5" />
                </div>
              </div>
            )}

            <button
              type="submit"
              className="w-full py-3.5 mt-2 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-bold rounded-xl shadow-lg shadow-indigo-600/30 flex items-center justify-center gap-2 transition-all transform active:scale-[0.99]"
            >
              Enter Room <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>
    );
  }

  // 2. MAIN PLAYER HAND VIEW
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col pb-24">
      {/* Offline Status Banner */}
      {!isOnline && (
        <div className="bg-amber-600 text-slate-950 px-4 py-2 text-xs font-bold flex items-center justify-center gap-2 text-center sticky top-0 z-50">
          <WifiOff className="w-4 h-4 shrink-0" />
          <span>Connection dropped. Displaying last cached hand state.</span>
        </div>
      )}

      {/* Catalog Preloader Banner */}
      {isPreloading && (
        <div className="bg-indigo-900/80 border-b border-indigo-500/30 px-4 py-2 text-xs font-semibold flex items-center justify-between text-indigo-200">
          <span>Preloading artwork catalog...</span>
          <div className="w-24 bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-indigo-400 h-full transition-all duration-200"
              style={{ width: `${preloadProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* App Header */}
      <header className="sticky top-0 z-40 bg-slate-900/80 backdrop-blur-lg border-b border-slate-800 px-4 py-3 flex items-center justify-between shadow-lg">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/40 text-indigo-400 flex items-center justify-center font-bold font-['Outfit']">
            L
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-100 leading-tight">{joinedPlayer.name}</h2>
            <p className="text-[11px] font-medium text-slate-400 font-mono">{joinedPlayer.room_code}</p>
          </div>
        </div>

        {/* Rejoin Code Display Chip */}
        <button
          onClick={() => setShowCodeModal(true)}
          className="px-3 py-1.5 bg-slate-800/90 hover:bg-slate-700/90 border border-slate-700 rounded-lg text-xs font-mono font-bold text-amber-300 flex items-center gap-1.5 shadow-sm transition-colors"
          title="View Rejoin Code"
        >
          <Key className="w-3.5 h-3.5 text-amber-400" />
          <span>{joinedPlayer.player_code}</span>
        </button>
      </header>

      {/* Main Content: Player Hand */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-4 sm:p-6">
        {/* Error notification */}
        {errorMsg && (
          <div className="mb-4 p-3 bg-rose-950/80 border border-rose-500/50 rounded-xl text-rose-300 text-xs flex items-center justify-between">
            <span>{errorMsg}</span>
            <button onClick={() => setErrorMsg(null)} className="p-1 text-rose-400 hover:text-rose-200">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Hand Title Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <Layers className="w-5 h-5 text-indigo-400" /> Your Hand
            </h1>
            <p className="text-xs text-slate-400">
              {hand.length} {hand.length === 1 ? 'card' : 'cards'} held
            </p>
          </div>

          {/* Quick Demo Action Trigger for testing */}
          {isDemoMode && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPendingDrawCount((prev) => prev + 1)}
                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 rounded-lg border border-slate-700"
              >
                + Grant Permission
              </button>
            </div>
          )}
        </div>

        {/* Hand Cards Grid / Stack */}
        {hand.length === 0 ? (
          <div className="min-h-[280px] rounded-2xl border-2 border-dashed border-slate-800 flex flex-col items-center justify-center p-6 text-center bg-slate-900/30">
            <Layers className="w-12 h-12 text-slate-600 mb-3 opacity-60" />
            <h3 className="text-sm font-semibold text-slate-300 mb-1">Your hand is currently empty</h3>
            <p className="text-xs text-slate-500 max-w-xs">
              When the host opens a draw window, your action button below will light up.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 sm:gap-4 justify-items-center">
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
      <footer className="fixed bottom-0 inset-x-0 bg-slate-900/90 backdrop-blur-xl border-t border-slate-800 p-4 z-40">
        <div className="max-w-md mx-auto flex items-center gap-3">
          {pendingDrawCount > 0 ? (
            <button
              onClick={handleDraw}
              className="flex-1 py-4 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 active:from-indigo-700 active:to-indigo-600 text-white font-extrabold text-base rounded-2xl shadow-xl shadow-indigo-600/30 flex items-center justify-center gap-2 transform active:scale-[0.98] transition-all animate-bounce-subtle"
            >
              <Sparkles className="w-5 h-5 text-amber-300" />
              <span>Draw Card {pendingDrawCount > 1 ? `(×${pendingDrawCount})` : ''}</span>
            </button>
          ) : (
            <div className="flex-1 py-3.5 px-4 bg-slate-950/60 border border-slate-800/80 rounded-2xl text-center flex items-center justify-center gap-2 text-slate-500 text-xs font-semibold">
              <span className="w-2 h-2 rounded-full bg-slate-600 animate-pulse" />
              <span>Waiting for host window...</span>
            </div>
          )}
        </div>
      </footer>

      {/* Rejoin Code Modal */}
      {showCodeModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="glass-panel max-w-xs w-full rounded-2xl p-6 text-center border border-slate-800 relative">
            <button
              onClick={() => setShowCodeModal(false)}
              className="absolute top-3 right-3 text-slate-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="w-12 h-12 mx-auto rounded-full bg-amber-500/10 text-amber-400 flex items-center justify-center mb-3">
              <Key className="w-6 h-6" />
            </div>

            <h3 className="text-base font-bold text-slate-100 mb-1">Your Rejoin Code</h3>
            <p className="text-xs text-slate-400 mb-4">
              Use this code to restore your hand on another device if your battery dies.
            </p>

            <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-2xl font-black text-amber-300 tracking-wider mb-4 select-all">
              {joinedPlayer.player_code}
            </div>

            <button
              onClick={copyRejoinCode}
              className="w-full py-2.5 mb-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors"
            >
              {copied ? (
                <>
                  <CheckCircle className="w-4 h-4 text-emerald-400" /> Copied!
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" /> Copy Rejoin Code
                </>
              )}
            </button>

            <button
              onClick={() => {
                setShowCodeModal(false);
                handleLeaveRoom();
              }}
              className="w-full py-2 text-rose-400 hover:text-rose-300 text-xs font-semibold hover:underline"
            >
              Leave / Switch Room
            </button>
          </div>
        </div>
      )}

      {/* Card Zoom Modal */}
      {zoomedCard && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="relative max-w-sm w-full flex flex-col items-center">
            <button
              onClick={() => setZoomedCard(null)}
              className="absolute -top-10 right-0 text-slate-300 hover:text-white flex items-center gap-1 text-xs font-semibold"
            >
              Close <X className="w-5 h-5" />
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
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="glass-panel max-w-xs w-full rounded-2xl p-6 text-center border border-slate-800">
            <div className="w-12 h-12 mx-auto rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center mb-3">
              <Trash2 className="w-6 h-6" />
            </div>
            <h3 className="text-base font-bold text-slate-100 mb-1">Confirm Discard</h3>
            <p className="text-xs text-slate-400 mb-4">
              Are you sure you want to discard <strong className="text-slate-200">{cardToDiscard.title}</strong>? Discarded cards cannot be self-recovered.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setCardToDiscard(null)}
                className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl"
              >
                Cancel
              </button>
              <button
                onClick={confirmDiscard}
                className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-xl shadow-lg shadow-rose-600/30"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
