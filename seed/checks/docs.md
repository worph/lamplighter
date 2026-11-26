---
kind: docs
title: Documentation drift
revision: 1
scopes: [diff, full]
agent: review
categories: [stale-readme, stale-reference, missing-doc, wrong-command, broken-link]
defaults: { enabled: true, delivery: push, auto_submit: true, armed: true, cadence_days: 7, admission: arbiter, lean: admit }
---
Check that the repository's documentation (README.md, CLAUDE.md, docs/**, inline usage text)
says what the code actually does.

Look for: commands, scripts, env vars, config keys, file paths, endpoints or APIs that the docs
mention but the code no longer has (or has under another name); features the code has that a
reader would need and that no doc mentions; instructions that would fail if followed.

Do not report style or tone. Do not report a doc for being short. Every finding must name the
doc file as its anchor and quote the stale statement.

When fixing: change the documentation only — never the code — and keep the existing voice and
structure of the document. Prefer correcting a sentence to rewriting a section.
