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
