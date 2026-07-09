---
name: overnight
description: Use when the user runs `/overnight <task>` to hand off autonomous unattended work (e.g. before bed). It begins with a short, batched requirements interview while the user is still awake (~15 min) so it can gather requirements up front, THEN goes fully autonomous for the actual work. Front-load every question now; once the user signals they're leaving, switch to the autonomous contract (the `overnight-now` skill) and never ask again. Triggers on `/overnight`, "work on this overnight", "do this while I sleep", "ask me questions then work overnight", "let me answer a few things before you work autonomously", "gather requirements then run unattended".
---

# /overnight

Same destination as `/overnight-now` (unattended autonomous work to completion), but
the user is **awake right now for a short window** (~15 minutes) and can answer
questions before they go to sleep. The actual work happens *after* they leave.

So there are two phases: a brief **interview** now, then the **autonomous** phase.

## Phase 1, Interview (user is awake, time is short)

Your goal: leave Phase 1 with a confident, written understanding of the goal,
scope, and done-criteria, so that in Phase 2 you never need to ask anything.

- **Front-load everything.** Surface every decision, ambiguity, and fork you can
  anticipate *now*, while the user can answer. A question you skip here becomes a
  blocked sub-task or a guess at 3am.
- **Be fast and batched.** The user has minutes, not hours. Prefer
  `AskUserQuestion` with concrete multiple-choice options over open-ended prose.
  Group related decisions. Don't trickle one-at-a-time if you can ask four at once.
- **Explore first so your questions are sharp.** Read the relevant code/docs
  before asking, so you ask about real forks in *this* codebase, not generic ones.
  A question you can answer yourself by reading a file is a wasted question.
- **Pin down done-criteria explicitly.** What does "finished" look like? Which
  checks must be green (`scripts/check*`, `bun run e2e`)? How will you know you've
  succeeded without the user to confirm? Write these down.
- **Record the answers** in `OVERNIGHT_LOG.md` (repo root, uncommitted) as the
  agreed brief: goal, scope, done-criteria, and every decision the user made.

When you believe you have enough to work unattended, **say so and confirm**:
summarize the brief in a few lines and tell the user you're ready to go autonomous.
This is the one and only place you wait for them. Once they confirm (or say
something like "ok, going to bed" / "go"), Phase 1 is over.

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
