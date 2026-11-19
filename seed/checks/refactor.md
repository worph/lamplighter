---
kind: refactor
title: Refactoring opportunities
revision: 1
scopes: [full]
agent: review
categories: [duplication, oversized-unit, tangled-responsibility, needless-indirection]
defaults: { enabled: true, delivery: pr, auto_submit: false, armed: false, cadence_days: 30 }
---
Find places where the structure of the code makes it harder to change than it needs to be:
duplicated logic that has already drifted or will, functions or modules doing several unrelated
jobs, indirection layers that add nothing.

Report at most five findings, the ones with the best value for the effort. Each must say what
the change would be and why it is safe. Behaviour must not change.
