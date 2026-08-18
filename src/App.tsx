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
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Universal Top Switcher Bar */}
      <nav className="bg-slate-950 border-b border-slate-900 px-4 py-1.5 flex items-center justify-between text-xs text-slate-400 z-50">
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <span className="text-slate-500">Project:</span>
          <strong className="text-indigo-400">Lyney Card Companion</strong>
        </div>

        <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800 font-semibold">
          <button
            onClick={() => navigateTo('play')}
            className={`px-2.5 py-1 rounded flex items-center gap-1.5 transition-colors ${
              route === 'play' ? 'bg-indigo-600 text-white' : 'hover:text-slate-200'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" /> Player View (/play)
          </button>
          <button
            onClick={() => navigateTo('host')}
            className={`px-2.5 py-1 rounded flex items-center gap-1.5 transition-colors ${
              route === 'host' ? 'bg-amber-500 text-slate-950' : 'hover:text-slate-200'
            }`}
          >
            <Shield className="w-3.5 h-3.5" /> Host Console (/host)
          </button>
        </div>
      </nav>

      {/* Render Current Route */}
      {route === 'host' ? <HostDashboard /> : <PlayerApp />}
    </div>
  );
};

export default App;
