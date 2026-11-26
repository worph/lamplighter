---
kind: dead-code
title: Dead code
revision: 1
scopes: [full]
agent: review
categories: [unused-export, unused-file, unused-function, unused-dependency, unreachable-code]
defaults: { enabled: true, delivery: pr, auto_submit: false, armed: true, cadence_days: 14, admission: arbiter, lean: admit }
---
Find code that nothing uses: exported symbols never imported, files never imported or
referenced, functions never called, dependencies in the manifest never imported, branches that
can never run.

Before reporting, prove it with `grep`: search for the symbol name across the whole repository
(including tests, scripts, configs, docs and string references such as dynamic imports or
route tables). Entry points (main/bin/exports fields, framework conventions, CLI commands,
public library API) are not dead because nothing in the repo imports them.

Anchor each finding on the file that holds the dead code. When fixing: delete only what you
reported, and remove imports that become unused as a result.
