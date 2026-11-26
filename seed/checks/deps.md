---
kind: deps
title: Outdated dependencies
revision: 3
scopes: [full]
agent: none
detectors: [npm-outdated]
categories: [outdated-major, outdated-minor]
defaults: { enabled: true, delivery: report, auto_submit: false, armed: false, cadence_days: 7, admission: arbiter, lean: admit }
---
Detector-only: each direct dependency in package.json is compared with the registry's
`latest`. Patch-level drift is not reported.

When fixing: bump the range in package.json, keeping its prefix style (`^`, `~`, exact). For a
major bump, read the dependency's usage in the code and adapt call sites the changelog says
changed; if you cannot tell, leave that finding.

In the sandbox, refresh the lockfile with the package manager (`npm install <name>@<range>`) and
run the tests: a major bump that breaks them is yours to fix in the code, until they pass.
Without the sandbox, do not hand-edit the lockfile: say in the summary that `npm install` must be
run before this lands.
