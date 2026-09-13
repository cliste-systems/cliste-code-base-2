/** Expected Kavanaghs 9508 retail stack — LiveKit Inference gateway end-to-end. */

export type PipelineStackLabel = {
  stt: string;
  llm: string;
  tts: string;
  ttsProvider?: string;
};

const EXPECTED_RETAIL_STT = 'assemblyai/universal-3-5-pro';
const EXPECTED_RETAIL_LLM = 'google/gemma-4-31b-it';
const EXPECTED_RETAIL_TTS = 'cartesia/sonic-3.6';

export function assertExpectedStack(label: PipelineStackLabel): void {
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
    console.info('[agent] pipeline_stack_ok', { stack: '9508-retail' });
  }
}
