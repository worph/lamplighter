---
kind: deps
title: Outdated dependencies
revision: 2
scopes: [full]
agent: none
detectors: [npm-outdated]
categories: [outdated-major, outdated-minor]
defaults: { enabled: true, delivery: report, auto_submit: false, armed: false, cadence_days: 7 }
---
Detector-only in v1: each direct dependency in package.json is compared with the registry's
`latest`. Patch-level drift is not reported.

When fixing: bump the range in package.json, keeping its prefix style (`^`, `~`, exact). For a
major bump, read the dependency's usage in the code and adapt call sites the changelog says
changed; if you cannot tell, leave that finding. Sessions cannot run a package manager, so do not
hand-edit the lockfile: say in the summary that `npm install` must be run before this lands.
