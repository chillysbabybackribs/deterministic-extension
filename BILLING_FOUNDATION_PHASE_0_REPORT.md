# Billing Foundation Phase 0 Report

Date: May 12, 2026

## Summary Of What Was Added

Phase 0 added the minimum backend/auth foundation needed before Stripe can be introduced safely:

- a new backend service under `server/`
- a durable SQLite-backed `users` table
- server-side Clerk token verification
- authenticated `GET /api/me`
- extension-side backend API helper that fetches `/api/me` with `Authorization: Bearer <token>`
- backend env documentation
- privacy policy updates to remove the now-false "no backend" claim

No Stripe code, Stripe routes, Stripe dependencies, Stripe secrets, payment UI, billing state, or entitlement logic were added in this phase.

## Files Changed

Files added:

- `backend.env.example`
- `server/tsconfig.json`
- `server/src/app.ts`
- `server/src/app.test.ts`
- `server/src/clerkAuth.ts`
- `server/src/env.ts`
- `server/src/index.ts`
- `server/src/types.ts`
- `server/src/userStore.ts`
- `src/auth/backendClient.ts`
- `src/auth/backendClient.test.ts`
- `src/auth/useBackendApiClient.ts`
- `BILLING_FOUNDATION_PHASE_0_REPORT.md`

Files updated:

- `.env.example`
- `.gitignore`
- `package.json`
- `package-lock.json`
- `PRIVACY.md`
- `src/vite-env.d.ts`
- `vitest.config.ts`

## Backend Framework Chosen And Why

Framework chosen: **Express**

Why:

- The repo did not already contain a backend framework or server runtime.
- Express was the smallest maintainable option for:
  - health check routing
  - auth middleware
  - CORS
  - easy test coverage with `supertest`
- It avoided introducing a full-stack framework or ORM before billing actually exists.

Storage chosen: **SQLite via `better-sqlite3`**

Why:

- The repo had no existing database layer.
- SQLite is enough for the required Phase 0 durable user record.
- `better-sqlite3` keeps the persistence layer small and synchronous, which made the first authenticated user-store slice simple and testable.

## Clerk Docs Reviewed

Official Clerk docs used for this implementation:

- `authenticateRequest()` backend reference:
  - https://clerk.com/docs/reference/backend/authenticate-request
- Manual JWT verification / validate session tokens:
  - https://clerk.com/docs/request-authentication/validate-session-tokens
- Session token guide:
  - https://clerk.com/docs/guides/sessions/session-tokens
- Chrome extension `useAuth()` reference showing `getToken()`:
  - https://clerk.com/docs/chrome-extension/reference/hooks/use-auth

Implementation followed Clerk’s documented pattern:

- frontend gets a session token with `getToken()`
- backend authenticates the request with Clerk
- backend uses `authorizedParties`
- optional networkless verification is supported via `CLERK_JWT_KEY`

## Auth Verification Flow

Implemented flow:

1. The extension calls `useAuth().getToken()` through `src/auth/useBackendApiClient.ts`.
2. `src/auth/backendClient.ts` sends:
   - `Authorization: Bearer <token>`
3. The Express backend converts the incoming request to a standard `Request` object.
4. `server/src/clerkAuth.ts` calls Clerk backend SDK `authenticateRequest()`.
5. If Clerk verification fails, the request returns `401`.
6. If Clerk verification succeeds:
   - backend resolves `userId`
   - backend fetches the Clerk user to read email if available
   - backend loads or creates the durable internal user
   - authenticated user context is attached to the request
7. `GET /api/me` returns the internal user record.

## User Model / Storage Details

Durable user storage lives in SQLite.

Current schema:

- `id` `TEXT PRIMARY KEY`
- `clerk_user_id` `TEXT UNIQUE NOT NULL`
- `email` `TEXT NULL`
- `created_at` `TEXT NOT NULL`
- `updated_at` `TEXT NOT NULL`

Mapped API model:

```json
{
  "id": "internal-user-id",
  "clerkUserId": "clerk-user-id",
  "email": "user@example.com",
  "createdAt": "2026-05-12T00:00:00.000Z",
  "updatedAt": "2026-05-12T00:00:00.000Z"
}
```

Notes:

- no Stripe fields were added
- no billing tables were added
- no entitlement fields were added
- email is stored only if Clerk provides it

## `/api/me` Contract

Endpoint:

- `GET /api/me`

Auth:

- required
- bearer token from Clerk session

Unauthenticated response:

```json
{
  "error": "Unauthorized"
}
```

Authenticated response:

```json
{
  "user": {
    "id": "internal-user-id",
    "clerkUserId": "clerk-user-id",
    "email": "user@example.com"
  }
}
```

No billing or entitlement state is included yet.

## Extension Helper Details

Added:

- `src/auth/backendClient.ts`
- `src/auth/useBackendApiClient.ts`

What they do:

