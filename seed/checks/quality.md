---
kind: quality
title: Code quality and cleaning
revision: 1
scopes: [diff, full]
agent: review
categories: [leftover-debug, commented-out-code, todo-rot, inconsistent-naming, swallowed-error, magic-value]
defaults: { enabled: true, delivery: pr, auto_submit: false, armed: true, cadence_days: 14 }
---
Find cleanliness problems: leftover debug output, commented-out code, TODO/FIXME that are stale,
naming that contradicts the codebase's own convention, errors caught and ignored, unexplained
magic values.

Judge by the repository's own conventions (read a few neighbouring files first). Do not report
formatting a formatter would handle.
