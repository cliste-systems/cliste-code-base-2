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
 * tenant is silently un-disclosed.
 *
 * Production semantics — fail-SAFE, not fail-CLOSED:
 *   - For a live phone system, refusing to boot is the WRONG tradeoff:
 *     a worker that doesn't answer leaves callers with "user is busy"
 *     and no one books anything. So when the operator tries to disable
 *     disclosure in prod without a valid override, we don't throw — we
 *     log a CRITICAL error and force disclosure back ON. The legal
 *     defect (callers hear two AI disclosures if the IVR already plays
 *     one) is recoverable in seconds; an unreachable phone line is not.
 *   - The override token (`CLISTE_AI_DISCLOSURE_PROD_OVERRIDE` set to
 *     the magic phrase below) is the documented way to suppress the
 *     spoken disclosure when a pre-call IVR notice exists.
 *   - A clearly-wrong custom text (too short, or no "AI" word) is also
 *     ignored in prod with a CRITICAL log and we fall back to the
 *     default disclosure.
 *
 * Non-production envs (dev, preview, test) just warn — engineers can
 * iterate locally without override tokens.
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
      // FAIL-SAFE: do NOT throw. A crashed worker = "user is busy" to
      // every caller. Force disclosure back on, log loudly, and let the
      // phone line keep working. Operator can fix env at their leisure.
      console.error(
        '[ai-disclosure] CRITICAL: CLISTE_AI_DISCLOSURE_OPENING=off in production ' +
          'without a valid override token — IGNORING and forcing disclosure ON. ' +
          'This protects callers under GDPR Art 13(2)(f) / EU AI Act Art 50(1). ' +
          'To intentionally suppress (only when a pre-call IVR already discloses AI), set ' +
          `CLISTE_AI_DISCLOSURE_PROD_OVERRIDE='${PROD_OVERRIDE_TOKEN}'.`,
      );
      return { text: DEFAULT_DISCLOSURE, disabled: false, source: 'default' };
    }
    if (!prod) {
      console.warn(
        '[ai-disclosure] disclosure DISABLED via CLISTE_AI_DISCLOSURE_OPENING=off ' +
          '(non-production env, allowed). In production we would override this and force disclosure ON ' +
          'unless CLISTE_AI_DISCLOSURE_PROD_OVERRIDE is set.',
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
        // Same fail-safe logic — log critical, fall back to default text,
        // keep the worker alive so calls still get answered.
        console.error(`${message} IGNORING and using the default disclosure to keep the line answering.`);
      } else {
        console.warn(`${message} Falling back to the default disclosure for non-production.`);
      }
      return { text: DEFAULT_DISCLOSURE, disabled: false, source: 'default' };
    }
    return { text: customRaw, disabled: false, source: 'custom' };
  }

  return { text: DEFAULT_DISCLOSURE, disabled: false, source: 'default' };
}

/**
 * Resolve at boot, log a single structured line so support can grep
 * Railway logs to confirm what the worker is actually using. Never
 * throws — we take the strongest safe interpretation of misconfigured
 * env vars rather than crashing.
 */
export function assertAiDisclosureSafeForBoot(): ResolvedAiDisclosure {
  const resolved = resolveAiDisclosure();
  console.info(
    '[ai-disclosure] resolved at boot',
    JSON.stringify({
      disabled: resolved.disabled,
      source: resolved.source,
      // Short fingerprint so we can confirm prod is using the text we
      // think it is, without dumping the whole string into structured
      // logs.
      textPreview: resolved.text ? `${resolved.text.slice(0, 32)}…` : '',
      textLength: resolved.text.length,
    }),
  );
  return resolved;
}
