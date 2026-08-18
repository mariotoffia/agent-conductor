# Implementation Agent Prompt

Use this prompt for one task at a time.

```text
Implement exactly one ready task from:

Plan: docs/plans/0001-mvp-implementation-plan.md
Task: <task title>

Work autonomously until the task passes every gate or a real blocker requires user input.

1. Ground the task
- Read AGENTS.md, the selected task, and every canonical doc/ADR that AGENTS.md routes for the actual changes. Read PERSONAS.md before dispatching a reviewer.
- Inspect the owning code and nearest tests. Preserve unrelated worktree changes.
- State one falsifiable implementation hypothesis and its cheapest check.
- Confirm the task can finish with repository gates green without implementing another task; otherwise stop and report the plan conflict.
- Stop before coding if the task depends on an unaccepted ADR or ambiguous product decision.

2. Implement with TDD
- RED: add one behavior-focused test and run it. Confirm it fails for the expected missing behavior.
- If RED passes or fails for another reason, do not edit production code; correct the test/hypothesis or report existing behavior.
- GREEN: write the smallest production change that passes it.
- REFACTOR: improve structure only while tests remain green.
- Repeat for errors, boundaries, cancellation, and security-relevant behavior.
- Never weaken a test to make implementation pass.

3. Validate the slice
- Run the narrowest relevant test after each change.
- Run every command required by the selected task.
- Check types/errors for every touched file.

4. Adversarial review gate
- Dispatch an independent adversarial reviewer with the task requirements and cumulative diff. Self-review does not satisfy this gate; if independent review is unavailable, stop blocked.
- Treat correctness, security, protocol, data-loss, and Critical/High findings as blocking.
- For each blocking finding: add a failing regression test and fix minimally, or provide evidence until the reviewer withdraws it; then rerun focused tests and re-review the complete cumulative diff.
- Require the reviewer to report no blocking findings. After three unsuccessful full review cycles, stop and report the blocker with evidence.

5. Synchronize documentation
Update only what changed:
- User behavior/configuration: README.md and walkthroughs.
- Domain terms/model: UBIQUITOUS.md and DDD.md when present.
- Components, boundaries, or data flow: ARCHITECTURE.md.
- Durable trade-off or changed accepted decision: create a superseding ADR; never rewrite accepted ADR history.
- Public APIs and non-obvious invariants: concise code documentation.
Never reference temporary plan/task/review identifiers in code, tests, comments, or durable docs.

6. Finish
- Update the selected plan checklist only after evidence exists.
- Run fresh: make lint && make test.
- Run make check-all when extension-host behavior, packaging, or an integration path changed.
- If a required gate fails outside the selected task, do not widen scope or alter unrelated work; stop and report the conflicting failure with evidence.
- Confirm code files are <=500 lines and documentation files are <=600 lines.
- Do not commit, push, publish, or discard unrelated changes unless explicitly asked.

Final response: summarize implementation, tests and gate results, adversarial findings fixed, docs updated, and any remaining risk/blocker. Do not claim success without fresh command output.
```
