# Hello Cara demo line — manual QA checklist

**Number:** +353749389378  
**Baseline call (pre-playbook):** `d42c3254` — good role-play setup, improvised beats 3–4  
**After deploy:** run these three paths and compare transcripts in Call Testing.

## Pre-call

- [ ] Worker deployed with demo playbook changes (Railway latest commit)
- [ ] Greeting unchanged: *"You're through to Hello Cara, the demo line… What would you like to try?"*
- [ ] No duplicate greeting at call start

## Path 1 — Electrician trade demo

1. Say: *"Can we demo an electrician?"*
2. Expect beat 1: chatty ack + one-line value (not a feature list)
3. Expect beat 2: role-play invite with suggested customer line (tripped fuse / need someone out)
4. Role-play as customer: *"My fuse tripped, I need someone today."*
5. Expect beat 3: in-role message-taking + issue/urgency question (no invented prices)
6. Expect beat 4: wrap — *another trade or are you sorted?*
7. Say thanks / goodbye; expect warm close + hangup

**Fail if:** bullet list read aloud, invented caller name, generic capability dump only, no role-play invite

## Path 2 — General (non-trade)

1. Say: *"What is Hello Cara?"* or *"What can you do for my business?"*
2. Expect general playbook — not forced into electrician
3. Expect offer to try an example (pick a business or suggested trade)
4. Complete mini demo or short role-play
5. Wrap + close as above

**Fail if:** forced electrician/salon without caller choosing trade

## Path 3 — Explore / audio check

1. Say: *"Can you hear me?"* or pause after greeting
2. Expect one warm line (*"Yeah, I can hear you fine"*) — **not** a second full greeting
3. Re-offer: *"want to try a quick example?"* — no trade menu unless asked

**Fail if:** repeated disclosure, second *"how can I help"*, long pause drag on greeting

## Diagnostics (Call Testing dashboard)

- [ ] `demo_scenario_start` event with correct slug (electrician / general)
- [ ] `demo_scenario_beat` events advancing 1→4 on trade path
- [ ] `sessionFlags.demoScenarioSlug` populated on close
- [ ] No transcript issues: missing role-play invite, bullet list, premature hangup

## Compare to baseline `d42c3254`

| Check | Baseline | Target after playbook |
|-------|----------|------------------------|
| Role-play invite | Yes | Yes (scripted beat 2) |
| In-role reply structure | Generic message-taking | Beat 3 script (issue + urgency) |
| Wrap beat | Improvised / missing | Beat 4 every time |
| Chatty tone | Minimal | Light warmth in ack lines |
