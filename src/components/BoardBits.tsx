import React from 'react';
import { LucideIcon } from 'lucide-react';

/* ==========================================================================
   BOARD BITS
   The small physical vocabulary of the CAS board, as components:
   pickup tokens (+10 / -10 / ! / potion), player standees, and paper chips.
   Everything here is drawn thick and ringed in white so it reads as a piece
   sitting ON the board rather than an icon floating in a UI.
   ========================================================================== */

export type TokenTone = 'cyan' | 'red' | 'gold' | 'leaf' | 'violet' | 'crimson' | 'paper';

const TONE_FILL: Record<TokenTone, string> = {
  cyan:    'bg-pip-cyan',
  red:     'bg-pip-red text-white',
  gold:    'bg-pip-gold',
  leaf:    'bg-pip-leaf',
  violet:  'bg-pip-violet text-white',
  crimson: 'bg-crimson-500 text-parchment-50',
  paper:   'bg-parchment-100 text-ink-700',
};

const SIZE: Record<'xs' | 'sm' | 'md' | 'lg', { box: string; icon: string; text: string }> = {
  xs: { box: 'w-6 h-6',   icon: 'w-3 h-3',     text: 'text-[10px]' },
  sm: { box: 'w-8 h-8',   icon: 'w-4 h-4',     text: 'text-xs' },
  md: { box: 'w-11 h-11', icon: 'w-5 h-5',     text: 'text-sm' },
  lg: { box: 'w-16 h-16', icon: 'w-7 h-7',     text: 'text-lg' },
};

interface TokenProps {
  tone?: TokenTone;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  imageSrc?: string;
  /** Short text instead of an icon, e.g. "+1" or "!" */
  label?: string;
  className?: string;
  title?: string;
}

/** A pickup token lifted straight off the board. */
export const Token: React.FC<TokenProps> = ({
  tone = 'cyan',
  size = 'md',
  icon: Icon,
  imageSrc,
  label,
  className = '',
  title,
}) => {
  const s = SIZE[size];
  return (
    <span
      title={title}
      className={`token ${TONE_FILL[tone]} ${s.box} ${s.text} ${className} overflow-hidden`}
    >
      {imageSrc ? (
        <img src={imageSrc} alt="" className="w-full h-full object-cover rounded-full" />
      ) : Icon ? (
        <Icon className={s.icon} strokeWidth={2.75} />
      ) : (
        label
      )}
    </span>
  );
};

/* -------------------------------------------------------------------------- */

const STANDEE_TONES = [
  'bg-pip-cyan',
  'bg-pip-gold',
  'bg-pip-leaf',
  'bg-pip-violet',
  'bg-crimson-400 text-parchment-50',
  'bg-pip-red text-white',
];

/** Deterministic color per name, so a player keeps the same piece all night. */
const toneForName = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 997;
  return STANDEE_TONES[h % STANDEE_TONES.length];
};

interface StandeeProps {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  muted?: boolean;
  className?: string;
}

/** A player's piece: initial on a colored disc inside a thick white ring,
 *  mirroring the character portraits ringed around the board. */
export const Standee: React.FC<StandeeProps> = ({ name, size = 'md', muted, className = '' }) => {
  const s = SIZE[size === 'lg' ? 'lg' : size];
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return (
    <span
      className={`token ${toneForName(name)} ${s.box} ${size === 'lg' ? 'text-xl' : 'text-base'}
                  ${muted ? 'grayscale opacity-60' : ''} ${className}`}
    >
      {initial}
    </span>
  );
};

/* -------------------------------------------------------------------------- */

interface PaperChipProps {
  children: React.ReactNode;
  tone?: TokenTone;
  icon?: LucideIcon;
  className?: string;
}

/** A printed label chip — used for counts, statuses and codes. */
export const PaperChip: React.FC<PaperChipProps> = ({
  children,
  tone = 'paper',
  icon: Icon,
  className = '',
}) => (
  <span className={`chip ${TONE_FILL[tone]} ${className}`}>
    {Icon && <Icon className="w-3.5 h-3.5" strokeWidth={2.75} />}
    {children}
  </span>
);

/* -------------------------------------------------------------------------- */

/** Section heading styled like a marker label written on the board. */
export const BoardHeading: React.FC<{
  icon?: LucideIcon;
  tone?: TokenTone;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}> = ({ icon, tone = 'gold', title, subtitle, right }) => (
  <div className="flex items-center justify-between gap-3">
    <div className="flex items-center gap-3 min-w-0">
      {icon && <Token tone={tone} size="md" icon={icon} />}
      <div className="min-w-0">
        <h2 className="font-display text-lg font-extrabold text-ink-800 leading-tight truncate">
          {title}
        </h2>
        {subtitle && <p className="text-xs font-semibold text-ink-500 truncate">{subtitle}</p>}
      </div>
    </div>
    {right}
  </div>
);
