import { greetingIncludesAiDisclosure } from './greeting_compliance.js';
import { isRetailNiche } from './org_vertical.js';

const PROD_OVERRIDE_TOKEN = 'i-have-a-pre-call-ivr-and-accept-the-legal-risk';

/** Default post-greeting disclosure — retail / grocery only (no link language). */
const DEFAULT_BUSINESS_DISCLOSURE =
  "Just so you know, I'm an AI assistant for the store and your call may be recorded to help with your enquiry.";

export type ResolvedAiDisclosure = {
  text: string;
  disabled: boolean;
  source: 'default' | 'custom' | 'env-disabled' | 'greeting-includes';
};

function isProductionEnv(): boolean {
  const candidates = [
    process.env.NODE_ENV,
    process.env.CLISTE_ENV,
    process.env.RAILWAY_ENVIRONMENT,
    process.env.RAILWAY_ENVIRONMENT_NAME,
  ]
    .map((v) => v?.trim().toLowerCase())
    .filter((v): v is string => Boolean(v));
  return candidates.includes('production') || candidates.includes('prod');
}

function isValidCustomDisclosure(text: string): boolean {
  const t = text.trim();
  return t.length >= 24 && /\bai\b/i.test(t) && !/\bshop\b/i.test(t) && !/\blink\b/i.test(t);
}

/**
 * Spoken AI disclosure after the greeting when the greeting itself does not
 * already include AI + recording notice.
 */
export function resolveAiDisclosure(input?: {
  greetingText?: string | null;
  niche?: string | null;
  businessType?: string | null;
  demoLine?: boolean;
  /** Name-first opening — recording notice is spoken after the caller gives their name. */
  conversationalOpening?: boolean;
}): ResolvedAiDisclosure {
  const greetingText = input?.greetingText?.trim() ?? '';
  if (greetingText && greetingIncludesAiDisclosure(greetingText)) {
    return { text: '', disabled: true, source: 'greeting-includes' };
  }

  if (input?.demoLine || input?.conversationalOpening) {
    return { text: '', disabled: true, source: 'env-disabled' };
  }

  const mode = (process.env.CLISTE_AI_DISCLOSURE_OPENING ?? 'on').trim().toLowerCase();
  const customRaw = process.env.CLISTE_AI_DISCLOSURE_TEXT?.trim();
  const prod = isProductionEnv();
  const override = process.env.CLISTE_AI_DISCLOSURE_PROD_OVERRIDE?.trim();
  const overrideValid = override === PROD_OVERRIDE_TOKEN;

  if (mode === 'off') {
    if (prod && !overrideValid) {
      console.error(
        '[ai-disclosure] CRITICAL: CLISTE_AI_DISCLOSURE_OPENING=off in production without override — forcing ON',
      );
    } else {
      return { text: '', disabled: true, source: 'env-disabled' };
    }
  }

  if (customRaw) {
    if (!isValidCustomDisclosure(customRaw)) {
      console.error('[ai-disclosure] invalid CLISTE_AI_DISCLOSURE_TEXT — using default');
    } else {
      return { text: customRaw, disabled: false, source: 'custom' };
    }
  }

  // Retail-only product today — never fall back to legacy link/shop copy.
  void isRetailNiche(input?.niche);
  void input?.businessType;

  return {
    text: DEFAULT_BUSINESS_DISCLOSURE,
    disabled: false,
    source: 'default',
  };
}
