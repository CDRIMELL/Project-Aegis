# 0010 — Security hooks from day one; encryption deferred

- Status: Accepted
- Date: 2026-10-04

## Context

Full authentication, MFA and database encryption are scheduled for phase 9. Retrofitting the places
where they attach is far more expensive than reserving them now.

## Decision

Milestone 1 puts the following in place:

- **Session gate in Rust.** Every database command first asks a `SessionGate` whether the session is
  unlocked. Until authentication exists the gate opens at startup; phase 9 replaces that single call
  with a real login. The webview cannot bypass it.
- **Encryption seam.** The database is opened through `OpenOptions { path, encryption }`. Today the
  only variant is `Encryption::None`. An encrypted variant (SQLCipher, key derived from the user's
  password) can be added without changing any caller.
- **Statement guard.** Transaction control, `PRAGMA`, `ATTACH`, `DETACH` and `VACUUM` are rejected
  over IPC (ADR 0003).
- **Least-privilege capabilities.** The window is granted only the Tauri permissions it uses.
- **Content Security Policy.** Scripts, styles, fonts and workers load from the application bundle
  only. No remote content.
- **Typed errors.** Commands return a code and a message; internal detail is not leaked to the UI.
- **Validation at boundaries.** Data read back from the database is parsed with Zod before the
  simulation trusts it.

## Explicitly not done yet

Password hashing, TOTP, recovery codes, auto-lock, the security audit trail and encryption at rest.
Until phase 9 the database is a plain file readable by anyone with access to the user's profile.

## Consequences

- Phase 9 adds behaviour behind existing seams instead of restructuring the persistence layer.
- The interim gate is honest about what it is: a hook, not a control.
