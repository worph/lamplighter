---
kind: architecture
title: Architecture review
revision: 2
scopes: [full]
agent: review
categories: [boundary-violation, dependency-direction, drift-from-docs, missing-seam, scaling-risk]
defaults: { enabled: true, delivery: report, auto_submit: false, armed: false, cadence_days: 30 }
---
Review the repository's architecture as a senior engineer joining the project would: what the
modules are, which way dependencies point, where the boundaries leak, where the design described
in the docs and the code disagree, and what will hurt first as the project grows.

The review is the core of this check: `finish` with a summary that a maintainer can read in five
minutes (structure, three strengths, the risks ranked), and record each concrete risk as a
finding anchored on the module it is about. Make each finding actionable: say what the change
would be, so it can be fixed when the maintainer chooses a fixing delivery for this check.

When fixing: take the smallest structural step that resolves the finding (move a module behind
its seam, invert one dependency, bring a doc back in line with the code). Behaviour must not
change. A finding that needs a design decision rather than an edit: leave it and say so.
