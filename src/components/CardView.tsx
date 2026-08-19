import React, { useState, useEffect } from 'react';
import { AlertCircle, RefreshCw, FlaskConical, ZoomIn, Trash2 } from 'lucide-react';
import { getPublicStorageUrl } from '../lib/supabase';
import { Token } from './BoardBits';
import { KIND_LABEL, KIND_TONE } from '../lib/pools';
import { CardKind } from '../types/database';

interface CardViewProps {
  title: string;
  imagePath: string;
  kind?: CardKind;
  source?: 'draw' | 'grant';
  isNew?: boolean;
  onDiscard?: () => void;
  canDiscard?: boolean;
  onZoom?: () => void;
  className?: string;
}

export const CardView: React.FC<CardViewProps> = ({
  title,
  imagePath,
  kind,
  source,
  isNew,
  onDiscard,
  canDiscard = false,
  onZoom,
  className = '',
}) => {
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [retryCount, setRetryCount] = useState(0);
  const imageUrl = getPublicStorageUrl(imagePath);

  useEffect(() => {
    setLoadState('loading');
  }, [imagePath, retryCount]);

  const handleRetry = () => {
    setRetryCount((prev) => prev + 1);
  };

  // Exponential auto-retry on load error
  useEffect(() => {
    if (loadState === 'error' && retryCount < 5) {
      const timer = setTimeout(() => {
        setRetryCount((prev) => prev + 1);
      }, Math.pow(2, retryCount) * 1000);
      return () => clearTimeout(timer);
    }
  }, [loadState, retryCount]);

  return (
    /* The card is a pinned polaroid: crimson frame, white mat, title printed
       on the bottom lip the way the board's photo cut-outs read. */
    <div
      className={`frame group w-full max-w-[320px] flex flex-col select-none
                  transition-transform duration-200 hover:-translate-y-1.5 hover:rotate-[-1deg] ${className}`}
    >
      <div className="relative aspect-[3/4] w-full rounded-[0.7rem] overflow-hidden bg-parchment-100">
        {/* Group and source tokens, stacked on the frame like board pickups */}
        <div className="absolute top-2 left-2 z-20 flex flex-col gap-1.5">
          {kind && (
            <Token
              tone={KIND_TONE[kind]}
              size="sm"
              label={KIND_LABEL[kind].charAt(0)}
              title={`${KIND_LABEL[kind]} card`}
            />
          )}
          {source === 'grant' && (
            <Token tone="leaf" size="sm" icon={FlaskConical} title="Granted by host" />
          )}
          {isNew && source === 'draw' && (
            <Token tone="cyan" size="sm" label="NEW" title="Just drawn" className="!text-[9px]" />
          )}
        </div>

        {/* Card Image or Degraded State */}
        {loadState !== 'error' ? (
          <>
            {loadState === 'loading' && (
              <div className="absolute inset-0 bg-parchment-200 animate-pulse flex items-center justify-center font-display font-bold text-ink-500 text-xs">
                Loading artwork…
              </div>
            )}
            <img
              src={imageUrl}
              alt={title}
              onLoad={() => setLoadState('loaded')}
              onError={() => setLoadState('error')}
              className={`w-full h-full object-cover transition-opacity duration-300 ${
                loadState === 'loaded' ? 'opacity-100' : 'opacity-0'
              }`}
            />
          </>
        ) : (
          /* Mandatory Degraded Fallback State — a hand-written replacement tile */
          <div className="w-full h-full p-4 bg-parchment-100 flex flex-col justify-between items-center text-center">
            <div className="flex items-center gap-1.5 font-display font-bold text-xs uppercase tracking-wide text-crimson-600">
              <AlertCircle className="w-4 h-4" strokeWidth={2.75} /> Text Fallback
            </div>

            <div className="my-auto px-1">
              <h3 className="font-display text-xl font-extrabold text-ink-800 leading-tight mb-1.5">
                {title}
              </h3>
              <p className="text-[11px] font-semibold text-ink-500">
                Artwork didn't load — the title stands in so play can continue.
              </p>
            </div>

            <button onClick={handleRetry} className="btn-paper w-full !py-2 !text-xs">
              <RefreshCw className="w-3.5 h-3.5" strokeWidth={2.75} /> Tap to retry
            </button>
          </div>
        )}

        {/* Interactive Overlays */}
        <div className="absolute inset-0 bg-ink-900/55 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-200 flex flex-col justify-between p-2.5 pointer-events-none group-hover:pointer-events-auto focus-within:pointer-events-auto">
          <div className="flex justify-end">
            {onZoom && (
              <button onClick={onZoom} className="btn-icon !w-8 !h-8" title="Zoom card">
                <ZoomIn className="w-4 h-4" strokeWidth={2.75} />
              </button>
            )}
          </div>

          {canDiscard && onDiscard && (
            <button onClick={onDiscard} className="btn-danger w-full !py-2 !text-xs">
              <Trash2 className="w-3.5 h-3.5" strokeWidth={2.75} /> Discard
            </button>
          )}
        </div>
      </div>

      {/* Printed title lip */}
      <p className="px-1.5 pt-2 pb-0.5 font-display font-extrabold text-sm text-ink-800 text-center leading-tight truncate">
        {title}
      </p>
    </div>
  );
};
