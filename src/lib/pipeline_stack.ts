/** Expected Kavanaghs 9508 retail stack labels. */

export type PipelineStackMode = 'inference-retail' | 'gpt-live-retail';

export type PipelineStackLabel = {
  stack?: PipelineStackMode;
  stt: string;
  llm: string;
  tts: string;
  ttsProvider?: string;
  voice?: string;
};

const EXPECTED_RETAIL_STT = 'assemblyai/universal-3-5-pro';
const EXPECTED_RETAIL_LLM = 'google/gemma-4-31b-it';
const EXPECTED_RETAIL_TTS = 'cartesia/sonic-3.6';
const EXPECTED_GPT_LIVE_LLM = 'openai/gpt-live-1';
const EXPECTED_GPT_LIVE_VOICE = 'willow';

function assertExpectedInferenceRetailStack(label: PipelineStackLabel): void {
  const issues: string[] = [];

  if (!label.stt.toLowerCase().includes('universal-3-5-pro')) {
    issues.push(`STT expected ${EXPECTED_RETAIL_STT}, got ${label.stt}`);
  }
  if (!label.llm.includes(EXPECTED_RETAIL_LLM)) {
    issues.push(`LLM expected gateway ${EXPECTED_RETAIL_LLM}, got ${label.llm}`);
  }
  if (!label.tts.includes(EXPECTED_RETAIL_TTS)) {
    issues.push(`TTS expected ${EXPECTED_RETAIL_TTS}, got ${label.tts}`);
  }
  if (label.ttsProvider && label.ttsProvider !== 'cartesia-inference') {
    issues.push(`TTS provider expected cartesia-inference, got ${label.ttsProvider}`);
  }

  if (issues.length > 0) {
    console.warn('[agent] pipeline_stack_mismatch', { issues, label });
  } else {
    console.info('[agent] pipeline_stack_ok', { stack: '9508-retail-inference' });
  }
}

function assertExpectedGptLiveRetailStack(label: PipelineStackLabel): void {
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

export function assertExpectedStack(label: PipelineStackLabel): void {
  if (label.stack === 'gpt-live-retail' || label.llm.includes(EXPECTED_GPT_LIVE_LLM)) {
    assertExpectedGptLiveRetailStack(label);
    return;
  }
  assertExpectedInferenceRetailStack(label);
}
