import { getSupabaseClient, isOfflinePlayground } from './supabase.js';

export type CallTestProfile = {
  id: string;
  name: string;
  description: string | null;
  voice_id: string | null;
  llm_model: string | null;
  stt_model: string | null;
  tts_model: string | null;
  llm_provider: string | null;
  is_active: boolean;
};

export async function getActiveCallTestProfile(): Promise<CallTestProfile | null> {
  if (isOfflinePlayground()) return null;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('call_test_profiles')
      .select(
        'id, name, description, voice_id, llm_model, stt_model, tts_model, llm_provider, is_active',
      )
      .eq('is_active', true)
      .maybeSingle();
    if (error) {
      console.warn('[test_profile] fetch active failed', error.message);
      return null;
    }
    if (!data?.id) return null;
    return data as CallTestProfile;
  } catch (err) {
    console.warn(
      '[test_profile] fetch active threw',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
