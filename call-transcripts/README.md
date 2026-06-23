# Call transcripts (local mirror)

**`latest.md`** is the single file agents should read in Cursor — it always holds the most recent call.

## When it updates

| Source | How |
|--------|-----|
| **Local dev call** | Worker writes + opens `latest.md` on hangup (twice: verbatim immediately, then with AI summary) |
| **Production (Railway) call** | Run `npm run watch:call-transcripts` in a terminal while testing — polls Supabase every 15s and refreshes + opens on new calls |
| **Manual / after any call** | `npm run export:latest-call` — pulls latest row from Supabase, writes `latest.md`, opens in editor |

Set `CARA_TRANSCRIPT_OPEN=0` to skip auto-open. Set `CARA_TRANSCRIPT_MIRROR_DIR` to change output folder (default: `call-transcripts/`).

Transcript `*.md` files are gitignored (PII). This README is committed.
