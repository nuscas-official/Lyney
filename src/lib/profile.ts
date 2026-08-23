/* ==========================================================================
   PLAYER PROFILE
   The fixed lists behind the information collection form. These are flavour,
   not data the rest of the app reasons about -- rewrite them freely between
   events. The values are stored on the player verbatim, so changing a label
   here does not rewrite what an already-seated player chose.
   ========================================================================== */

export const RACE_OPTIONS = [
  'Primogem',
  'Human',
  'Adeptus',
  'Fatui Agent',
  'Elemental Life-Form',
  'Automaton',
  'Hilichurl',
  'Slime',
  'Classified',
] as const;

export const CODENAME_OPTIONS = [
  'The 12th',
  'The 13th',
  'The Understudy',
  'The Spare',
  'The New Guy',
  'The Intern',
  'The Tourist',
  'The Volunteer',
  '[Redacted]',
] as const;

export const REASON_OPTIONS = [
  'I oppose "Project Stuzha"',
  'I want to protect ordinary people',
  'I think the Rokot is cool',
  "I'm here to put an end to this organization!",
  'I need a part-time job',
  'Mom told me to give it a try',
] as const;

/** Shown when the avatars bucket is empty or unreachable, so the form is
 *  never a dead end on a fresh install or a flaky connection. */
export const FALLBACK_AVATARS = ['/images/lyney.webp', '/images/lynette.webp'];

/** File types worth offering as a profile icon. */
export const AVATAR_EXTENSIONS = ['.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg'];
