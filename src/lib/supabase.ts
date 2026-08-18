import { createClient } from '@supabase/supabase-js';

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

export async function ensureAuthSession(): Promise<string | null> {
  if (isDemoMode) return 'demo-uid';
  try {
    let { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (!error && data?.session) {
        session = data.session;
      } else {
        console.info('Anonymous sign-in notice (will proceed with anon key):', error?.message);
      }
    }
    return session?.user?.id || null;
  } catch (err) {
    console.warn('ensureAuthSession notice:', err);
    return null;
  }
}
