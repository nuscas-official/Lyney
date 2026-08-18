import React, { useState, useEffect } from 'react';
import { 
  Shield, Users, Sparkles, Layers, RotateCcw, Plus, Trash2, 
  Eye, Edit3, UserX, UserCheck, RefreshCw, Upload, CheckCircle, 
  AlertTriangle, Sliders, X, Search
} from 'lucide-react';
import { supabase, isDemoMode, ensureAuthSession } from '../lib/supabase';
import { CardView } from '../components/CardView';
import { Card, CommandLogEntry } from '../types/database';

// Sample mock data for standalone local demo mode
const INITIAL_DEMO_CARDS: Card[] = [
  { id: 'c1', title: 'Shield of Faith', image_path: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?auto=format&fit=crop&w=600&q=80', weight: 1, active: true },
  { id: 'c2', title: 'Phoenix Flame', image_path: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=600&q=80', weight: 2, active: true },
  { id: 'c3', title: 'Ancient Elixir', image_path: 'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?auto=format&fit=crop&w=600&q=80', weight: 1, active: true },
  { id: 'c4', title: 'Shadow Cloak', image_path: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=600&q=80', weight: 1, active: true },
];

interface HostPlayer {
  id: string;
  name: string;
  player_code: string;
  active: boolean;
  hand: Array<{ held_card_id: string; card_id: string; title: string; image_path: string; source: 'draw' | 'grant' }>;
  hasActedInWindow?: boolean;
}

const INITIAL_DEMO_PLAYERS: HostPlayer[] = [
  { id: 'p1', name: 'Alex Morgan', player_code: 'K7M-4QP', active: true, hand: [
    { held_card_id: 'h1', card_id: 'c1', title: 'Shield of Faith', image_path: INITIAL_DEMO_CARDS[0].image_path, source: 'draw' }
  ], hasActedInWindow: true },
  { id: 'p2', name: 'Jordan Lee', player_code: '9X2-B7L', active: true, hand: [], hasActedInWindow: false },
  { id: 'p3', name: 'Sam Taylor', player_code: 'R4W-8TN', active: true, hand: [
    { held_card_id: 'h3', card_id: 'c2', title: 'Phoenix Flame', image_path: INITIAL_DEMO_CARDS[1].image_path, source: 'grant' }
  ], hasActedInWindow: true }
];

const HOST_SESSION_KEY = 'lyney_host_session';

export const HostDashboard: React.FC = () => {
  // Auth state
  const [roomCode, setRoomCode] = useState('');
  const [roomLabel, setRoomLabel] = useState('');
  const [hostPin, setHostPin] = useState('1234');
  const [isCreatingNewRoom, setIsCreatingNewRoom] = useState(false);
  const [isHostAuthenticated, setIsHostAuthenticated] = useState(false);
  const [isRestoringSession, setIsRestoringSession] = useState(!isDemoMode);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Tab navigation: 'overview' | 'catalog'
  const [activeTab, setActiveTab] = useState<'overview' | 'catalog'>('overview');

  // Room data state (empty when connected to Supabase!)
  const [players, setPlayers] = useState<HostPlayer[]>(isDemoMode ? INITIAL_DEMO_PLAYERS : []);
  const [cards, setCards] = useState<Card[]>(isDemoMode ? INITIAL_DEMO_CARDS : []);
  const [lastActionText, setLastActionText] = useState<string | null>(null);

  // Permission Bar Controls
  const [permScope, setPermScope] = useState<'room' | 'player'>('room');
  const [targetPlayerId, setTargetPlayerId] = useState('');
  const [permAction, setPermAction] = useState<'draw' | 'discard'>('draw');
  const [permCount, setPermCount] = useState(1);
  const [windowOpen, setWindowOpen] = useState(false);

  // Grant Card Modal
  const [selectedPlayer, setSelectedPlayer] = useState<HostPlayer | null>(null);
  const [showGrantModal, setShowGrantModal] = useState(false);
  const [selectedGrantCardId, setSelectedGrantCardId] = useState('');


  // Fetch real room data from Supabase via host_get_room RPC
  const fetchRoomData = async () => {
    if (isDemoMode) return;
    const cleanRoom = roomCode.trim().toUpperCase();

    try {
      const { data, error } = await supabase.rpc('host_get_room', { p_room_code: cleanRoom });
      if (error) {
        console.error('Error fetching room state via host_get_room:', error);
        return;
      }

      if (!data) return;

      if (data.room?.label) setRoomLabel(data.room.label);

      // Update cards catalog
      if (data.cards) {
        setCards(data.cards);
        if (data.cards.length > 0 && !selectedGrantCardId) {
          setSelectedGrantCardId(data.cards[0].id);
        }
      }

      const playersList = data.players || [];
      const heldList = data.held_cards || [];
      const pendingList = data.pending_actions || [];

      const mappedPlayers: HostPlayer[] = playersList.map((p: any) => {
        const playerHeld = heldList
          .filter((h: any) => h.player_id === p.id)
          .map((h: any) => ({
            held_card_id: h.id,
            card_id: h.card_id,
            title: h.title || 'Unknown Card',
            image_path: h.image_path || '',
            source: h.source as 'draw' | 'grant',
          }));

        const playerPending = pendingList.filter((pa: any) => pa.player_id === p.id);

        return {
          id: p.id,
          name: p.name,
          player_code: p.player_code,
          active: p.active,
          hand: playerHeld,
          hasActedInWindow: playerPending.length === 0,
        };
      });

      setPlayers(mappedPlayers);
    } catch (err) {
      console.error('Error fetching room data:', err);
    }
  };

  // Restore saved host session on load so a page refresh keeps the console open
  useEffect(() => {
    if (isDemoMode) return;

    const saved = localStorage.getItem(HOST_SESSION_KEY);
    if (!saved) {
      setIsRestoringSession(false);
      return;
    }

    (async () => {
      try {
        const { code, pin } = JSON.parse(saved);
        setRoomCode(code);
        setHostPin(pin);

        await ensureAuthSession();
        // Re-claim rather than trusting localStorage: this revalidates the PIN
        // and re-registers the room_hosts row if the anon uid was rotated.
        const { error } = await supabase.rpc('claim_host', { p_code: code, p_pin: pin });
        if (error) {
          localStorage.removeItem(HOST_SESSION_KEY);
        } else {
          setIsHostAuthenticated(true);
        }
      } catch (err) {
        console.error('Failed to restore host session:', err);
        localStorage.removeItem(HOST_SESSION_KEY);
      } finally {
        setIsRestoringSession(false);
      }
    })();
  }, []);

  // Realtime Subscription on Room
  useEffect(() => {
    if (isDemoMode || !isHostAuthenticated) return;

    fetchRoomData();

    const cleanRoom = roomCode.trim().toUpperCase();
    const channel = supabase
      .channel(`room_realtime_${cleanRoom}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_code=eq.${cleanRoom}` }, () => fetchRoomData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'held_cards', filter: `room_code=eq.${cleanRoom}` }, () => fetchRoomData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pending_actions', filter: `room_code=eq.${cleanRoom}` }, () => fetchRoomData())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isHostAuthenticated, roomCode]);

  // Host Login / Room Creation submit
  const handleHostLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    let cleanRoom = roomCode.trim().toUpperCase();

    if (isDemoMode) {
      setIsHostAuthenticated(true);
      return;
    }

    try {
      await ensureAuthSession();

      if (isCreatingNewRoom) {
        // The join code comes back from the server; the host only picks a label.
        const { data, error } = await supabase.rpc('create_room', {
          p_label: roomLabel.trim(),
          p_pin: hostPin.trim(),
        });
        if (error) {
          if (error.code === 'P0019' || error.message.includes('label_required')) {
            alert('Please name this room, e.g. "Table 3".');
          } else {
            alert(error.message);
          }
          return;
        }
        cleanRoom = data.room_code;
        setRoomCode(data.room_code);
        setRoomLabel(data.label);
      } else {
        const { error: claimError } = await supabase.rpc('claim_host', {
          p_code: cleanRoom,
          p_pin: hostPin.trim(),
        });
        if (claimError) {
          alert(claimError.message);
          return;
        }
      }
      localStorage.setItem(HOST_SESSION_KEY, JSON.stringify({ code: cleanRoom, pin: hostPin.trim() }));
      setIsHostAuthenticated(true);
    } catch (err: any) {
      alert(err.message || 'Host operation failed');
    }
  };

  // Issue Permission Handler
  const handleIssuePermission = async () => {
    const cleanRoom = roomCode.trim().toUpperCase();

    if (isDemoMode) {
      setWindowOpen(true);
      setPlayers((prev) =>
        prev.map((p) => {
          if (!p.active) return p;
          if (
            permScope === 'room' || (permScope === 'player' && p.id === targetPlayerId)
          ) {
            return { ...p, hasActedInWindow: false };
          }
          return p;
        })
      );
      setLastActionText(`Issued ${permAction.toUpperCase()} ×${permCount} (${permScope})`);
      return;
    }

    try {
      const { error } = await supabase.rpc('issue_permission', {
        p_room_code: cleanRoom,
        p_scope: permScope,
        p_action: permAction,
        p_count: permCount,
        p_target_id: permScope === 'player' ? targetPlayerId || null : null,
      });

      if (error) {
        alert(error.message);
      } else {
        setWindowOpen(true);
        setLastActionText(`Issued ${permAction.toUpperCase()} ×${permCount} (${permScope})`);
        fetchRoomData();
      }
    } catch (err: any) {
      alert(err.message || 'Failed to issue permission');
    }
  };

  // Close Window & Auto-Draw Handler
  const handleCloseWindow = async () => {
    const cleanRoom = roomCode.trim().toUpperCase();

    if (isDemoMode) {
      if (permAction === 'draw') {
        setPlayers((prev) =>
          prev.map((p) => {
            if (!p.active) return p;
            if (
              (permScope === 'room' || (permScope === 'player' && p.id === targetPlayerId)) &&
              !p.hasActedInWindow
            ) {
              const randomCard = cards[Math.floor(Math.random() * cards.length)];
              const autoCard = {
                held_card_id: 'auto-' + Date.now() + '-' + p.id,
                card_id: randomCard.id,
                title: randomCard.title,
                image_path: randomCard.image_path,
                source: 'draw' as const,
              };
              return { ...p, hand: [autoCard, ...p.hand], hasActedInWindow: true };
            }
            return p;
          })
        );
        setLastActionText(`Closed window & auto-drawn for unacted players`);
      } else {
        setLastActionText(`Closed discard window`);
      }
      setWindowOpen(false);
      return;
    }

    try {
      const { error } = await supabase.rpc('close_window', {
        p_room_code: cleanRoom,
        p_scope: permScope,
        p_action: permAction,
        p_fulfil: permAction === 'draw',
        p_target_id: permScope === 'player' ? targetPlayerId || null : null,
      });

      if (error) {
        alert(error.message);
      } else {
        setWindowOpen(false);
        setLastActionText(`Closed ${permAction} window`);
        fetchRoomData();
      }
    } catch (err: any) {
      alert(err.message || 'Failed to close window');
    }
  };

  // Host Direct Grant Card
  const handleGrantCard = async (playerId: string) => {
    const cardToGrant = cards.find((c) => c.id === selectedGrantCardId);
    if (!cardToGrant) return;

    if (isDemoMode) {
      const grantedCard = {
        held_card_id: 'grant-' + Date.now(),
        card_id: cardToGrant.id,
        title: cardToGrant.title,
        image_path: cardToGrant.image_path,
        source: 'grant' as const,
      };

      setPlayers((prev) =>
        prev.map((p) => (p.id === playerId ? { ...p, hand: [grantedCard, ...p.hand] } : p))
      );
      setLastActionText(`Granted ${cardToGrant.title}`);
      setShowGrantModal(false);
      return;
    }

    try {
      const { error } = await supabase.rpc('grant_card', {
        p_player_id: playerId,
        p_card_id: selectedGrantCardId,
      });

      if (error) {
        alert(error.message);
      } else {
        setLastActionText(`Granted ${cardToGrant.title}`);
        setShowGrantModal(false);
        fetchRoomData();
      }
    } catch (err: any) {
      alert(err.message || 'Failed to grant card');
    }
  };

  // Host Revoke Card
  const handleRevokeCard = async (playerId: string, heldCardId: string) => {
    if (isDemoMode) {
      setPlayers((prev) =>
        prev.map((p) =>
          p.id === playerId
            ? { ...p, hand: p.hand.filter((h) => h.held_card_id !== heldCardId) }
            : p
        )
      );
      setLastActionText(`Revoked card from player`);
      return;
    }

    try {
      const { error } = await supabase.rpc('revoke_card', { p_held_card_id: heldCardId });
      if (error) {
        alert(error.message);
      } else {
        setLastActionText(`Revoked card from player`);
        fetchRoomData();
      }
    } catch (err: any) {
      alert(err.message || 'Failed to revoke card');
    }
  };

  // Remove Player
  const handleRemovePlayer = async (playerId: string) => {
    if (isDemoMode) {
      setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, active: false } : p)));
      setLastActionText(`Removed player`);
      return;
    }

    try {
      const { error } = await supabase.rpc('remove_player', { p_player_id: playerId });
      if (error) {
        alert(error.message);
      } else {
        setLastActionText(`Removed player`);
        fetchRoomData();
      }
    } catch (err: any) {
      alert(err.message || 'Failed to remove player');
    }
  };

  // Restore Player
  const handleRestorePlayer = async (playerId: string) => {
    if (isDemoMode) {
      setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, active: true } : p)));
      setLastActionText(`Restored player`);
      return;
    }

    try {
      const { error } = await supabase.rpc('restore_player', { p_player_id: playerId });
      if (error) {
        alert(error.message);
      } else {
        setLastActionText(`Restored player`);
        fetchRoomData();
      }
    } catch (err: any) {
      alert(err.message || 'Failed to restore player');
    }
  };

  // Undo Action
  const handleUndo = async () => {
    if (isDemoMode) {
      alert(`Undid last action: "${lastActionText}"`);
      setLastActionText(null);
      return;
    }

    try {
      const { error } = await supabase.rpc('undo_last', { p_room_code: roomCode.trim().toUpperCase() });
      if (error) {
        alert(error.message);
      } else {
        setLastActionText(null);
        fetchRoomData();
      }
    } catch (err: any) {
      alert(err.message || 'Failed to undo');
    }
  };

  // Reset Room Session
  const handleResetRoom = async () => {
    if (!window.confirm('Are you sure you want to end this session and reset all room data? All player hands for this room will be cleared.')) {
      return;
    }

    const cleanRoom = roomCode.trim().toUpperCase();

    if (isDemoMode) {
      setPlayers([]);
      setLastActionText('Reset room session');
      return;
    }

    try {
      const { error } = await supabase.rpc('reset_room', { p_room_code: cleanRoom });
      if (error) {
        alert(error.message);
      } else {
        setPlayers([]);
        setLastActionText('Reset room session');
        fetchRoomData();
      }
    } catch (err: any) {
      alert(err.message || 'Failed to reset room');
    }
  };

  // Manual refresh so the host can re-pull room state without reloading the page
  const handleManualRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await fetchRoomData();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleSignOut = () => {
    localStorage.removeItem(HOST_SESSION_KEY);
    setIsHostAuthenticated(false);
    setPlayers([]);
  };

  // Session restore is still in flight: hold the login screen back so a refresh
  // does not flash the PIN form at an already-authenticated host.
  if (isRestoringSession) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <RefreshCw className="w-6 h-6 text-amber-400 animate-spin" />
      </div>
    );
  }

  // Calculate table groups
  const activePlayers = players.filter((p) => p.active);
  const actedCount = activePlayers.filter((p) => p.hasActedInWindow).length;
  const totalWeight = cards.reduce((sum, c) => sum + (c.active ? c.weight : 0), 0);

  // 1. HOST LOGIN SCREEN
  if (!isHostAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
        <div className="text-center mb-6">
          <div className="inline-flex p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl mb-3">
            <Shield className="w-8 h-8 text-amber-400" />
          </div>
          <h1 className="text-3xl font-black text-white font-['Outfit']">Host Dashboard</h1>
          <p className="text-xs text-slate-400">Lyney Event Management Console</p>
        </div>

        <div className="w-full max-w-sm glass-panel p-6 sm:p-8 rounded-2xl border border-slate-800">
          <div className="flex bg-slate-900 p-1 rounded-xl mb-6 text-xs font-semibold border border-slate-800">
            <button
              type="button"
              onClick={() => setIsCreatingNewRoom(false)}
              className={`flex-1 py-1.5 rounded-lg text-center transition-colors ${
                !isCreatingNewRoom ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400'
              }`}
            >
              Access Room
            </button>
            <button
              type="button"
              onClick={() => setIsCreatingNewRoom(true)}
              className={`flex-1 py-1.5 rounded-lg text-center transition-colors ${
                isCreatingNewRoom ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400'
              }`}
            >
              Create Room
            </button>
          </div>

          <form onSubmit={handleHostLogin} className="space-y-4">
            {isCreatingNewRoom ? (
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase mb-1.5">
                  Room Name
                </label>
                <input
                  type="text"
                  value={roomLabel}
                  onChange={(e) => setRoomLabel(e.target.value)}
                  placeholder="e.g. Table 3"
                  className="w-full px-4 py-3 bg-slate-900 border border-slate-700 rounded-xl text-white focus:outline-none focus:border-amber-500"
                  required
                />
                <p className="text-[11px] text-slate-500 mt-1.5">
                  Your join code is generated when the room is created.
                </p>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase mb-1.5">
                  Join Code
                </label>
                <input
                  type="text"
                  value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                  placeholder="e.g. K7M4QP"
                  className="w-full px-4 py-3 bg-slate-900 border border-slate-700 rounded-xl text-white font-mono uppercase focus:outline-none focus:border-amber-500"
                  required
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase mb-1.5">
                {isCreatingNewRoom ? 'Set Host PIN' : 'Host PIN'}
              </label>
              <input
                type="password"
                value={hostPin}
                onChange={(e) => setHostPin(e.target.value)}
                placeholder="e.g. 1234"
                className="w-full px-4 py-3 bg-slate-900 border border-slate-700 rounded-xl text-white font-mono focus:outline-none focus:border-amber-500"
                required
              />
            </div>
            <button
              type="submit"
              className="w-full py-3.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-xl shadow-lg shadow-amber-500/20 transition-colors"
            >
              {isCreatingNewRoom ? 'Create & Launch Room' : 'Access Dashboard'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // 2. MAIN HOST DASHBOARD INTERFACE
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col pb-24">
      {/* Top Header */}
      <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-4 sm:px-6 py-3 flex items-center justify-between shadow-md">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-400 flex items-center justify-center font-bold">
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base font-bold text-white flex items-center gap-2">
              {roomLabel || 'Host Console'}
              <span className="text-xs px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-mono">
                Join code: {roomCode}
              </span>
            </h1>
            <p className="text-xs text-slate-400">{activePlayers.length} Active Players</p>
          </div>
        </div>

        {/* Navigation Tabs & Reset */}
        <div className="flex items-center gap-2">
          <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs font-semibold">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-3 py-1.5 rounded-lg transition-colors ${
                activeTab === 'overview' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Room View
            </button>
            <button
              onClick={() => setActiveTab('catalog')}
              className={`px-3 py-1.5 rounded-lg transition-colors ${
                activeTab === 'catalog' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Card Catalog ({cards.length})
            </button>
          </div>

          <button
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-indigo-500/50 text-slate-400 hover:text-indigo-300 text-xs font-semibold rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
            title="Refresh Room Data"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} /> Refresh
          </button>

          <button
            onClick={handleResetRoom}
            className="px-3 py-1.5 bg-slate-900 hover:bg-rose-950/80 border border-slate-800 hover:border-rose-500/50 text-slate-400 hover:text-rose-300 text-xs font-semibold rounded-xl transition-colors flex items-center gap-1.5"
            title="Reset Session Data"
          >
            <Trash2 className="w-3.5 h-3.5" /> Reset Session
          </button>

          <button
            onClick={handleSignOut}
            className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white text-xs font-semibold rounded-xl transition-colors"
            title="Sign out of host console"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Persistent Undo Banner */}
      {lastActionText && (
        <div className="bg-indigo-950/80 border-b border-indigo-500/30 px-4 py-2 flex items-center justify-between text-xs font-medium">
          <span className="text-indigo-200 truncate">Last Action: {lastActionText}</span>
          <button
            onClick={handleUndo}
            className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg flex items-center gap-1 shrink-0 ml-2"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Undo
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {/* ROOM VIEW TAB */}
        {activeTab === 'overview' && (
          <>
            {/* Primary Permission Control Bar */}
            <div className="glass-panel p-4 sm:p-5 rounded-2xl border border-slate-800 shadow-xl space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-amber-400" /> Permission Controller
                </h2>
                {windowOpen && (
                  <span className="px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 text-xs font-semibold animate-pulse border border-amber-500/40">
                    Window Open
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                {/* Scope selector */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Scope</label>
                  <select
                    value={permScope}
                    onChange={(e) => setPermScope(e.target.value as any)}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs font-semibold text-white focus:outline-none"
                  >
                    <option value="room">Whole Room ({activePlayers.length})</option>
                    <option value="player">Single Player</option>
                  </select>
                </div>

                {/* Scope specifics */}
                {permScope === 'player' && (
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Select Player</label>
                    <select
                      value={targetPlayerId}
                      onChange={(e) => setTargetPlayerId(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs font-semibold text-white focus:outline-none"
                    >
                      {activePlayers.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Action Type */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Action</label>
                  <select
                    value={permAction}
                    onChange={(e) => setPermAction(e.target.value as any)}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs font-semibold text-white focus:outline-none"
                  >
                    <option value="draw">DRAW CARD</option>
                    <option value="discard">DISCARD CARD</option>
                  </select>
                </div>

                {/* Quantity */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Quantity</label>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    value={permCount}
                    onChange={(e) => setPermCount(parseInt(e.target.value) || 1)}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs font-semibold text-white focus:outline-none"
                  />
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={handleIssuePermission}
                  className="flex-1 py-3 bg-amber-500 hover:bg-amber-400 text-slate-950 font-extrabold text-xs rounded-xl shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2 transition-colors"
                >
                  <Sparkles className="w-4 h-4" /> Issue Window ({permAction.toUpperCase()} ×{permCount})
                </button>

                {windowOpen && (
                  <button
                    onClick={handleCloseWindow}
                    className="px-5 py-3 bg-slate-800 hover:bg-slate-700 text-rose-300 font-bold text-xs rounded-xl border border-rose-500/30 transition-colors"
                  >
                    Close Window & Auto-Draw
                  </button>
                )}
              </div>
            </div>

            {/* Player Cards Grid */}
            <div className="space-y-4">
              {players.length === 0 ? (
                <div className="glass-panel p-8 rounded-2xl text-center border border-slate-800">
                  <Users className="w-10 h-10 text-slate-600 mx-auto mb-2" />
                  <h3 className="text-sm font-bold text-slate-200">No Players in Room Yet</h3>
                  <p className="text-xs text-slate-400 max-w-xs mx-auto mt-1">
                    Players who enter join code <strong className="text-indigo-300 font-mono">{roomCode}</strong> on their phones will appear here live.
                  </p>
                </div>
              ) : (
                <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden">
                  <div className="px-4 sm:px-5 py-3.5 bg-slate-900/80 flex items-center justify-between border-b border-slate-800/80">
                    <div className="flex items-center gap-3">
                      <h3 className="text-sm font-bold text-white">Players</h3>
                      <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 text-[11px]">
                        {activePlayers.length} active
                      </span>
                    </div>
                    <div className="text-xs font-semibold text-slate-400">
                      Progress: <strong className="text-amber-300">{actedCount} / {activePlayers.length}</strong> drawn
                    </div>
                  </div>

                  <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {players.map((player) => (
                      <div
                        key={player.id}
                        className={`p-4 rounded-xl border transition-all ${
                          player.active
                            ? 'bg-slate-900/60 border-slate-800/80 hover:border-slate-700'
                            : 'bg-slate-950/40 border-slate-900 opacity-50 grayscale'
                        }`}
                      >
                        {/* Player Row Header */}
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <h4 className="text-sm font-bold text-slate-100 flex items-center gap-1.5">
                              {player.name}
                              {!player.active && (
                                <span className="text-[10px] font-semibold text-rose-400 bg-rose-950 px-1.5 py-0.5 rounded border border-rose-800">
                                  Removed
                                </span>
                              )}
                            </h4>
                            <p className="text-[11px] font-mono text-amber-400/90">
                              Code: {player.player_code}
                            </p>
                          </div>

                          <div className="flex items-center gap-1">
                            {player.active ? (
                              <>
                                <button
                                  onClick={() => {
                                    setSelectedPlayer(player);
                                    setShowGrantModal(true);
                                  }}
                                  className="p-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-amber-300"
                                  title="Grant Specific Card"
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleRemovePlayer(player.id)}
                                  className="p-1.5 bg-slate-800 hover:bg-rose-950 rounded-lg text-slate-400 hover:text-rose-400"
                                  title="Remove Player"
                                >
                                  <UserX className="w-3.5 h-3.5" />
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => handleRestorePlayer(player.id)}
                                className="p-1.5 bg-slate-800 hover:bg-emerald-950 rounded-lg text-emerald-400"
                                title="Restore Player"
                              >
                                <UserCheck className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Player Hand Thumbnails */}
                        <div className="space-y-1.5">
                          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                            Hand ({player.hand.length})
                          </p>
                          {player.hand.length === 0 ? (
                            <p className="text-xs text-slate-600 italic">No cards held</p>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {player.hand.map((h) => (
                                <div
                                  key={h.held_card_id}
                                  className="relative group px-2 py-1 bg-slate-850 rounded-lg border border-slate-700/60 text-xs font-medium text-slate-300 flex items-center gap-1.5"
                                >
                                  <span className="truncate max-w-[100px]">{h.title}</span>
                                  {player.active && (
                                    <button
                                      onClick={() => handleRevokeCard(player.id, h.held_card_id)}
                                      className="text-slate-500 hover:text-rose-400"
                                      title="Revoke Card"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* CATALOG & WEIGHTS TAB */}
        {activeTab === 'catalog' && (
          <div className="space-y-6">
            <div className="glass-panel p-5 rounded-2xl border border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-white mb-1">Card Catalog</h2>
                <p className="text-xs text-slate-400">
                  Manage active cards and adjust draw weights for random distribution.
                </p>
              </div>
              <button
                onClick={fetchRoomData}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl flex items-center gap-2"
              >
                <RefreshCw className="w-4 h-4" /> Refresh Catalog
              </button>
            </div>

            {/* Card Weights Table */}
            <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-900 border-b border-slate-800 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                    <th className="py-3 px-4">Card Title</th>
                    <th className="py-3 px-4">Image Path</th>
                    <th className="py-3 px-4 text-center">Draw Weight</th>
                    <th className="py-3 px-4 text-right">Probability</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-xs">
                  {cards.map((card) => {
                    const prob = totalWeight > 0 ? ((card.weight / totalWeight) * 100).toFixed(1) : '0.0';
                    return (
                      <tr key={card.id} className="hover:bg-slate-900/50">
                        <td className="py-3 px-4 font-bold text-slate-100">{card.title}</td>
                        <td className="py-3 px-4 font-mono text-slate-400 text-[11px]">{card.image_path}</td>
                        <td className="py-3 px-4 text-center">
                          <input
                            type="number"
                            min="1"
                            max="100"
                            value={card.weight}
                            onChange={(e) => {
                              const w = parseInt(e.target.value) || 1;
                              setCards((prev) =>
                                prev.map((c) => (c.id === card.id ? { ...c, weight: w } : c))
                              );
                            }}
                            className="w-16 px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-center font-bold text-amber-300 focus:outline-none"
                          />
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-indigo-300">
                          {prob}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>

      {/* Direct Grant Card Modal */}
      {showGrantModal && selectedPlayer && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="glass-panel max-w-sm w-full rounded-2xl p-6 border border-slate-800 relative">
            <button
              onClick={() => setShowGrantModal(false)}
              className="absolute top-3 right-3 text-slate-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>

            <h3 className="text-base font-bold text-white mb-1">Grant Card to {selectedPlayer.name}</h3>
            <p className="text-xs text-slate-400 mb-4">
              Select a card to add directly to this player's hand.
            </p>

            <div className="space-y-3 mb-6">
              <label className="block text-xs font-semibold text-slate-300 uppercase">Select Card</label>
              <select
                value={selectedGrantCardId}
                onChange={(e) => setSelectedGrantCardId(e.target.value)}
                className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-xs font-semibold text-white focus:outline-none"
              >
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} (Weight: {c.weight})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setShowGrantModal(false)}
                className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl"
              >
                Cancel
              </button>
              <button
                onClick={() => handleGrantCard(selectedPlayer.id)}
                className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold rounded-xl shadow-lg shadow-amber-500/20"
              >
                Grant Card
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
