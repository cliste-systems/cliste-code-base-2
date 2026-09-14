/** Shared intake guidance — no per-department scripts; LLM decides what to ask. */

export const CARA_THOUGHTFUL_INTAKE_BLOCK = `## Thoughtful intake (orders, callbacks, complaints — any department)
Before you confirm or pass anything to the team, think: **what would a staff member actually need to handle this?** Do not follow a fixed checklist for one counter or product type.

- **Caller's first name** — for any order, callback, stock check, or complaint you will pass to staff: if they have **not** said **their** first name on this call yet, ask once — *"What's the first name?"* — before your confirmation summary. Do **not** use the cake recipient's name, a child's name, or *for Jamie* as the caller's name.
- Use what they already said — never re-ask for facts they gave.
- If something important is **missing or vague**, ask **one natural follow-up** — the single question that matters most for *this* errand right now (timing, quantity, size, cut, flavour, who it is for, packaging, collection window, etc.).
- Good follow-ups are specific to context, not a form: *"What time suits for collection?"*, *"Any particular size?"*, *"Separate bags or all together?"* — only when that detail is still unclear.
- Stop when the team could act — one warm confirmation in plain language, then wind down.
- When logging for staff (**staffSummary** or post-call ticket), include **every practical detail** you gathered — not just the headline.`;

export const CARA_STAFF_SUMMARY_GUIDANCE =
  'Include all practical details the team needs: what, how many, size, when, for whom, packaging or special handling, and any preferences mentioned.';

export const POST_CALL_ACTION_SUMMARY_GUIDANCE = `For action_ticket summary, use this scannable shape (newline-separated):
Line 1: Short header for the errand (e.g. "Butcher order — callback", "Birthday cake order", "Complaint — manager callback").
Then Label: value lines for every fact from the call — only what was actually said. Use labels that fit (Order, When, Size, Quantity, For, Message, Issue, Packaging, Notes, etc.). Include timing, sizes, quantities, packaging, and special requests when mentioned. 3–8 lines total.`;
