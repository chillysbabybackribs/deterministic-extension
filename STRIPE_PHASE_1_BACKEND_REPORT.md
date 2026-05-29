# Stripe Phase 1 Backend Report

## 1. Summary

Phase 1 is implemented as a narrow backend-only Stripe Checkout + Customer Portal integration.

- Added Stripe SDK and backend-only Stripe dependency wiring.
- Added backend env vars for test-mode Checkout/Portal behavior.
- Extended durable users with `stripe_customer_id`.
- Added authenticated backend endpoints:
  - `POST /api/billing/create-checkout-session`
  - `POST /api/billing/create-portal-session`
- Added backend client helpers in the extension for those two endpoints only.
- Added backend + extension test coverage for the requested success/failure flows.
- Left entitlement/status/policy logic and all UI billing surfaces out of Phase 1.
- No webhook endpoint was added in this phase.

## 2. Files Changed

- `package.json`
- `package-lock.json`
- `backend.env.example`
- `README.md`
- `server/src/env.ts`
- `server/src/types.ts`
- `server/src/userStore.ts`
- `server/src/billing.ts`
- `server/src/app.ts`
- `server/src/index.ts`
- `server/src/app.test.ts`
- `server/src/billing.test.ts`
- `src/auth/backendClient.ts`
- `src/auth/backendClient.test.ts`
- `STRIPE_PHASE_1_BACKEND_REPORT.md`

## 3. Official Stripe Docs Reviewed

- Quickstart for checkout-based subscription flow
  - https://docs.stripe.com/billing/quickstart
- Checkout Sessions API + session create endpoint
  - https://docs.stripe.com/api/checkout/sessions
  - https://docs.stripe.com/api/checkout/sessions/create
- Customer Portal sessions API
  - https://docs.stripe.com/api/customer_portal/sessions
  - https://docs.stripe.com/api/customer_portal/sessions/create
- API key handling
  - https://docs.stripe.com/keys
  - https://docs.stripe.com/keys-best-practices
- Webhook verification (reviewed to defer for Phase 2)
  - https://docs.stripe.com/webhooks/signature

## 4. Env Vars Added

Added to `backend.env.example`:

```bash
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key
STRIPE_PRICE_PRO_MONTHLY=price_test_your_monthly_price_id
STRIPE_CHECKOUT_SUCCESS_URL=http://127.0.0.1:5173/billing/success
STRIPE_CHECKOUT_CANCEL_URL=http://127.0.0.1:5173/billing/cancel
STRIPE_PORTAL_RETURN_URL=http://127.0.0.1:5173/settings
```

Not added to `.env.example` (Vite-extension env) and not loaded in extension code.

## 5. Data Model Changes

- `users` table now includes:
  - `stripe_customer_id TEXT NULL`
- Existing columns remain (`id`, `clerk_user_id`, `email`, timestamps).
- Migration behavior:
  - new DB: creates column directly in schema
  - existing DB: migrates with `ALTER TABLE users ADD COLUMN stripe_customer_id text`

`setStripeCustomerId` is the only additional write needed in this phase.

## 6. Stripe Customer Create / Reuse

Implemented in `server/src/billing.ts`:

1. Resolve durable user from authenticated Clerk request.
2. For Checkout:
   - if user has `stripe_customer_id`, reuse it.
   - if absent, create Stripe customer with `email` and metadata:
     - `internalUserId`
     - `clerkUserId`
   - persist `stripe_customer_id` in users table.
3. For Portal:
   - uses stored `stripe_customer_id` only.
   - never accepts a customer id in request body.

## 7. Checkout Endpoint Contract

`POST /api/billing/create-checkout-session`

- Auth: required Clerk bearer token.
- Request:

```json
{ "plan": "pro-monthly" }
```

- Response:

```json
{ "url": "https://checkout.stripe.com/..." }
```

- Behavior:
  - accepts only `pro-monthly`
  - maps to `STRIPE_PRICE_PRO_MONTHLY`
  - creates `mode: "subscription"` Checkout session
  - uses backend-controlled `STRIPE_CHECKOUT_SUCCESS_URL` and `STRIPE_CHECKOUT_CANCEL_URL`
  - adds metadata on session and subscription:
    - `internalUserId`
    - `clerkUserId`
    - `plan`
