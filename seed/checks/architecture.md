---
kind: architecture
title: Architecture review
revision: 1
scopes: [full]
agent: review
categories: [boundary-violation, dependency-direction, drift-from-docs, missing-seam, scaling-risk]
fixable: false
defaults: { enabled: true, delivery: report, auto_submit: false, armed: false, cadence_days: 30 }
---
Review the repository's architecture as a senior engineer joining the project would: what the
modules are, which way dependencies point, where the boundaries leak, where the design described
in the docs and the code disagree, and what will hurt first as the project grows.

This check never changes code. Its value is the written review: `finish` with a summary that a
maintainer can read in five minutes (structure, three strengths, the risks ranked), and record
each concrete risk as a finding anchored on the module it is about.
