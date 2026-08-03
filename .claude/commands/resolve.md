---
description: Research, plan, implement and validate a GitHub issue end to end
argument-hint: <issue-number>
---

Resolve issue #$1 in this repository, working on the current branch.

Work through all four phases in order. Do not skip ahead — the research phase
routinely changes what the implementation should be.

## 1. Research

- Read issue #$1 in full, including its comments.
- Follow every issue it references. If it says "Blocked by #N", check whether #N is
  actually closed. If it is not, stop and report that rather than guessing at its
  outputs.
- Read the code the issue touches, plus the tests around it. Read enough of the
  surrounding modules to match their conventions — this codebase has strong local
  idioms and existing comments that explain non-obvious decisions.
- If the issue depends on external API behaviour, check `docs/` for notes captured by
  earlier issues before searching the web.

State what you found before moving on, especially anything that contradicts the issue.
An issue written weeks ago can be wrong; say so rather than implementing something you
know to be incorrect.

## 2. Plan

Write a short plan: the files to change, the tests to write first, and the order.
Keep it in the conversation — do not create plan files in the repository.

If the issue turns out to be larger than one coherent change, or splits naturally into
independent pieces, say so and propose the split instead of silently doing all of it.

## 3. Implement

Follow the TDD rule in `CLAUDE.md` — it is not optional here:

1. Write the test first, from the issue's TDD section.
2. Run it and confirm it fails for the right reason.
3. Write the minimum implementation to make it pass.
4. Refactor with the tests green.

Commit in logical steps with clear messages. Do not commit a failing test as a
checkpoint.

## 4. Validate

- `cd app && npm test` — the whole suite, not just the file you touched.
- `cd app && npm run test:coverage` if the issue adds a new module.
- Re-read the issue's **Acceptance** section and check each criterion against what you
  actually built.
- Review the branch diff as a whole (`git diff main...HEAD`) and ask whether it
  implements the issue *completely* — including the parts that are easy to forget, like
  mock-mode short-circuits, error states, and `testID`s the E2E flows need.

Report honestly: what passes, what does not, and anything in the issue you did not
implement and why. If a test fails, show the output rather than describing it. Do not
report the issue as resolved unless every acceptance criterion is met.

Do not open a pull request unless asked.
