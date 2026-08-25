import React, { useState, useEffect } from 'react';
import {
  Key, User, Layers, WifiOff, AlertTriangle, CheckCircle,
  Trash2, X, Copy, ShieldAlert, ArrowLeft, ArrowRight, Plus, Minus, LogOut, Zap,
  ChevronDown, Check, Hash, Star,
} from 'lucide-react';
import { CardView } from '../components/CardView';
import { Token, Standee } from '../components/BoardBits';
import { supabase, isDemoMode, ensureAuthSession, getAvatarUrl, listAvatarPaths } from '../lib/supabase';
import { CardKind, DrawPool, EventDraw, HeldCard } from '../types/database';
import { CODENAME_OPTIONS, RACE_OPTIONS, REASON_OPTIONS } from '../lib/profile';
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

// The rejoin codes the demo build pretends to know about.
const DEMO_REJOIN_CODES = ['K7M4QP', 'K7M-4QP', 'DEMO12'];

/** Everything the information collection form asks a new player for. */
interface NewPlayerProfile {
  name: string;
  race: string;
  codename: string;
  reason: string;
  avatarPath: string;
}

/** The first unanswered question on the form, phrased as a prompt, or null
 *  once the whole thing is filled in. Drives both the submit button's
 *  disabled state and the message shown if a keyboard submit slips past it. */
const missingProfileField = (profile: NewPlayerProfile): string | null => {
  if (!profile.avatarPath) return 'Pick a profile icon.';
  if (!profile.name.trim()) return 'Display name is required for new players.';
  if (!profile.race) return 'Choose a race.';
  if (!profile.codename) return 'Choose a codename.';
  if (!profile.reason) return 'Choose a reason for applying.';
  return null;
};

// enter_room's failures, phrased for the person holding the phone.
const joinErrorMessage = (error: { code?: string; message: string }): string => {
  if (error.code === 'P0003' || error.message.includes('invalid_player_code')) {
    return "That rejoin code isn't valid for this room.";
  }
  if (error.code === 'P0004' || error.message.includes('room_not_found')) {
    return 'No table is using that room code. Check it with your host.';
  }
  if (error.code === 'P0006' || error.message.includes('player_removed')) {
    return 'Your host removed you from this table.';
  }
  if (error.code === 'P0027' || error.message.includes('profile_required')) {
    return 'Please fill in every part of the form before submitting.';
  }
  if (error.code === 'P0018' || error.message.includes('name_taken')) {
    return 'Someone in this room is already using that name. Please pick another one.';
  }
  return error.message;
};

// name_required is enter_room's way of saying "the room is real, but this is
// a new player" -- which is exactly the answer the codes screen is after.
const isNameRequired = (error: { code?: string; message: string }): boolean =>
  error.code === 'P0005' || error.message.includes('name_required');

/** One dropdown on the information collection form. A native select rather
 *  than a styled menu: it is the control phones already know how to open, and
 *  the option lists are long enough that a hand-rolled popover would be one
 *  more thing to get wrong on a small screen. */
const SelectField: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  options: readonly string[];
}> = ({ label, value, onChange, placeholder, options }) => (
  <div>
    <label className="field-label">
      {label} <span className="text-pip-red">*</span>
    </label>
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`field appearance-none pr-11 cursor-pointer ${value ? '' : 'text-ink-400/70'}`}
        required
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((option) => (
          <option key={option} value={option} className="text-ink-800">
            {option}
          </option>
        ))}
      </select>
      <ChevronDown
        className="w-4 h-4 text-ink-400 absolute right-4 top-4 pointer-events-none"
        strokeWidth={2.75}
      />
    </div>
  </div>
);

