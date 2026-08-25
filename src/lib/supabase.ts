import { createClient } from '@supabase/supabase-js';
import { AVATAR_EXTENSIONS, FALLBACK_AVATARS } from './profile';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://mock.supabase.co';
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || 'mock-key';

export const isDemoMode = !import.meta.env.VITE_SUPABASE_URL;

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

export function getPublicStorageUrl(imagePath: string): string {
  if (isDemoMode) {
    // Return sample cards or svg data URIs for demo testing
    return imagePath;
  }
  const { data } = supabase.storage.from('card-images').getPublicUrl(imagePath);
  return data.publicUrl;
}

export async function ensureAuthSession(): Promise<string> {
  if (isDemoMode) return 'demo-uid';

  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user?.id) return session.user.id;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data?.session) {
    // Every host- and player-scoped RPC keys off auth.uid(); without a session
    // the server cannot tell one device from the next. Failing here is louder
    // than letting the app run unauthenticated.
    throw new Error(
      `Could not start a session: ${error?.message ?? 'no session returned'}. ` +
      'If this says anonymous sign-ins are disabled, enable them in the ' +
      'Supabase dashboard under Authentication -> Sign In / Providers.'
    );
  }
  return data.session.user.id;
}

/** Resolve a stored avatar_path to something an <img> can load. Paths that
 *  already look like URLs -- the bundled fallbacks, or an absolute link --
 *  are passed through untouched. */
export function getAvatarUrl(avatarPath: string): string {
  if (!avatarPath) return '';
  if (isDemoMode || avatarPath.startsWith('/') || avatarPath.startsWith('http')) {
    return avatarPath;
  }
  const { data } = supabase.storage.from('avatars').getPublicUrl(avatarPath);
  return data.publicUrl;
}

/** The icons on offer in the join form: whatever the host has put in the
 *  avatars bucket. Uploading a file there is the whole workflow for adding
 *  one, so this is read fresh rather than baked into the build. An empty or
 *  unreachable bucket falls back to the bundled pair instead of leaving the
 *  player with nothing to pick. */
export async function listAvatarPaths(): Promise<string[]> {
  if (isDemoMode) return FALLBACK_AVATARS;

  try {
    const { data, error } = await supabase.storage.from('avatars').list('', {
      limit: 100,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw error;

    const files = (data ?? [])
      .map((f) => f.name)
      .filter((name) => AVATAR_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)));

    return files.length > 0 ? files : FALLBACK_AVATARS;
  } catch (err) {
    console.error('Could not list avatars:', err);
    return FALLBACK_AVATARS;
  }
}

/** Resolve a stored NPC portrait path to something an <img> can load. Same
 *  shape as getAvatarUrl -- paths that already look like URLs pass through. */
export function getNpcImageUrl(imagePath: string): string {
  if (!imagePath) return '';
  if (isDemoMode || imagePath.startsWith('/') || imagePath.startsWith('http')) {
    return imagePath;
  }
  const { data } = supabase.storage.from('npc-images').getPublicUrl(imagePath);
  return data.publicUrl;
}

/** The portraits on offer when the host is building the NPC catalog: whatever
 *  is in the npc-images bucket. Uploading a file there is the whole workflow
 *  for adding one, the same as avatars. */
export async function listNpcImagePaths(): Promise<string[]> {
  if (isDemoMode) return [];

  try {
    const { data, error } = await supabase.storage.from('npc-images').list('', {
      limit: 100,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw error;

    return (data ?? [])
      .map((f) => f.name)
      .filter((name) => AVATAR_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)));
  } catch (err) {
    console.error('Could not list NPC portraits:', err);
    return [];
  }
}
