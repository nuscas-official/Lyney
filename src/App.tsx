import React, { useState, useEffect } from 'react';
import { PlayerApp } from './pages/PlayerApp';
import { HostDashboard } from './pages/HostDashboard';
import { Shield, Smartphone } from 'lucide-react';

export const App: React.FC = () => {
  const [route, setRoute] = useState<'play' | 'host'>('play');

  useEffect(() => {
    const path = window.location.pathname;
    if (path.startsWith('/host')) {
      setRoute('host');
    } else {
      setRoute('play');
    }

    const handlePopState = () => {
      if (window.location.pathname.startsWith('/host')) {
        setRoute('host');
      } else {
        setRoute('play');
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigateTo = (newRoute: 'play' | 'host') => {
    setRoute(newRoute);
    const newPath = newRoute === 'host' ? '/host' : '/play';
    window.history.pushState({}, '', newPath);
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Universal Top Switcher Bar — styled as the board's dark bezel */}
      <nav className="bg-ink-900 border-b-[3px] border-ink-900 px-3 py-2 flex items-center justify-center sm:justify-between z-50">
        <span className="hidden sm:flex items-center gap-2 font-display font-extrabold text-parchment-200 text-sm tracking-tight">
          <img src="/images/lyney.webp" alt="Lyney" className="w-6 h-6 rounded-full ring-2 ring-white object-cover" />
          Lyney
        </span>

        <div className="flex items-center gap-1 p-1 rounded-2xl bg-ink-800 border-[2.5px] border-ink-700">
          <button
            onClick={() => navigateTo('play')}
            className={`px-3 py-1.5 rounded-xl flex items-center gap-1.5 font-display font-bold text-xs transition-colors ${
              route === 'play'
                ? 'bg-pip-cyan text-ink-900 shadow-sticker-sm'
                : 'text-parchment-200/70 hover:text-parchment-100'
            }`}
          >
            <img src="/images/lyney.webp" alt="" className="w-4 h-4 rounded-full object-cover" /> Player
          </button>
          <button
            onClick={() => navigateTo('host')}
            className={`px-3 py-1.5 rounded-xl flex items-center gap-1.5 font-display font-bold text-xs transition-colors ${
              route === 'host'
                ? 'bg-pip-gold text-ink-900 shadow-sticker-sm'
                : 'text-parchment-200/70 hover:text-parchment-100'
            }`}
          >
            <img src="/images/lynette.webp" alt="" className="w-4 h-4 rounded-full object-cover" /> Host
          </button>
        </div>
      </nav>

      {/* Render Current Route */}
      {route === 'host' ? <HostDashboard /> : <PlayerApp />}
    </div>
  );
};

export default App;
