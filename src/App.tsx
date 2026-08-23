import React, { useEffect, useState } from 'react';
import { PlayerApp } from './pages/PlayerApp';
import { HostDashboard } from './pages/HostDashboard';
import { Gallery } from './pages/Gallery';
import { Menu, X } from 'lucide-react';

type Route = 'play' | 'host' | 'gallery';

const routeForPath = (path: string): Route => {
  if (path.startsWith('/host')) return 'host';
  if (path.startsWith('/gallery')) return 'gallery';
  return 'play';
};

const NAV_ITEMS: Array<{ route: Route; label: string }> = [
  { route: 'play', label: 'Player' },
  { route: 'host', label: 'Host' },
  { route: 'gallery', label: 'Gallery' },
];

export const App: React.FC = () => {
  const [route, setRoute] = useState<Route>('play');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setRoute(routeForPath(window.location.pathname));

    const handlePopState = () => {
      setRoute(routeForPath(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // The overlay takes over the whole screen, so it gets the same courtesies
  // as a real menu: Escape closes it, and the board underneath stops
  // scrolling while it's open.
  useEffect(() => {
    if (!menuOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [menuOpen]);

  const navigateTo = (newRoute: Route) => {
    setRoute(newRoute);
    setMenuOpen(false);
    const newPath = newRoute === 'host' ? '/host' : newRoute === 'gallery' ? '/gallery' : '/play';
    window.history.pushState({}, '', newPath);
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Floating menu trigger. `fixed` takes it out of the document flow
          entirely -- there is no bar reserving a strip of the page for it,
          it just sits on top of whatever the current screen renders, like a
          token dropped on the board. Hidden while the overlay is open so it
          doesn't double up with the overlay's own close button in the same
          corner. */}
      {!menuOpen && (
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          className="fixed top-3 right-3 z-50 w-11 h-11 rounded-full bg-ink-900 text-parchment-100
                     ring-[3px] ring-white shadow-token flex items-center justify-center
                     transition-transform hover:scale-105 active:scale-95"
        >
          <Menu className="w-5 h-5" strokeWidth={2.75} />
        </button>
      )}

      {/* Nav Overlay — one dark screen, centered, over everything. */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-1
                     bg-ink-900/95 backdrop-blur-sm px-6 animate-pop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMenuOpen(false);
          }}
        >
          <button
            type="button"
            onClick={() => setMenuOpen(false)}
            aria-label="Close menu"
            className="fixed top-3 right-3 w-11 h-11 rounded-full bg-crimson-500 text-parchment-50
                       ring-[3px] ring-white shadow-token flex items-center justify-center
                       transition-transform hover:scale-105 active:scale-95"
          >
            <X className="w-5 h-5" strokeWidth={3} />
          </button>

          <span className="font-display font-bold text-xs uppercase tracking-[0.3em] text-parchment-200/50 mb-3">
            Lyney Menu
          </span>

          <nav className="flex flex-col items-center">
            {NAV_ITEMS.map((item) => {
              const active = route === item.route;
              return (
                <button
                  key={item.route}
                  type="button"
                  onClick={() => navigateTo(item.route)}
                  aria-current={active ? 'page' : undefined}
                  className={`font-display font-extrabold uppercase tracking-tight leading-[1.15]
                              text-5xl sm:text-6xl py-1.5 transition-colors
                              ${active
                                ? 'text-pip-gold'
                                : 'text-parchment-100 hover:text-pip-cyan'}`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          <p className="mt-8 font-display font-bold text-[11px] uppercase tracking-[0.2em] text-parchment-200/30">
            Card companion · NUSCASuals
          </p>
        </div>
      )}

      {/* Render Current Route */}
      {route === 'host' ? <HostDashboard /> : route === 'gallery' ? <Gallery /> : <PlayerApp />}
    </div>
  );
};

export default App;
