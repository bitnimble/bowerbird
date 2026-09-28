---
name: overnight
description: Use when the user runs `/overnight <task>` to hand off autonomous unattended work (e.g. before bed). It begins with a short, batched requirements interview while the user is still awake (~15 min) so it can gather requirements up front, THEN goes fully autonomous for the actual work. Front-load every question now; once the user signals they're leaving, switch to the autonomous contract (the `overnight-now` skill) and never ask again. Triggers on `/overnight`, "work on this overnight", "do this while I sleep", "ask me questions then work overnight", "let me answer a few things before you work autonomously", "gather requirements then run unattended".
---

# /overnight

Interview while user is awake (~15 minutes), then work unattended to completion,
under `/overnight-now`, after they leave.

## Phase 1, Interview (user is awake, time is short)

Record goal, scope and done-criteria before Phase 2; no questions afterward.

- **Front-load decisions, ambiguities and forks** while user can answer; don't leave guesses for 3am.
- **Batch questions.** Prefer concrete choices through `AskUserQuestion`; group related decisions,
  ask four together where possible.
- **Read relevant code/docs first.** Ask only real forks that reading cannot resolve.
- **Record done-criteria:** observable outcome and required checks (`scripts/check*`, `bun run e2e`).
- **Record the answers** in `OVERNIGHT_LOG.md` (repo root, uncommitted) as the
  agreed brief: goal, scope, done-criteria, and every decision the user made.

When ready, summarise brief and **wait once for confirmation**. Confirmation, "going to bed"
or "go" ends Phase 1.

## Phase 2, Autonomous (user is asleep)

From this point you are **unattended**. Apply the autonomous contract in full, invoke the `overnight-now` skill via the `Skill` tool and follow it. In short:

- **Prime directive:** if you stop and a human would only say "yes, continue",
  you failed. Keep working to the agreed done-criteria.
- **Close the loop:** no rubber-stamp questions; fix unconditionally-better
  things instead of asking; validate your own work to green.
- **Halt conditions** (park the sub-task + log it, keep doing everything else):
  irreversible/destructive actions (commit locally with explicit pathspecs, leave
  pushes/deletes for morning), genuine forks with no better option, and stuck
  loops (same failure 3+ times across distinct attempts). Ambiguity is **not** a
  halt condition, but you front-loaded most of it in Phase 1, so there should be
  little left; pick the reasonable interpretation and log it.
- **Morning report:** finish with the Done / Committed-locally / Parked /
  Assumptions summary in `OVERNIGHT_LOG.md`.

Do not return to Phase 1. The user is asleep; there are no more questions.