- Errors:
  - `401` missing/invalid token (app-level middleware)
  - `400` invalid plan
  - `500` for Stripe/server failures

## 8. Portal Endpoint Contract

`POST /api/billing/create-portal-session`

- Auth: required Clerk bearer token.
- Request:

```json
{}
```

- Response:

```json
{ "url": "https://billing.stripe.com/..." }
```

- Behavior:
  - resolves user from verified auth context
  - requires stored `stripe_customer_id`
  - ignores client-supplied `customerId`
  - returns Portal session URL using `STRIPE_PORTAL_RETURN_URL`
- Errors:
  - `401` missing/invalid token
  - `404` if user has no stored `stripe_customer_id`
  - `500` for Stripe/server failures

## 9. Extension Helper Changes

Updated `src/auth/backendClient.ts`:

- `createCheckoutSession(plan: "pro-monthly"): Promise<string>`
- `createPortalSession(): Promise<string>`

Both:

- use existing Clerk token flow
- call backend endpoints with `Authorization: Bearer <token>`
- parse `url` from server response
- throw `BackendApiError` for non-2xx and network issues

No Stripe SDK/secret is used in extension code.

## 10. CORS / Manifest Changes

- No host permission or manifest changes.
- No additional backend-origin permission additions beyond existing Phase 0 setup.
- Routes remain behind authenticated browser extension token flow.

## 11. Security Checks Performed

- `STRIPE_SECRET_KEY` reads only from backend env loader (`server/src/env.ts`).
- Backend Stripe secret and publishable key were not added to:
  - `.env.example`
  - extension source
  - `VITE_` env wiring
- Runtime path and payload checks enforce identity from Clerk auth only.
- Client never sends:
  - internal user id
  - Clerk user ID
  - Stripe customer ID for decisions
- Static test asserts that `backendClient.ts` has no `STRIPE_SECRET_KEY` or Clerk secret references.

## 12. Tests Added

Backend route tests (`server/src/app.test.ts`):

- checkout without token returns 401
- invalid plan returns 400
- checkout Stripe failure returns 500
- checkout returns URL from service
- portal without token returns 401
- portal returns 404 without existing customer
- portal returns URL with existing customer
- portal ignores client-provided `customerId`

Backend billing tests (`server/src/billing.test.ts`):

- creates and stores Stripe customer when absent
- reuses existing Stripe customer
- creates Checkout session with:
  - subscription mode
  - expected price ID
  - expected metadata
- creates Portal session for stored customer
- throws not-found when portal requested without customer
- propagates Stripe failures

Extension helper tests (`src/auth/backendClient.test.ts`):

- checkout helper attaches token
- checkout helper returns URL
- checkout helper surfaces backend errors (400)
- portal helper attaches token
- portal helper returns URL
- portal helper surfaces backend errors (404)
- helper client source has no Stripe secret references
- network failure surfaces as error

## 13. Commands Run and Exact Results

```bash
npm run backend:typecheck
```

- passed

```bash
npm run test -- --run server/src/app.test.ts server/src/billing.test.ts src/auth/backendClient.test.ts
```

- passed
- Test Files: 3 passed (3)
- Tests: 25 passed (25)

```bash
npm run backend:build
```

- passed

```bash
npm run typecheck
```

- passed

```bash
npm run test
```

- passed
- Test Files: 35 passed (35)
- Tests: 255 passed (255)

```bash
npm run build
```

- passed
- one Vite chunk-size warning only (existing)

```bash
npm run test:extension
```

- passed
- 3 passed, 1 skipped

## 14. Known Limitations

- No webhook endpoint in this phase.
- No webhook signature verification yet.
- No entitlements/subscription status persistence yet.
- No feature gating based on billing state yet.
- No paid UI/workflow added yet.
- Portal path requires prior Checkout-created Stripe customer mapping.

## 15. Next Recommended Phase

Phase 2 should move to correctness plumbing:

1. Add webhook endpoint with raw-body verification (`express.raw({ type: "application/json" })` at that route only).
2. Persist subscription lifecycle state and idempotent webhook event handling.
3. Add entitlement/status endpoint for the extension.
4. Use server-side entitlement truth for feature gates.
5. Keep checkout/portal helpers unchanged unless contract changes are required.
