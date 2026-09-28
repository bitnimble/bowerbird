---
name: overnight-now
description: Use when the user runs `/overnight-now <task>` to work autonomously and unattended starting immediately, with NO upfront questions (the `/overnight` skill is the same contract but with a requirements interview first; use this when there's no time for questions). Installs an autonomous behavioral contract for the session, no one will answer questions, approve permissions, or say "continue" until morning, so the agent must close the loop on its own: keep working until the task's done-criteria are met, validate its own work with the project check/build/e2e scripts, fix obviously-better things instead of asking about them, and only park a sub-task (never halt the whole night) on a genuine fork or an irreversible/destructive action. Triggers on `/overnight-now`, "work on this overnight no questions", "just start, do this while I sleep", "run unattended", "work autonomously on X".
---

# /overnight-now

Running **unattended** until morning: no answers, approvals or continuation prompts.
Keep working without waiting for input.

Use task/done-criteria from `/overnight-now <task>`. If unstated, infer and log reasonable criteria.

## Prime directive

**Don't stop for "yes, continue" / "yes, do it".** Edit, run `scripts/check*`,
`bun run build`, `bun run e2e`, and validate without rubber-stamp questions.

Keep working until the task meets its done-criteria, or every remaining piece is
genuinely blocked by a halt condition below.

## Close the loop

- **No rubber-stamp questions** about edits, implementation, commits or tests. Do authorised work.
- **Fix clearly correct, related improvements:** cleanup, refactors, dead code, obvious bugs.
  No speculative rewrites or unrelated tangents.
- **Validate everything yourself, to green.** "Should compile" is not done.
  Run the relevant `scripts/check*`; run `bun run e2e` for any `src/**` change
  (per AGENTS.md). A task is done when its checks pass, not when you think they
  would.

## Halt conditions

These are the **only** valid reasons to stop working on something. When you hit
one, **park that specific sub-task, write it up in the log, and keep doing
everything else**, never halt the whole night because one item is blocked.

- **Irreversible / destructive action.** Do all reversible work and commit
  locally, but with **explicit pathspecs only** (the working tree is shared
  with the user; never a bare `git commit -a`). Leave `git push`, force-push,
  branch deletion, file/data deletion, and anything else hard to undo **for the
  morning**. Stage the work so it's one command for the user to finish.
- **Genuine fork, neither path better.** Two materially different approaches,
  and neither is clearly superior (the real "probe A or B?" kind of decision, not an excuse to avoid a clearly-correct default). Document both options and
  your lean in the log, then move on to other work.
- **Stuck loop.** The same failure recurs 3+ times across **genuinely distinct**
  fix attempts (not the same fix retried). Stop hammering: write up what you
  tried and your leading hypothesis, and move to other work.

**Ambiguity never halts work.** Choose a reasonable interpretation, log assumption, proceed and validate.

## Morning report

Keep a running log at `OVERNIGHT_LOG.md` in the repo root (leave it uncommitted, it's a scratch report, not part of the change). Append as you go so a crash still
leaves a trail. End the session with a summary containing:

- **Done**, what was completed, each with its validation status (which
  `scripts/check*` / `e2e` passed).
- **Committed locally**; the commits you made (none pushed), so the user can
  review and push.
- **Parked**, each halted sub-task: the halt condition, what you tried, and your
  recommendation (for forks: both paths + your lean; for irreversible actions:
  the exact command left for the user to run).
- **Assumptions**, every ambiguous-requirement call you made.

Then stop. Do not push, and do not perform any parked irreversible action.
