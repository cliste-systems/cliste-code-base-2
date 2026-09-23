/** Expected Kavanaghs 9508 retail stack — GPT-Live only (no inference fallback). */

export type PipelineStackLabel = {
  stack?: 'gpt-live-retail';
  stt: string;
  llm: string;
  tts: string;
  ttsProvider?: string;
  voice?: string;
  backendModel?: string;
};

const EXPECTED_GPT_LIVE_LLM = 'openai/gpt-live-1';
const EXPECTED_GPT_LIVE_VOICE = 'willow';

export function assertExpectedStack(label: PipelineStackLabel): void {
  const issues: string[] = [];

  if (!label.llm.includes(EXPECTED_GPT_LIVE_LLM)) {
    issues.push(`LLM expected ${EXPECTED_GPT_LIVE_LLM}, got ${label.llm}`);
  }
  const voice = label.voice?.trim().toLowerCase();
  if (voice && voice !== EXPECTED_GPT_LIVE_VOICE) {
    issues.push(`Voice expected ${EXPECTED_GPT_LIVE_VOICE}, got ${label.voice}`);
  }
  if (label.ttsProvider && label.ttsProvider !== 'gpt-live-built-in') {
    issues.push(`TTS provider expected gpt-live-built-in, got ${label.ttsProvider}`);
  }

  if (issues.length > 0) {
    console.warn('[agent] pipeline_stack_mismatch', { issues, label });
  } else {
    console.info('[agent] pipeline_stack_ok', { stack: '9508-retail-gpt-live' });
  }
}
