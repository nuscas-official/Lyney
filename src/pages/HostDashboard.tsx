import React, { useState, useEffect } from 'react';
import {
  Shield, Users, Layers, RotateCcw, Plus, Trash2,
  UserX, UserCheck, RefreshCw, Sliders, X,
} from 'lucide-react';
import { supabase, isDemoMode, ensureAuthSession } from '../lib/supabase';
import { Token, Standee, PaperChip, BoardHeading } from '../components/BoardBits';
import { Card } from '../types/database';

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
      <div className="flex-1 flex items-center justify-center">
        <div className="panel p-6">
          <RefreshCw className="w-6 h-6 text-crimson-500 animate-spin" strokeWidth={2.75} />
        </div>
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
      <div className="flex-1 flex flex-col items-center justify-center p-4 py-10">
        <div className="text-center mb-7">
          <Token tone="gold" size="lg" icon={Shield} className="mx-auto mb-3" />
          <h1 className="board-sign text-4xl leading-none -rotate-1 mb-1.5">Host Console</h1>
          <p className="font-display font-bold text-xs uppercase tracking-[0.18em] text-board-800">
            Run the table
          </p>
        </div>

        <div className="w-full max-w-sm panel taped p-6 sm:p-7 pt-8">
          {/* Access / Create toggle, built as two board tiles */}
          <div className="flex gap-1 p-1 mb-6 rounded-2xl bg-parchment-200 border-[2.5px] border-ink-900">
            <button
              type="button"
              onClick={() => setIsCreatingNewRoom(false)}
              className={`flex-1 py-2 rounded-xl font-display font-bold text-xs transition-colors ${
                !isCreatingNewRoom ? 'bg-pip-gold text-ink-900 shadow-sticker-sm' : 'text-ink-500'
              }`}
            >
              Access room
            </button>
            <button
              type="button"
              onClick={() => setIsCreatingNewRoom(true)}
              className={`flex-1 py-2 rounded-xl font-display font-bold text-xs transition-colors ${
                isCreatingNewRoom ? 'bg-pip-gold text-ink-900 shadow-sticker-sm' : 'text-ink-500'
              }`}
            >
              Create room
            </button>
          </div>

          <form onSubmit={handleHostLogin} className="space-y-4">
            {isCreatingNewRoom ? (
              <div>
                <label className="field-label">Room name</label>
                <input
                  type="text"
                  value={roomLabel}
                  onChange={(e) => setRoomLabel(e.target.value)}
                  placeholder="e.g. Table 3"
                  className="field"
                  required
                />
                <p className="text-[11px] font-semibold text-ink-400 mt-1.5">
                  A join code is printed for you once the room exists.
                </p>
              </div>
            ) : (
              <div>
                <label className="field-label">Join code</label>
                <input
                  type="text"
                  value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                  placeholder="e.g. K7M4QP"
                  className="field font-mono tracking-[0.15em] uppercase"
                  required
                />
              </div>
            )}
            <div>
              <label className="field-label">
                {isCreatingNewRoom ? 'Set host PIN' : 'Host PIN'}
              </label>
              <input
                type="password"
                value={hostPin}
                onChange={(e) => setHostPin(e.target.value)}
                placeholder="e.g. 1234"
                className="field font-mono tracking-[0.2em]"
                required
              />
            </div>
            <button type="submit" className="btn-crimson w-full !py-4 text-base">
              {isCreatingNewRoom ? 'Create & launch' : 'Open console'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // 2. MAIN HOST DASHBOARD INTERFACE
  return (
    <div className="flex-1 flex flex-col pb-10">
      {/* Top Header — the cream path running across the top of the board */}
      <header className="sticky top-0 z-40 path-strip border-b-[3px] border-ink-900 px-4 sm:px-6 py-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Token tone="gold" size="md" icon={Shield} />
            <div className="min-w-0">
              <h1 className="font-display text-lg font-extrabold text-ink-800 leading-tight truncate">
                {roomLabel || 'Host Console'}
              </h1>
              <p className="text-xs font-bold text-ink-500">
                {activePlayers.length} {activePlayers.length === 1 ? 'player' : 'players'} at the table
              </p>
            </div>
          </div>

          <span className="shrink-0 chip bg-white code-stamp !text-sm">{roomCode}</span>
        </div>

        {/* Navigation Tabs & Actions */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1 p-1 rounded-2xl bg-white border-[2.5px] border-ink-900">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-3 py-1.5 rounded-xl font-display font-bold text-xs transition-colors ${
                activeTab === 'overview' ? 'bg-pip-cyan text-ink-900 shadow-sticker-sm' : 'text-ink-500 hover:text-ink-800'
              }`}
            >
              Room
            </button>
            <button
              onClick={() => setActiveTab('catalog')}
              className={`px-3 py-1.5 rounded-xl font-display font-bold text-xs transition-colors ${
                activeTab === 'catalog' ? 'bg-pip-cyan text-ink-900 shadow-sticker-sm' : 'text-ink-500 hover:text-ink-800'
              }`}
            >
              Catalog ({cards.length})
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={handleManualRefresh}
              disabled={isRefreshing}
              className="btn-icon"
              title="Refresh room data"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} strokeWidth={2.75} />
            </button>

            <button
              onClick={handleResetRoom}
              className="btn-icon hover:!bg-pip-red hover:!text-white"
              title="Reset session data"
            >
              <Trash2 className="w-4 h-4" strokeWidth={2.75} />
            </button>

            <button onClick={handleSignOut} className="btn-paper !py-2 !px-3 !text-xs" title="Sign out">
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Persistent Undo Banner */}
      {lastActionText && (
        <div className="bg-pip-violet border-b-[3px] border-ink-900 px-4 py-2 flex items-center justify-between gap-3">
          <span className="font-display font-bold text-xs text-white truncate">
            Last move: {lastActionText}
          </span>
          <button onClick={handleUndo} className="btn-paper !py-1.5 !px-3 !text-xs shrink-0">
            <RotateCcw className="w-3.5 h-3.5" strokeWidth={2.75} /> Undo
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {/* ROOM VIEW TAB */}
        {activeTab === 'overview' && (
          <>
            {/* Primary Permission Control Bar */}
            <div className="panel p-4 sm:p-5 space-y-4">
              <div className="flex items-center justify-between gap-3 border-b-[2.5px] border-dashed border-ink-900/25 pb-3">
                <BoardHeading
                  icon={Sliders}
                  tone="crimson"
                  title="Move controller"
                  subtitle="Open a window and let the table act"
                />
                {windowOpen && (
                  <span className="chip bg-pip-gold shrink-0 animate-wiggle">
                    <span className="font-display font-extrabold">!</span> Window open
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                {/* Scope selector */}
                <div>
                  <label className="field-label">Scope</label>
                  <select
                    value={permScope}
                    onChange={(e) => setPermScope(e.target.value as any)}
                    className="field !py-2.5 !text-sm"
                  >
                    <option value="room">Whole room ({activePlayers.length})</option>
                    <option value="player">Single player</option>
                  </select>
                </div>

                {/* Scope specifics */}
                {permScope === 'player' && (
                  <div>
                    <label className="field-label">Player</label>
                    <select
                      value={targetPlayerId}
                      onChange={(e) => setTargetPlayerId(e.target.value)}
                      className="field !py-2.5 !text-sm"
                    >
                      {activePlayers.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Action Type */}
                <div>
                  <label className="field-label">Action</label>
                  <select
                    value={permAction}
                    onChange={(e) => setPermAction(e.target.value as any)}
                    className="field !py-2.5 !text-sm"
                  >
                    <option value="draw">Draw a card</option>
                    <option value="discard">Discard a card</option>
                  </select>
                </div>

                {/* Quantity */}
                <div>
                  <label className="field-label">How many</label>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    value={permCount}
                    onChange={(e) => setPermCount(parseInt(e.target.value) || 1)}
                    className="field !py-2.5 !text-sm"
                  />
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col sm:flex-row gap-3 pt-1">
                <button
                  onClick={handleIssuePermission}
                  className={`flex-1 !py-4 ${permAction === 'draw' ? 'btn-cyan' : 'btn-danger'}`}
                >
                  <Token
                    tone={permAction === 'draw' ? 'gold' : 'paper'}
                    size="xs"
                    label={permAction === 'draw' ? '+' : '−'}
                    className="!ring-2"
                  />
                  Open {permAction} window ×{permCount}
                </button>

                {windowOpen && (
                  <button onClick={handleCloseWindow} className="btn-paper !py-4 sm:!px-5 !text-sm">
                    Close window & auto-draw
                  </button>
                )}
              </div>
            </div>

            {/* Player Cards Grid */}
            <div className="space-y-4">
              {players.length === 0 ? (
                <div className="path-dashed p-10 text-center">
                  <Token tone="paper" size="lg" icon={Users} className="mx-auto mb-3 opacity-70" />
                  <h3 className="font-display text-base font-extrabold text-ink-700">Nobody on the board yet</h3>
                  <p className="text-xs font-semibold text-ink-500 max-w-xs mx-auto mt-1">
                    Players who enter join code{' '}
                    <strong className="code-stamp">{roomCode}</strong> on their phones show up here live.
                  </p>
                </div>
              ) : (
                <div className="panel overflow-hidden">
                  <div className="px-4 sm:px-5 py-3.5 path-strip flex items-center justify-between gap-3 border-b-[3px] border-ink-900">
                    <div className="flex items-center gap-2">
                      <h3 className="font-display text-base font-extrabold text-ink-800">Players</h3>
                      <PaperChip tone="paper">{activePlayers.length} active</PaperChip>
                    </div>
                    <PaperChip tone={actedCount === activePlayers.length ? 'leaf' : 'gold'}>
                      {actedCount} / {activePlayers.length} drawn
                    </PaperChip>
                  </div>

                  <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {players.map((player) => (
                      <div
                        key={player.id}
                        className={`slab p-4 transition-transform hover:-translate-y-0.5 ${
                          player.active ? 'shadow-sticker-sm' : 'opacity-55 grayscale'
                        }`}
                      >
                        {/* Player Row Header */}
                        <div className="flex items-start justify-between gap-2 mb-3">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <Standee name={player.name} size="sm" muted={!player.active} />
                            <div className="min-w-0">
                              <h4 className="font-display text-sm font-extrabold text-ink-800 truncate flex items-center gap-1.5">
                                {player.name}
                                {!player.active && (
                                  <span className="chip !px-1.5 !py-0 bg-pip-red text-white !text-[10px]">
                                    Removed
                                  </span>
                                )}
                              </h4>
                              <p className="text-[11px] code-stamp">{player.player_code}</p>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            {player.active ? (
                              <>
                                <button
                                  onClick={() => {
                                    setSelectedPlayer(player);
                                    setShowGrantModal(true);
                                  }}
                                  className="btn-icon !w-8 !h-8 hover:!bg-pip-leaf"
                                  title="Grant a specific card"
                                >
                                  <Plus className="w-4 h-4" strokeWidth={3} />
                                </button>
                                <button
                                  onClick={() => handleRemovePlayer(player.id)}
                                  className="btn-icon !w-8 !h-8 hover:!bg-pip-red hover:!text-white"
                                  title="Remove player"
                                >
                                  <UserX className="w-4 h-4" strokeWidth={2.75} />
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => handleRestorePlayer(player.id)}
                                className="btn-icon !w-8 !h-8 hover:!bg-pip-leaf"
                                title="Restore player"
                              >
                                <UserCheck className="w-4 h-4" strokeWidth={2.75} />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Player Hand Thumbnails */}
                        <div className="space-y-1.5">
                          <p className="font-display font-bold text-[11px] uppercase tracking-wide text-ink-400">
                            Hand ({player.hand.length})
                          </p>
                          {player.hand.length === 0 ? (
                            <p className="text-xs font-semibold text-ink-400 italic">Empty</p>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {player.hand.map((h) => (
                                <span
                                  key={h.held_card_id}
                                  className={`chip ${h.source === 'grant' ? 'bg-pip-leaf' : 'bg-white'}`}
                                >
                                  <span className="truncate max-w-[110px]">{h.title}</span>
                                  {player.active && (
                                    <button
                                      onClick={() => handleRevokeCard(player.id, h.held_card_id)}
                                      className="text-ink-500 hover:text-pip-red"
                                      title="Revoke card"
                                    >
                                      <X className="w-3 h-3" strokeWidth={3} />
                                    </button>
                                  )}
                                </span>
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
            <div className="panel p-5 flex flex-wrap items-center justify-between gap-3">
              <BoardHeading
                icon={Layers}
                tone="violet"
                title="Card catalog"
                subtitle="Which cards are in the deck, and how often they turn up"
              />
              <button onClick={fetchRoomData} className="btn-paper !py-2.5 !px-4 !text-xs">
                <RefreshCw className="w-4 h-4" strokeWidth={2.75} /> Refresh
              </button>
            </div>

            {/* Card Weights Table */}
            <div className="panel overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[520px]">
                  <thead>
                    <tr className="path-strip border-b-[3px] border-ink-900 font-display text-[11px] font-extrabold text-ink-700 uppercase tracking-wide">
                      <th className="py-3 px-4">Card</th>
                      <th className="py-3 px-4">Artwork path</th>
                      <th className="py-3 px-4 text-center">Weight</th>
                      <th className="py-3 px-4 text-right">Odds</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs">
                    {cards.map((card) => {
                      const prob = totalWeight > 0 ? ((card.weight / totalWeight) * 100).toFixed(1) : '0.0';
                      return (
                        <tr
                          key={card.id}
                          className="border-b-2 border-dashed border-ink-900/15 last:border-0 hover:bg-parchment-100"
                        >
                          <td className="py-3 px-4 font-display font-extrabold text-sm text-ink-800">
                            {card.title}
                          </td>
                          <td className="py-3 px-4 font-mono text-[11px] text-ink-400 truncate max-w-[220px]">
                            {card.image_path}
                          </td>
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
                              className="field !w-16 !px-2 !py-1 !text-center font-display font-extrabold"
                            />
                          </td>
                          <td className="py-3 px-4 text-right">
                            <span className="chip bg-pip-cyan font-mono">{prob}%</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Direct Grant Card Modal */}
      {showGrantModal && selectedPlayer && (
        <div className="board-scrim">
          <div className="panel max-w-sm w-full p-6 animate-pop">
            <button
              onClick={() => setShowGrantModal(false)}
              className="btn-icon !w-8 !h-8 absolute top-3 right-3"
            >
              <X className="w-4 h-4" strokeWidth={3} />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <Token tone="leaf" size="md" icon={Plus} />
              <div className="min-w-0">
                <h3 className="font-display text-lg font-extrabold text-ink-800 leading-tight truncate">
                  Grant a card
                </h3>
                <p className="text-xs font-semibold text-ink-500 truncate">
                  Straight into {selectedPlayer.name}'s hand
                </p>
              </div>
            </div>

            <div className="mb-6">
              <label className="field-label">Choose card</label>
              <select
                value={selectedGrantCardId}
                onChange={(e) => setSelectedGrantCardId(e.target.value)}
                className="field !py-2.5 !text-sm"
              >
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} (weight {c.weight})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-2">
              <button onClick={() => setShowGrantModal(false)} className="btn-paper flex-1 !py-2.5 !text-xs">
                Cancel
              </button>
              <button
                onClick={() => handleGrantCard(selectedPlayer.id)}
                className="btn-leaf flex-1 !py-2.5 !text-xs"
              >
                Grant card
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