export const PlayerApp: React.FC = () => {
  // Session & Player state
  const [roomCode, setRoomCode] = useState('');
  const [rejoinCodeInput, setRejoinCodeInput] = useState('');
  const [playerName, setPlayerName] = useState('');
  // The rest of the information collection form. Every one of these is
  // required of a new player, so they start empty rather than pre-picked --
  // a pre-picked race is one nobody chose but everybody submits.
  const [playerRace, setPlayerRace] = useState('');
  const [playerCodename, setPlayerCodename] = useState('');
  const [playerReason, setPlayerReason] = useState('');
  const [avatarPath, setAvatarPath] = useState('');
  const [avatarChoices, setAvatarChoices] = useState<string[]>([]);
  const [avatarsLoading, setAvatarsLoading] = useState(false);
  // The join screen asks for codes first and only asks for a name once the
  // codes say this is somebody the room has never seen.
  const [joinStep, setJoinStep] = useState<'codes' | 'name'>('codes');
  const [isJoining, setIsJoining] = useState(false);
  const [joinedPlayer, setJoinedPlayer] = useState<{
    id: string;
    name: string;
    player_code: string;
    room_code: string;
    avatar_path?: string | null;
    codename?: string | null;
    points?: number;
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
  const [copiedField, setCopiedField] = useState<'rejoin' | 'room' | null>(null);
  // The host-set table name ("Table 3"), shown next to the room code. Comes
  // back from enter_room alongside the player, not from the join form.
  const [roomLabel, setRoomLabel] = useState('');

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

  // The icons on offer are whatever is in the avatars bucket, so they are
  // fetched when the form opens rather than at boot -- a returning player
  // goes straight from the codes screen to their hand and never needs them.
  useEffect(() => {
    if (joinStep !== 'name' || avatarChoices.length > 0) return;

    let cancelled = false;
    setAvatarsLoading(true);
    listAvatarPaths()
      .then((paths) => {
        if (cancelled) return;
        setAvatarChoices(paths);
        // Nothing is pre-selected: picking an icon is part of the form.
      })
      .finally(() => {
        if (!cancelled) setAvatarsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [joinStep, avatarChoices.length]);

  // Leave / Reset Room Session
  const handleLeaveRoom = () => {
    localStorage.removeItem('lyney_player_session');
    setJoinedPlayer(null);
    setRoomLabel('');
    setJoinStep('codes');
    setRejoinCodeInput('');
    setPlayerName('');
    setPlayerRace('');
    setPlayerCodename('');
    setPlayerReason('');
    setAvatarPath('');
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
      // The host can nudge points from their console at any time -- a plain
      // rejoin already returns the player's current row, so a refresh is
      // enough to pick up a change without a dedicated realtime channel.
      // Bail out when the value hasn't actually moved: spreading into a new
      // object on every refresh -- even a no-op one -- would change identity
      // on each poll, and the subscription effect below keys off this same
      // object, so an unconditional update here would retrigger it forever.
      if (typeof data?.player?.points === 'number') {
        setJoinedPlayer((prev) =>
          prev && prev.points !== data.player.points ? { ...prev, points: data.player.points } : prev
        );
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

  // The host-set table name. enter_room doesn't carry it -- it only knows the
  // player -- so it's a separate, one-off read straight off the rooms table
  // (label only; host_pin is never selected).
  const fetchRoomLabel = async (rCode: string) => {
    if (isDemoMode) return;
    try {
      const { data, error } = await supabase.from('rooms').select('label').eq('code', rCode).maybeSingle();
      if (!error && data?.label) setRoomLabel(data.label);
    } catch (err) {
      console.error('Error fetching room label:', err);
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
      fetchRoomLabel(room_code);

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
    // Keyed on the identity fields alone, not the joinedPlayer object itself:
    // fetchPlayerData patches joinedPlayer.points on every refresh this effect
    // triggers, and depending on the whole object would mean each refresh
    // re-subscribes and immediately refreshes again -- a self-sustaining loop
    // of realtime resubscribes and Supabase calls.
  }, [joinedPlayer?.id, joinedPlayer?.room_code, joinedPlayer?.player_code]);

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

  // The enter_room call behind both join steps. A rejoin sends codes alone --
  // the server ignores profile arguments for a player it already knows, and
  // the returning player was never asked for them.
  const submitJoin = async (cleanRoom: string, cleanRejoin: string, profile?: NewPlayerProfile) => {
    const { data, error } = await supabase.rpc('enter_room', {
      p_room_code: cleanRoom,
      p_player_code: cleanRejoin || null,
      p_name: profile?.name || null,
      p_race: profile?.race || null,
      p_codename: profile?.codename || null,
      p_reason: profile?.reason || null,
      p_avatar_path: profile?.avatarPath || null,
    });

    if (error) {
      setErrorMsg(joinErrorMessage(error));
      return;
    }

    const pData = data.player;
    setJoinedPlayer(pData);
    setHand(data.hand || []);
    setLastEvent(data.last_event ?? null);
    localStorage.setItem('lyney_player_session', JSON.stringify({ player: pData }));
    fetchRoomLabel(pData.room_code);
    runPreload();
  };

  // Demo mode has no server to ask, so it seats whoever turns up.
  const finishDemoJoin = (cleanRoom: string, cleanRejoin: string, profile?: NewPlayerProfile) => {
    const playerObj = {
      id: 'p-100',
      name: profile?.name || 'Player One',
      player_code: cleanRejoin || 'K7M4QP',
      room_code: cleanRoom,
      avatar_path: profile?.avatarPath ?? null,
      codename: profile?.codename ?? null,
      points: 5,
    };

    setJoinedPlayer(playerObj);
    setRoomLabel('Demo Table');
    localStorage.setItem('lyney_player_session', JSON.stringify({ player: playerObj }));
    runPreload();
  };

  // Step 1 of the join: the codes, and nothing else. A rejoin code identifies
  // the player on its own, so returning players go straight in and never
  // retype the name the host already has for them -- retyping it was how the
  // same person ended up seated twice. Only a join code with no rejoin code
  // moves on to the name screen.
  const handleCodesSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const cleanRoom = roomCode.trim().toUpperCase();
    const cleanRejoin = rejoinCodeInput.trim().toUpperCase();

    if (!cleanRoom) {
      setErrorMsg('Please enter the room code for your table.');
      return;
    }

    if (isDemoMode) {
      if (!cleanRejoin) {
        setJoinStep('name');
        return;
      }
      if (!DEMO_REJOIN_CODES.includes(cleanRejoin)) {
        setErrorMsg("That rejoin code isn't valid for this room.");
        return;
      }
      finishDemoJoin(cleanRoom, cleanRejoin);
      return;
    }

    setIsJoining(true);
    try {
      await ensureAuthSession();

      if (cleanRejoin) {
        await submitJoin(cleanRoom, cleanRejoin);
        return;
      }

      // No rejoin code: check the join code before asking for a name, so a
      // mistyped room is caught on the screen that owns that field rather
      // than after the player has thought one up. enter_room checks the room
      // first and answers name_required once it knows the room is real.
      const { error } = await supabase.rpc('enter_room', {
        p_room_code: cleanRoom,
        p_player_code: null,
        p_name: null,
      });

      if (error && !isNameRequired(error)) {
        setErrorMsg(joinErrorMessage(error));
        return;
      }

      setJoinStep('name');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to enter room.');
    } finally {
      setIsJoining(false);
    }
  };

  // Step 2 of the join: the information collection form, reached only by a
  // join code with no rejoin code -- that is, by a player this room has never
  // seated before. Everything here is asked once and kept; a returning player
  // never sees this screen.
  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const cleanRoom = roomCode.trim().toUpperCase();
    const profile: NewPlayerProfile = {
      name: playerName.trim(),
      race: playerRace,
      codename: playerCodename,
      reason: playerReason,
      avatarPath: avatarPath,
    };

    // The submit button is disabled until the form is complete, so this only
    // catches a keyboard submit that got past it.
    const missing = missingProfileField(profile);
    if (missing) {
      setErrorMsg(missing);
      return;
    }

    if (isDemoMode) {
      finishDemoJoin(cleanRoom, '', profile);
      return;
    }

    setIsJoining(true);
    try {
      await ensureAuthSession();
      await submitJoin(cleanRoom, '', profile);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to enter room.');
    } finally {
      setIsJoining(false);
    }
  };

  // Back out of the form to the codes.
  const handleBackToCodes = () => {
    setErrorMsg(null);
    setJoinStep('codes');
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

  const copyCode = (field: 'rejoin' | 'room', value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField((current) => (current === field ? null : current)), 2000);
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
          <h2 className="font-display text-2xl font-extrabold text-ink-800 mb-1">
            {joinStep === 'codes' ? 'Take your seat' : 'Information Collection Form'}
          </h2>
          <p className="text-xs font-semibold text-ink-500 mb-5">
            {joinStep === 'codes'
              ? "Enter your table's room code to see your live hand."
              : `New at table ${roomCode} — tell your host who is joining them.`}
          </p>

          {errorMsg && (
            <div className="mb-5 p-3 slab !border-pip-red bg-pip-red/10 text-crimson-700 text-xs font-bold flex items-center gap-2.5 animate-shake">
              <Token tone="gold" size="xs" icon={AlertTriangle} />
              <span>{errorMsg}</span>
            </div>
          )}

          {joinStep === 'codes' ? (
            <form onSubmit={handleCodesSubmit} className="space-y-4" autoComplete="off">
              <div>
                <label className="field-label">
                  Room code <span className="text-pip-red">*</span>
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
                <p className="mt-2 text-[11px] font-semibold text-ink-400">
                  First time at this table? Leave this blank — we'll ask for your name next.
                </p>
              </div>

              <button
                type="submit"
                disabled={isJoining}
                className="btn-crimson w-full !py-4 text-base mt-1 disabled:opacity-60"
              >
                {rejoinCodeInput.trim() ? 'Enter room' : 'Continue'}{' '}
                <ArrowRight className="w-4 h-4" strokeWidth={3} />
              </button>
            </form>
          ) : (
            <form onSubmit={handleProfileSubmit} className="space-y-4" autoComplete="off">
              {/* Profile icon: the host's uploaded set, laid out like pieces
                  waiting to be picked off the edge of the board. */}
              <div>
                <label className="field-label">
                  Profile icon <span className="text-pip-red">*</span>
                </label>
                {avatarsLoading ? (
                  <p className="text-xs font-semibold text-ink-400 py-3">Laying out the pieces…</p>
                ) : (
                  <div className="flex flex-wrap gap-3 py-1">
                    {avatarChoices.map((path) => {
                      const selected = avatarPath === path;
                      return (
                        <button
                          key={path}
                          type="button"
                          onClick={() => setAvatarPath(path)}
                          title={path}
                          aria-pressed={selected}
                          className={`relative rounded-full transition-transform ${
                            selected ? 'scale-105' : 'hover:scale-105 opacity-80 hover:opacity-100'
                          }`}
                        >
                          <Token
                            tone={selected ? 'crimson' : 'paper'}
                            size="lg"
                            imageSrc={getAvatarUrl(path)}
                          />
                          {selected && (
                            <span className="absolute -bottom-0.5 -right-0.5 w-6 h-6 rounded-full bg-crimson-500 border-[2.5px] border-white flex items-center justify-center">
                              <Check className="w-3 h-3 text-white" strokeWidth={4} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <label className="field-label">
                  Name <span className="text-pip-red">*</span>
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
                    autoFocus
                    required
                  />
                  <User className="w-4 h-4 text-ink-400 absolute right-4 top-4" strokeWidth={2.75} />
                </div>
              </div>

              <SelectField
                label="Race"
                value={playerRace}
                onChange={setPlayerRace}
                placeholder="Select your race…"
                options={RACE_OPTIONS}
              />

              <SelectField
                label="Codename"
                value={playerCodename}
                onChange={setPlayerCodename}
                placeholder="Select a codename…"
                options={CODENAME_OPTIONS}
              />

              <SelectField
                label="Reason for Application"
                value={playerReason}
                onChange={setPlayerReason}
                placeholder="My reason for joining the organization is…"
                options={REASON_OPTIONS}
              />

              <button
                type="submit"
                disabled={isJoining || missingProfileField({
                  name: playerName,
                  race: playerRace,
                  codename: playerCodename,
                  reason: playerReason,
                  avatarPath,
                }) !== null}
                className="btn-crimson w-full !py-4 text-base mt-1 disabled:opacity-60"
              >
                Confirm submission <ArrowRight className="w-4 h-4" strokeWidth={3} />
              </button>

              <button
                type="button"
                onClick={handleBackToCodes}
                className="btn-paper w-full !py-3 text-sm"
              >
                <ArrowLeft className="w-4 h-4" strokeWidth={3} /> Back to codes
              </button>
            </form>
          )}
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

      {/* App Header. Right-padded past px-4 so its content clears the
          floating hamburger button (fixed top-3 right-3, ~56px footprint)
          instead of sitting under it. */}
      <header className="sticky top-0 z-40 path-strip border-b-[3px] border-ink-900 pl-4 pr-16 py-3 flex items-center justify-between gap-3">
        {/* Left: who you are -- avatar, name, and a tap-to-copy chip for the
            code that gets you back here if this device loses the session. */}
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => setShowCodeModal(true)}
            title="View rejoin code"
            className="shrink-0"
          >
            <Standee
              name={joinedPlayer.name}
              size="lg"
              imageSrc={joinedPlayer.avatar_path ? getAvatarUrl(joinedPlayer.avatar_path) : undefined}
            />
          </button>
          <div className="min-w-0">
            <h2 className="font-display text-base font-extrabold text-ink-800 leading-tight truncate">
              {joinedPlayer.name}
            </h2>
            <div className="flex items-center gap-1.5 mt-1">
              <button
                type="button"
                onClick={() => copyCode('rejoin', joinedPlayer.player_code)}
                title="Tap to copy your rejoin code"
                className="chip bg-white code-stamp !text-[11px] hover:bg-parchment-100 transition-colors"
              >
                {copiedField === 'rejoin' ? (
                  <CheckCircle className="w-3 h-3 text-pip-leaf shrink-0" strokeWidth={2.75} />
                ) : (
                  <Key className="w-3 h-3 text-crimson-500 shrink-0" strokeWidth={2.75} />
                )}
                {joinedPlayer.player_code}
              </button>
              {typeof joinedPlayer.points === 'number' && (
                <span className="chip bg-pip-gold !text-[11px]" title="Your points">
                  <Star className="w-3 h-3 text-ink-900 shrink-0" strokeWidth={2.75} />
                  {joinedPlayer.points}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right: which table this is -- room name, and a tap-to-copy chip
            for the code that gets someone else onto it. */}
        <div className="flex flex-col items-end min-w-0 shrink-0">
          {roomLabel && (
            <h2 className="font-display text-base font-extrabold text-ink-800 leading-tight truncate max-w-[8rem]">
              {roomLabel}
            </h2>
          )}
          <button
            type="button"
            onClick={() => copyCode('room', joinedPlayer.room_code)}
            title="Tap to copy the room code"
            className="chip bg-white code-stamp !text-[11px] mt-1 hover:bg-parchment-100 transition-colors"
          >
            {copiedField === 'room' ? (
              <CheckCircle className="w-3 h-3 text-pip-leaf shrink-0" strokeWidth={2.75} />
            ) : (
              <Hash className="w-3 h-3 text-crimson-500 shrink-0" strokeWidth={2.75} />
            )}
            {joinedPlayer.room_code}
          </button>
        </div>
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

            <button
              onClick={() => copyCode('rejoin', joinedPlayer.player_code)}
              className="btn-paper w-full !py-2.5 !text-xs mb-2"
            >
              {copiedField === 'rejoin' ? (
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
