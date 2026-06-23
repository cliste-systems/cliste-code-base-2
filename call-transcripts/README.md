# Call transcripts (local mirror)

**`latest.md`** is the single file agents should read in Cursor — it always holds the most recent call.

## When it updates

| Source | How |
|--------|-----|
| **Local dev call** | Worker writes + opens `latest.md` on hangup (twice: verbatim immediately, then with AI summary) |
| **Production (Railway) call** | Run `npm run watch:call-transcripts` while testing — polls Supabase and writes only when Caller lines are present |
| **Manual / after any call** | `npm run export:latest-call -- --wait` — waits up to 2 min for the new row in Supabase, then writes `latest.md` |

`export:latest-call` reads **Supabase only** (never Railway logs). It refuses to overwrite `latest.md` when the latest row is missing Caller lines. Use `--wait` after a phone test; use `--allow-partial` only if you explicitly want a flagged incomplete file.

Set `CARA_TRANSCRIPT_OPEN=0` to skip auto-open. Set `CARA_TRANSCRIPT_MIRROR_DIR` to change output folder (default: `call-transcripts/`). Set `CARA_TRANSCRIPT_WAIT_MS` / `CARA_TRANSCRIPT_POLL_MS` to tune `--wait` polling.

Transcript `*.md` files are gitignored (PII). This README is committed.
