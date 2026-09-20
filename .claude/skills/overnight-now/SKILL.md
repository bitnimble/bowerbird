---
name: overnight-now
description: Use when the user runs `/overnight-now <task>` to work autonomously and unattended starting immediately, with NO upfront questions (the `/overnight` skill is the same contract but with a requirements interview first; use this when there's no time for questions). Installs an autonomous behavioral contract for the session, no one will answer questions, approve permissions, or say "continue" until morning, so the agent must close the loop on its own: keep working until the task's done-criteria are met, validate its own work with the project check/build/e2e scripts, fix obviously-better things instead of asking about them, and only park a sub-task (never halt the whole night) on a genuine fork or an irreversible/destructive action. Triggers on `/overnight-now`, "work on this overnight no questions", "just start, do this while I sleep", "run unattended", "work autonomously on X".
---

# /overnight-now

You are running **unattended**. The user has gone to sleep. Until morning,
**no one will answer a question, approve a permission prompt, or tell you to
continue.** Every hour you spend stopped waiting for input is an hour wasted; the user wakes up to find the job barely started, then says "yes, continue" and
you do the actual work. That outcome is the failure this skill exists to prevent.

The task and its done-criteria are whatever the user passed as `/overnight-now <task>`.
If they didn't state explicit done-criteria, infer the most reasonable ones from
the request and record them in the log (below) as your working definition of done.

## Prime directive

**If you stop and the only thing a human would say is "yes, continue" / "yes, do
it", you have failed.** Had you the information to keep going? Then you should
have kept going. You can edit files, run `scripts/check*`, `bun run build`, and
`bun run e2e`, and validate your own work, so use that power instead of asking.

Keep working until the task meets its done-criteria, or every remaining piece is
genuinely blocked by a halt condition below.

## Close the loop

- **Never end a turn with a rubber-stamp question.** "Want me to make that
  change?", "Should I implement it?", "Shall I commit?", "Should I run the
  tests?", if the answer is obviously yes, the question is the bug. Just do it.
- **Fix what's unconditionally better.** If while working you notice cleanup, a
  refactor, dead code, or an obvious bug, **fix it**, do not surface it as "Do
  you want me to clean this up?". You are working autonomously to improve this
  project; improving it is the whole point. (Stay in scope: "unconditionally
  better" means clearly-correct and related to the work, not a speculative
  rewrite or an unrelated tangent.)
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

**Ambiguous requirements are NOT a halt condition.** If your own task is
underspecified, pick the most reasonable interpretation, record the assumption in
the log, and proceed. A reasonable guess that gets validated beats a stalled night.

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
