---
kind: security
title: Security review
revision: 2
scopes: [diff, full]
agent: review
detectors:            # hints for the review, in the sandbox only: committed secrets, history included
  - name: gitleaks
    image: docker.io/zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
    run: [git, /work/repo, --report-format, sarif, --report-path, /dev/stdout, --no-banner, --log-level, error, --exit-code, '0']
    format: sarif
    category: secret-in-code
categories: [injection, authn-authz, secret-in-code, unsafe-deserialization, path-traversal, ssrf, xss, crypto-misuse]
sensitive: always
defaults: { enabled: true, delivery: branch, auto_submit: false, armed: false, cadence_days: 14, admission: arbiter, lean: admit }
always_when: { severity: [critical, major] }
---
Review the code for exploitable security problems: injection (SQL, command, template, eval),
missing or broken authentication and authorization, secrets committed to the repository,
unsafe deserialization, path traversal, SSRF, XSS, misuse of cryptography.

Only report what an attacker could actually reach, and say how (the input, the route, the
call). Severity: critical = remote and unauthenticated, major = needs some access, minor =
defence in depth. When fixing, change as little as possible and never weaken an existing check.