- derive the backend base URL from `VITE_BACKEND_API_URL`
- call Clerk `getToken()`
- send bearer-authenticated backend requests
- expose `fetchMe()`
- surface `401` and network failures as typed `BackendApiError`

This helper was intentionally kept small and not broadly wired into the UI yet.

## CORS / Manifest Changes

### CORS

Backend CORS is controlled by:

- `BACKEND_ALLOWED_ORIGINS`

Auth verification uses:

- `CLERK_AUTHORIZED_PARTIES`

These are separate so origin policy and Clerk JWT `azp` policy can be managed intentionally.

### Manifest / host permissions

No manifest change was required in this phase.

Reason:

- the existing extension manifest already includes localhost host permissions for dev
- the existing manifest already includes broad HTTPS page access for the extension’s research features

Important:

- **no new broad host permissions were added**
- **no backend-specific wildcard permissions were added**

## Privacy Policy Changes

`PRIVACY.md` was updated to remove the false statement that no developer-operated backend exists.

The updated policy now says the backend stores only the minimum account identifier data needed for authentication/account management:

- internal user ID
- Clerk user ID
- email when available
- created/updated timestamps

No payment or Stripe language was added.

## Tests Added

Backend tests:

- `/api/health` returns success
- `/api/me` without token returns `401`
- `/api/me` with invalid token returns `401`
- `/api/me` with valid Clerk-authenticated request creates and returns a durable user

Extension helper tests:

- bearer token is attached
- `401` is surfaced correctly
- backend unavailable/network failure is surfaced correctly
- helper source does not reference `CLERK_SECRET_KEY`

## Commands Run And Exact Results

### Dependency install

Command:

```bash
npm install express cors better-sqlite3 @clerk/backend supertest
npm install -D @types/express @types/cors @types/better-sqlite3 tsx @types/supertest
```

Result:

- install succeeded
- npm printed peer-resolution warnings related to React / React Native transitive dependencies
- no vulnerabilities reported

### Focused backend/helper verification

Command:

```bash
npm run backend:typecheck
```

Result:

- passed

Command:

```bash
npm run test -- --run server/src/app.test.ts src/auth/backendClient.test.ts
```

Result:

- passed
- `Test Files  2 passed (2)`
- `Tests  8 passed (8)`

### Backend build

Command:

```bash
npm run backend:build
```

Result:

- passed

### Local backend boot + health check

Command:

```bash
env BACKEND_PORT=8787 \
BACKEND_DATABASE_PATH=./server/data/test-health.sqlite \
BACKEND_ALLOWED_ORIGINS=http://127.0.0.1:5173 \
CLERK_AUTHORIZED_PARTIES=http://127.0.0.1:5173 \
CLERK_SECRET_KEY=sk_test_dummy \
CLERK_PUBLISHABLE_KEY=pk_test_dummy \
timeout 10s npm run backend:start
```

Result:

- backend started successfully
- output: `Backend listening on http://127.0.0.1:8787`

Command:

```bash
curl -s http://127.0.0.1:8787/api/health
```

Result:

```json
{"ok":true,"service":"billing-foundation-backend"}
```

### Existing regression commands

Command:

```bash
npm run typecheck
```

Result:

- passed

Command:

```bash
npm run test
```

Result:

- passed
- `Test Files  34 passed (34)`
- `Tests  238 passed (238)`

Command:

```bash
npm run build
```

Result:

- passed
- Vite production build completed successfully
- Vite emitted chunk-size warnings for large existing bundles, but the build succeeded

Command:

```bash
npm run test:extension
```

Result:

- passed
- Playwright extension suite result:
  - `3 passed`
  - `1 skipped`
- the skipped test was the existing live research trace test

## Known Limitations

Current limitations are intentional for Phase 0:

- no Stripe integration yet
- no webhook infrastructure
- no entitlement endpoint yet
- no billing or subscription tables yet
- no extension UI wired to show `/api/me`
- no production-grade migration system beyond schema creation on startup
- no production deployment manifest for the backend
- `CLERK_JWT_KEY` is optional, so token validation may rely on Clerk network calls unless the key is configured

## Next Recommended Phase

Next phase: **Phase 1 — Stripe test-mode backend integration**

Recommended next additions:

1. Add Stripe backend SDK and envs on the backend only.
2. Create Stripe products/prices in test mode.
3. Add:
   - `POST /api/billing/create-checkout-session`
   - `POST /api/billing/create-portal-session`
4. Keep subscription truth server-side.
5. Do not add client-side billing flags or Stripe secrets to the extension.

## Acceptance Criteria Check

- backend starts locally: yes
- `/api/health` works: yes
- `/api/me` rejects unauthenticated requests: yes
- authenticated Clerk token can resolve/create a durable user record: yes, covered by backend tests and middleware flow
- extension has a helper capable of calling backend with a Clerk token: yes
- no Stripe code exists yet: yes
- no Stripe secrets exist anywhere: yes
- no broad host permissions were added: yes
- existing extension tests/build still pass: yes
