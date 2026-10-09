# ADR 0003: GitHub auth — opaque server session, not client tokens

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

[ADR 0001](0001-persistence-github-first.md) requires the Hono API to hold GitHub App / OAuth secrets and perform authenticated writes. That still leaves how the **browser** proves it is signed in.

If the SPA receives a GitHub OAuth access token (JWT in `localStorage`, `?token=` on redirect, or any readable cookie), XSS or a malicious script can steal it and act as the user against GitHub. Packing the OAuth token into a client JWT with the App PEM / `jsonwebtoken` has the same failure mode: the secret material leaves the server.

Dev also splits origins (Vite `:5173` → API `:8080` via proxy). Session cookies must be set on the origin the browser actually talks to, or `Set-Cookie` never sticks.

## Decision

1. **Opaque server-side session.** After OAuth completes, the API stores the GitHub access token in a server session. The browser never receives the GitHub OAuth access token.
2. **Session cookie only.** Issue an HttpOnly cookie named `sid`, with `Secure` when the request is HTTPS, and `SameSite=Lax`. Do not put auth tokens in `localStorage`. Do not put `?token=` (or similar) on the OAuth redirect back to the app.
3. **OAuth `state` CSRF.** Generate cryptographic `state`, store it server-side, send it with the authorize redirect, verify it on callback, then delete it (one-time use). Mismatch or missing state on a code-exchange callback → HTTP 401 (fail closed; same status as an unauthenticated session). A GitHub installation/update return can carry `code`, `installation_id`, and `setup_action` without state: discard that unverified code and never authorize repositories from the URL's installation ID. A valid existing session returns to the app; otherwise start a new state-protected OAuth flow. An explicitly supplied invalid state is never downgraded to this installation-return path.
4. **Dev cookie topology.** `GITHUB_OAUTH_CALLBACK_URL` must be the Vite/browser origin (e.g. `http://127.0.0.1:5173/github/authorize`) so the authorize response’s `Set-Cookie` is attached via the Vite proxy to the page origin. Production is same-origin API + static assets (cookie host is unambiguous).
5. **In-memory session store.** Sessions live in a process-local `Map` with a **24h sliding TTL**. Process restart or multi-dyno without sticky/shared store logs the user out. A shared store (e.g. Redis) is deferred until multi-instance deployment needs it.
6. **`ENABLE_LOCAL` gate.** Local sibling/`zmk-config` routes (`/layout`, `/keymap`) are available only when `ENABLE_LOCAL` is true. Default that flag to **false** in env templates / examples.
7. **Local save vs `git status`.** Local save must not treat a non-zero `git status` exit code as failure of the write itself (dirty trees are normal).
8. **App PEM / `jsonwebtoken` scope.** Use the GitHub App private key and JWT libraries **only** to mint GitHub App installation JWTs for the GitHub API — not to pack OAuth access tokens into client-bearer tokens.

## Consequences

### Positive

- XSS cannot steal the GitHub OAuth access token from the browser.
- Logout can revoke the server session immediately.
- OAuth CSRF via forged `state` is closed by verify-and-delete.

### Negative / trade-offs

- In-memory sessions are lost on API restart; users must sign in again.
- Multi-instance / multi-dyno deploys need a shared session store later (or sticky sessions as a stopgap).
- Local Vite requires `GITHUB_OAUTH_CALLBACK_URL` on `:5173` (proxy path); pointing the callback at `:8080` directly breaks cookie attachment for the SPA origin.

## References

- Persistence boundary: [ADR 0001](0001-persistence-github-first.md)
- Vision: [TARGET_SYSTEM.md](../TARGET_SYSTEM.md)
- Implementation surface: `apps/api` GitHub auth routes (`apps/api/src/routes/github.ts`, `apps/api/src/services/github/auth.ts`)
