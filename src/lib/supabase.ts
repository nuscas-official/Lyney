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
