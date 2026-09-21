# Text rehearsal harness

Run the **full Cara worker path** (compiled prompt → LLM → tools → agent steers) without microphone, STT, or placing voice calls.

## Prerequisites

1. LiveKit credentials in `.env` (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`).
2. For **local dev**, set `LIVEKIT_AGENT_NAME=cliste-voice-local` in **both** cb1 `.env.local` and cb2 `.env` so Railway production (`cliste-retail-node`) does not steal dispatches. Production uses `cliste-retail-node` on both dashboard and worker.
3. Local dev stack — from **cliste-code-base-1**:

```bash
npm run dev:text-rehearsal
```

That starts the admin dashboard on `:3001` and the voice worker in **cliste-code-base-2**. Or run `npm run dev` in cb2 alone if the dashboard is already up.

Production workers need `CARA_TEXT_REHEARSAL=1` (never set in production unless you intend text rehearsal there). Local `text-rehearsal-*` rooms auto-enable the text path without that flag.

## Commands

```bash
# Interactive REPL
npm run text-rehearsal -- --line +353749759508

# Single question
npm run text-rehearsal -- --line +353749759508 --say "what steaks are on offer this week"

# Multi-turn
npm run text-rehearsal -- --line +353749759508 --say "meat counter offers" --say "the fresh counter"

# Batch YAML scenarios
npm run text-rehearsal -- --line +353749759508 --batch scenarios/retail-offers.yml

# CI-friendly JSON
npm run text-rehearsal -- --line +353749759508 --batch scenarios/retail-offers.yml --json
```

## Output shape

```
Caller: what's on offer at the meat counter this week?
[Tool] searchSuperValuProducts {"query":"...","intent":"offer"}
Assistant: Do you mean fresh at the butcher counter, priced per kilo, or the pre-pack packs in the meat aisle?
```

With `--json`, each scenario prints a JSON object including `passed`, `failures`, and `transcript`.

## Scenario YAML

```yaml
- name: meat_counter_offers_vague
  turns:
    - "what's on offer at the meat counter this week?"
  expect:
    clarification: true
    must_not_quote_prices: true
    must_mention: ["per kilo"]
    must_not_contain: ["Denny"]
    fulfilment: counter
```

Each scenario gets a **fresh LiveKit room** so session flags do not bleed between runs.

## What matches a real call

- Org resolution and compiled retail prompt
- Tool choice, query, and `fulfilment` after clarification
- Clarification-before-quote behaviour
- Agent steers (handoff gating, corrections, etc.)
- Assistant transcript text (pre-TTS)

## Acceptable differences from voice

- No STT garble — you type exact caller words
- TTS sanitization runs at speak-time; CLI may show `[spoken: …]` via the worker's `spoken` field on `assistant_line` packets
- Lookup filler audio appears as `[lookup filler]` lines instead of hearing it

## Admin UI

**Text rehearsal** is a separate page at `/admin/demo-calls/text-rehearsal` (sidebar under Demo calls):

- Same store picker, filters, and search as voice demo calls
- Type caller lines → get exact Assistant replies (no mic)
- Live transcript + tool log + engineering panel

Voice demo calls remain at `/admin/demo-calls`.
- Tool-only probe (not full Cara wording):

```bash
curl -X POST https://app.hellocara.ie/api/voice/search-supervalu-products \
  -H "Authorization: Bearer $CLISTE_VOICE_WEBHOOK_SECRET" \
  -d '{"called_number":"+353749759508","query":"what steaks are on offer","intent":"offer"}'
```
