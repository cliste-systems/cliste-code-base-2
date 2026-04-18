/**
 * AI-disclosure guard.
 *
 * GDPR Article 13(2)(f) and EU AI Act Article 50(1) both require that a
 * caller is told they are interacting with an AI system, in good time
 * before sharing personal data. We do this with a one-line spoken
 * disclosure right after the salon's greeting.
 *
 * Operators can suppress the spoken disclosure (e.g. when a human-played
 * IVR prompt already covers it before the call hits LiveKit) by setting
 * `CLISTE_AI_DISCLOSURE_OPENING=off`. That escape hatch is a footgun:
 * if it leaks into the production worker, every caller across every
 * tenant is silently un-disclosed. This module makes that mistake
 * loud and unbootable.
 *
 * Production semantics:
 *   - We refuse to boot if disclosure is off in production UNLESS
 *     `CLISTE_AI_DISCLOSURE_PROD_OVERRIDE` is set to the exact magic
 *     phrase below. The phrase is intentionally weird so it can't be a
 *     copy/paste accident.
 *   - We also refuse to boot if the operator set a custom disclosure
 *     text that is shorter than 24 characters or doesn't contain the
 *     word "AI" (case-insensitive) — that catches "test", "" and
 *     other near-empty values that would technically satisfy the
 *     "on" branch but fail the legal requirement.
 *
 * Non-production envs (dev, preview, test) emit a warning instead of
 * failing, so an engineer can iterate locally without a custom
 * override token.
 */

const PROD_OVERRIDE_TOKEN = 'i-have-a-pre-call-ivr-and-accept-the-legal-risk';

const DEFAULT_DISCLOSURE =
  "Just so you know, I'm an AI assistant for the salon and your call is processed to help with your booking.";

export type ResolvedAiDisclosure = {
  /** The exact sentence the agent should speak after the greeting. */
  text: string;
  /** True when the operator explicitly disabled the spoken disclosure. */
  disabled: boolean;
  /** Source of the text: 'default' | 'custom' | 'env-disabled'. */
  source: 'default' | 'custom' | 'env-disabled';
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

/**
 * Read env once and return the disclosure config the agent should use.
 * Throws synchronously if the resolved config is unsafe for the current
 * environment — call this at boot so the worker never registers with
 * LiveKit while mis-configured.
 */
export function resolveAiDisclosure(): ResolvedAiDisclosure {
  const mode = (process.env.CLISTE_AI_DISCLOSURE_OPENING ?? 'on')
    .trim()
    .toLowerCase();
  const customRaw = process.env.CLISTE_AI_DISCLOSURE_TEXT?.trim();
  const prod = isProductionEnv();
  const override = process.env.CLISTE_AI_DISCLOSURE_PROD_OVERRIDE?.trim();
  const overrideValid = override === PROD_OVERRIDE_TOKEN;

  if (mode === 'off') {
    if (prod && !overrideValid) {
      throw new Error(
        '[ai-disclosure] CLISTE_AI_DISCLOSURE_OPENING=off is forbidden in production. ' +
          'Either turn the spoken disclosure back on (unset the env var) or, if you have a ' +
          'pre-call IVR that already discloses AI use, set ' +
          `CLISTE_AI_DISCLOSURE_PROD_OVERRIDE='${PROD_OVERRIDE_TOKEN}'. ` +
          'GDPR Art 13(2)(f) and EU AI Act Art 50(1) require disclosure before personal ' +
          'data is shared with an AI system.',
      );
    }
    if (!prod) {
      console.warn(
        '[ai-disclosure] disclosure DISABLED via CLISTE_AI_DISCLOSURE_OPENING=off ' +
          '(non-production env, allowed). Production would refuse to boot without an explicit override.',
      );
    } else {
      console.warn(
        '[ai-disclosure] disclosure disabled in production with operator override. ' +
          'Make sure your pre-call IVR actually plays an AI-disclosure notice — this ' +
          'override does not check, it trusts you.',
      );
    }
    return { text: '', disabled: true, source: 'env-disabled' };
  }

  if (customRaw) {
    const looksLikeRealDisclosure =
      customRaw.length >= 24 && /\bai\b/i.test(customRaw);
    if (!looksLikeRealDisclosure) {
      const message =
        '[ai-disclosure] CLISTE_AI_DISCLOSURE_TEXT is set but does not look like a ' +
        'compliant disclosure (must be at least 24 chars and contain the word "AI"). ' +
        `Got: ${JSON.stringify(customRaw)}.`;
      if (prod) {
        throw new Error(
          `${message} Refusing to boot in production — fix the env var or unset it to use the default.`,
        );
      }
      console.warn(`${message} Falling back to the default disclosure for non-production.`);
      return { text: DEFAULT_DISCLOSURE, disabled: false, source: 'default' };
    }
    return { text: customRaw, disabled: false, source: 'custom' };
  }

  return { text: DEFAULT_DISCLOSURE, disabled: false, source: 'default' };
}

/**
 * Assert at boot. Throws if the resolved config is unsafe for the
 * current environment, otherwise logs a single line documenting which
 * branch is in effect (so support can grep Railway logs for it).
 */
export function assertAiDisclosureSafeForBoot(): ResolvedAiDisclosure {
  const resolved = resolveAiDisclosure();
  console.info(
    '[ai-disclosure] resolved at boot',
    JSON.stringify({
      disabled: resolved.disabled,
      source: resolved.source,
      // Hash-y fingerprint so we can confirm prod is using the text we
      // think it is, without dumping the whole string into structured
      // logs.
      textPreview: resolved.text ? `${resolved.text.slice(0, 32)}…` : '',
      textLength: resolved.text.length,
    }),
  );
  return resolved;
}
