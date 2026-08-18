import React, { useState, useEffect } from 'react';
import { AlertCircle, RefreshCw, Sparkles, ZoomIn } from 'lucide-react';
import { getPublicStorageUrl } from '../lib/supabase';

interface CardViewProps {
  title: string;
  imagePath: string;
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
    <div
      className={`relative group aspect-[3/4] w-full max-w-[320px] rounded-xl overflow-hidden shadow-2xl border border-slate-800/80 bg-slate-900 flex flex-col justify-between select-none transition-all duration-300 transform hover:-translate-y-1 hover:shadow-indigo-500/10 ${className}`}
    >
      {/* Source Badge / Auto-drawn Badge */}
      {source === 'grant' && (
        <div className="absolute top-2 left-2 z-20 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/90 text-amber-950 backdrop-blur-md shadow-md flex items-center gap-1">
          <Sparkles className="w-3 h-3" /> Host Granted
        </div>
      )}
      {isNew && source === 'draw' && (
        <div className="absolute top-2 left-2 z-20 px-2.5 py-1 rounded-full text-xs font-semibold bg-indigo-500/90 text-white backdrop-blur-md shadow-md">
          New Card
        </div>
      )}

      {/* Card Image or Degraded State */}
      {loadState !== 'error' ? (
        <div className="relative w-full h-full">
          {loadState === 'loading' && (
            <div className="absolute inset-0 bg-slate-800 animate-pulse flex items-center justify-center text-slate-500 text-xs font-medium">
              Loading artwork...
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
        </div>
      ) : (
        /* Mandatory Degraded Fallback State */
        <div className="w-full h-full p-4 bg-gradient-to-b from-slate-900 via-slate-850 to-slate-950 flex flex-col justify-between items-center text-center border-2 border-dashed border-amber-500/40 rounded-xl">
          <div className="flex items-center gap-1.5 text-amber-400 text-xs font-bold tracking-wider uppercase mt-2">
            <AlertCircle className="w-4 h-4" /> Card Text Fallback
          </div>
          
          <div className="my-auto px-2">
            <h3 className="text-xl font-extrabold text-slate-100 leading-tight mb-2">
              {title}
            </h3>
            <p className="text-xs text-slate-400">
              Image payload unavailable. Title fallback displayed for gameplay continuity.
            </p>
          </div>

          <button
            onClick={handleRetry}
            className="w-full py-2 px-3 bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-amber-300 text-xs font-semibold rounded-lg flex items-center justify-center gap-2 border border-amber-500/30 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Tap to Retry Image
          </button>
        </div>
      )}

      {/* Interactive Overlays */}
      <div className="absolute inset-0 bg-slate-950/60 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col justify-between p-3 pointer-events-none group-hover:pointer-events-auto">
        <div className="flex justify-end">
          {onZoom && (
            <button
              onClick={onZoom}
              className="p-2 rounded-lg bg-slate-800/90 text-slate-200 hover:bg-slate-700 hover:text-white transition-colors"
              title="Zoom Card"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
          )}
        </div>

        {canDiscard && onDiscard && (
          <button
            onClick={onDiscard}
            className="w-full py-2 bg-rose-600/90 hover:bg-rose-500 text-white font-semibold text-xs rounded-lg shadow-lg backdrop-blur-md transition-colors"
          >
            Discard Card
          </button>
        )}
      </div>
    </div>
  );
};
