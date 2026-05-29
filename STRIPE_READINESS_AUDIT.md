# Stripe Readiness Audit

Date: May 12, 2026

## 1. Executive Summary

This repository is **not ready to add Stripe directly inside the extension**. It is a Chrome MV3 extension with a real side-panel UI, partial Clerk-based sign-in gating, and only local browser storage today. It does **not** include a developer-operated backend, a durable server-side user record, a billing data store, or a trusted entitlement API. Stripe can still be added with a small architecture, but the minimum safe version requires introducing a backend and tying it to a real user identity before paid access decisions are enforced.

The smallest correct launch shape is:

`extension UI -> authenticated backend -> Stripe Checkout -> Stripe webhook -> backend subscription record -> backend entitlement endpoint -> extension unlocks paid features`

That is materially smaller and safer than trying to bill from inside the extension runtime itself.

## 2. Current Architecture Findings

### Product/runtime shape

- This is a React + Vite Chrome extension, not a web app with an existing server. `package.json` contains extension/frontend dependencies only and no backend framework or database client dependencies (`react`, `react-dom`, `@clerk/chrome-extension`, Vite, Vitest, Playwright) ([package.json](./package.json), lines 1-40).
- The extension declares an MV3 service worker and side panel in `public/manifest.json` ([public/manifest.json](./public/manifest.json), lines 22-44).
- The README explicitly describes the app as a Chrome MV3 side-panel assistant and says it calls Anthropic directly from the extension runtime ([README.md](./README.md), lines 5-6, 19-26).

### Backend/server presence

- I found **no backend/server component** in the repo.
- I searched for common server patterns (`express`, `fastify`, `hono`, `koa`, API routes, Prisma, Drizzle, Supabase, Firebase, etc.) and found no implementation files for a developer-operated API.
- The privacy policy also explicitly says: "The extension does not include a developer-operated backend service for storing this data" ([PRIVACY.md](./PRIVACY.md), line 17).

### Authentication

- Clerk is implemented in the extension UI:
  - `src/main.tsx` wraps the app in `ClerkAuthProvider` and renders `ClerkUserControls` ([src/main.tsx](./src/main.tsx), lines 1-12).
  - `src/auth/ClerkAuth.tsx` uses `@clerk/chrome-extension`, gates signed-out users behind Clerk sign-in/sign-up buttons, and renders the app only for `signed-in` users ([src/auth/ClerkAuth.tsx](./src/auth/ClerkAuth.tsx), lines 31-69, 73-87, 90-110).
  - `.env.example` includes `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_FRONTEND_API`, and `CRX_PUBLIC_KEY` ([.env.example](./.env.example), lines 1-3).
  - `src/build/manifestConfig.ts` injects a Clerk host permission into the manifest when configured ([src/build/manifestConfig.ts](./src/build/manifestConfig.ts), lines 11-29).
- However, I found **no server-side Clerk integration**, no token exchange flow, no backend session validation, and no extension code retrieving a Clerk token to call a backend.
- There is also a bypass flag for extension tests/dev: `VITE_BYPASS_CLERK_AUTH` ([src/auth/ClerkAuth.tsx](./src/auth/ClerkAuth.tsx), line 18 and lines 31-34, 73-76).

### User/account model

- There is **no persistent server-side user/account model** in this repo.
- Today, "who the user is" is effectively:
  - a Clerk signed-in UI state in the extension, and
  - local extension data in `chrome.storage.local` / IndexedDB.
- There is no `users` table, no server account record, and no durable mapping between a human account and subscription data.

### Durable storage

- App settings are stored locally in `chrome.storage.local` (with localStorage fallback outside extension runtime) ([src/settings/settingsStore.ts](./src/settings/settingsStore.ts), lines 39-63).
- Chat history is stored locally in `chrome.storage.local` ([src/conversation/conversationStore.ts](./src/conversation/conversationStore.ts), lines 16-18, 65-79, 158-177).
- Workspace folder handles are stored in IndexedDB (`ohmygod.workspace`) ([src/filesystem/workspaceStore.ts](./src/filesystem/workspaceStore.ts), lines 91-103, 149-157, 178-208).
- The privacy policy confirms local storage of API keys, settings, chat history, evidence, and workspace handles ([PRIVACY.md](./PRIVACY.md), lines 11-17).

### API layer

- There is **no developer API layer** that the extension already calls for product/account/billing state.
- The service worker handles only internal extension messaging and run control, not external product APIs ([src/background/serviceWorker.ts](./src/background/serviceWorker.ts), lines 1-64, 66-155).
- Anthropic requests are sent directly from the extension to `https://api.anthropic.com/v1/messages` via `fetch` ([src/model/anthropicToolClient.ts](./src/model/anthropicToolClient.ts), lines 76, 89-106, 136-148).

### How the extension currently knows who the user is

- The visible app is gated by Clerk signed-in state in the side panel ([src/auth/ClerkAuth.tsx](./src/auth/ClerkAuth.tsx), lines 62-67).
- I did **not** find any separate server-recognized identity check.
- I also did **not** find entitlement checks, billing state checks, or paid feature gates.

### API keys and sensitive config

- Provider keys are stored locally in settings:
  - `apiKey`
  - `geminiApiKey`
  - `openaiApiKey`
  ([src/settings/providerSettings.ts](./src/settings/providerSettings.ts), lines 1-15)
- The settings UI says these keys are stored locally in the Chrome profile ([src/ui/components/SettingsPanel.tsx](./src/ui/components/SettingsPanel.tsx), lines 203-260).
- This local-only pattern is fine for user-supplied BYOK keys, but it is **not** acceptable for Stripe secret keys.

### Existing settings/subscription/billing UI

- There is a settings UI for workspace, activity/evidence panels, models, and API keys ([src/ui/components/SettingsPanel.tsx](./src/ui/components/SettingsPanel.tsx), lines 63-260).
- I found **no existing billing, plan, subscription, upgrade, or customer portal UI** in the app.
- Repo searches for `stripe`, `billing`, `subscription`, `upgrade`, `manage billing`, and `entitlement` found docs/tests references but no billing implementation.

## 3. Readiness Verdict: READY WITH BLOCKERS

Verdict: **READY WITH BLOCKERS**

Reasoning:

- The extension already has a viable signed-in UX surface and a place to add account/settings actions.
- Clerk is far enough along that it can become the identity layer for billing.
- But the app is missing the **minimum trusted server architecture** required for Stripe:
  - no backend
  - no server-side user record
  - no durable billing/subscription store
  - no authenticated entitlement endpoint
  - no webhook receiver

So the codebase is not "ready to wire Stripe in now," but it **is** ready for a small prerequisite phase that adds identity-backed server infrastructure first.

## 4. Required Prerequisites

### Must exist before enforcing paid access

1. A small backend service with HTTPS endpoints.
2. Server-side validation of extension user identity.
3. A durable database table for user billing state.
4. A Stripe secret-key environment on the backend only.
5. A webhook endpoint that receives raw Stripe events and verifies signatures.

### Recommended order

Add Stripe **alongside or immediately after** backend-backed auth, not before it.

### Can Stripe be added safely before auth?

Not for subscription gating.

You could technically create anonymous Checkout Sessions, but for this product that would leave you without a reliable way to:

- map the Stripe customer to the real extension user
- store entitlements per user
- re-check access on every launch
- let the extension prove who it is when asking for paid access
- recover billing for the same user across browser profiles/devices

For this app, Stripe-before-auth would create cleanup and support pain immediately. It is not the recommended path.

### Minimum identity layer required

Minimum safe identity layer:

- Clerk sign-in in the extension
- backend endpoint that validates a Clerk-issued token
- backend `user` record keyed by Clerk user ID
- Stripe customer ID stored against that user record

### Customer mapping

Recommended mapping:

- internal user primary key: `user.id`
- external auth key: `user.clerkUserId`
- Stripe customer key: `user.stripeCustomerId`

Do not treat email alone as the durable join key.

### Where subscription status should live

Server-side database only.

The extension can cache a last-known entitlement snapshot for UX, but the source of truth must be the backend.

### How the extension should prove identity

Recommended approach:

1. Extension obtains a Clerk session token.
2. Extension calls backend with `Authorization: Bearer <token>`.
3. Backend verifies token and resolves internal user.
4. Backend returns entitlements/subscription state.

## 5. Recommended Stripe Architecture

### Minimal safe architecture

`Chrome extension side panel`
`-> authenticated backend endpoint creates Checkout Session`
`-> browser opens Stripe-hosted Checkout`
`-> Stripe sends webhook to backend`
`-> backend updates subscription record`
`-> extension calls backend entitlement endpoint`
`-> extension unlocks paid features`

This matches Stripe’s documented subscription flow:

- create Checkout Sessions on the server ([Stripe Checkout Sessions API](https://docs.stripe.com/api/checkout/sessions))
- use Checkout subscription mode ([Stripe Checkout subscriptions guide](https://docs.stripe.com/payments/checkout/build-subscriptions?locale=en-GB))
- handle `checkout.session.completed` by webhook and save the created customer ([same Stripe guide](https://docs.stripe.com/payments/checkout/build-subscriptions?locale=en-GB))
- use webhooks, not redirect success alone, for fulfillment ([Stripe success page guidance](https://docs.stripe.com/payments/checkout/custom-success-page?locale=en-GB&payment-ui=embedded-components))
- create customer portal sessions on the server ([Stripe customer portal docs](https://docs.stripe.com/customer-management))

### Unsafe designs to explicitly reject

Do **not** do any of the following:

- Put a Stripe secret key in the extension bundle.
  - Stripe says secret keys must stay in your server environment and must never be embedded in applications ([Stripe key best practices](https://docs.stripe.com/keys-best-practices), [Stripe API keys](https://docs.stripe.com/keys)).
- Handle Stripe webhooks in the extension.
  - Webhooks are HTTPS server-to-server callbacks and must verify signatures against the raw body ([Stripe webhooks](https://docs.stripe.com/webhooks?lang=node), [signature verification](https://docs.stripe.com/webhooks/signature)).
- Trust a client-side `isPaid` flag.
- Unlock features based only on returning from Checkout `success_url`.
  - Stripe explicitly says webhooks are required for fulfillment and you cannot rely only on the landing page because customers may never load it ([Stripe success page docs](https://docs.stripe.com/payments/checkout/custom-success-page?locale=en-GB&payment-ui=embedded-components)).
- Store subscription truth only in `chrome.storage`.

### Whether to use Stripe Entitlements

Recommendation: **optional, not required for v1**.

Why:

- Stripe documents Entitlements as a way to map product features and provision/de-provision access from Stripe feature mappings ([Stripe Entitlements](https://docs.stripe.com/billing/entitlements?locale=en-GB)).
- For this product’s likely launch shape, one app-level paid tier is simpler to model with a local `subscriptionStatus` field on your backend.
- If you later add multiple feature bundles or plan-based capabilities, Entitlements becomes more attractive.

## 6. Minimal Endpoint Contract

These endpoints are the minimum recommended backend contract.

### `POST /api/billing/create-checkout-session`

Auth:

- Required. Valid Clerk bearer token.

Request:

```json
{
  "priceLookupKey": "pro-monthly"
}
```

Response:

```json
{
  "url": "https://checkout.stripe.com/c/pay/..."
}
```

Security notes:

- Resolve the user from the verified auth token, not from a client-submitted user ID.
- Resolve the Stripe Price server-side from an allowlist or lookup key.
- Reuse or create a Stripe customer for the authenticated user.
- Include metadata that helps correlate the session to the internal user, for example `userId` and `clerkUserId`.
- Set `mode=subscription`.
- Set `success_url` and `cancel_url` to trusted app-controlled routes/pages.

Failure behavior:

- `401` if not authenticated
- `409` if user already has an active subscription and should go to portal instead
- `400` if requested plan is invalid
- `500` on Stripe/server failure

### `POST /api/billing/create-portal-session`

Auth:

- Required.

Request:

```json
{}
```

Response:

```json
{
  "url": "https://billing.stripe.com/p/session/..."
}
```

Security notes:

- Look up the Stripe customer ID from the authenticated internal user.
- Do not accept `customerId` from the client.
- Only create a portal session if the user already has a Stripe customer record.

Failure behavior:

- `401` if not authenticated
- `404` if no Stripe customer exists yet
- `409` if billing is not yet initialized for that user

### `POST /api/stripe/webhook`

Auth:

- No user auth header. Trust is established through Stripe signature verification only.

Request:

- Raw request body from Stripe
- `Stripe-Signature` header

Response:

```json
{
  "received": true
}
```

Security notes:

- Verify signature with Stripe’s official library using raw request body, `Stripe-Signature`, and the webhook endpoint secret ([Stripe webhooks](https://docs.stripe.com/webhooks?lang=node), [signature troubleshooting](https://docs.stripe.com/webhooks/signature)).
- Return `2xx` quickly and defer heavy work if needed.
- Make processing idempotent by recording processed `event.id` values.
- Tolerate retries and out-of-order delivery. Stripe retries automatically for up to three days in live mode and does not guarantee ordering ([Stripe webhooks](https://docs.stripe.com/webhooks?lang=node)).

Failure behavior:

- `400` on bad signature
- `200` on already-processed duplicate
- `500` only for true transient processing failures that should be retried

### `GET /api/me/entitlements`

Auth:

- Required.

Request:

- No body.

Response:

```json
{
  "subscription": {
    "status": "active",
    "plan": "pro-monthly",
    "isActive": true,
    "cancelAtPeriodEnd": false,
    "currentPeriodEnd": "2026-06-12T00:00:00.000Z"
  }
}
```

Security notes:

- Resolve the user from the auth token.
- Return only the authenticated user’s entitlement data.
- This is the endpoint the extension should trust for paid feature gating.

Failure behavior:

- `401` if not authenticated
- `200` with `isActive: false` for signed-in free users

### Optional: `GET /api/billing/session-status?session_id=...`

This is optional and only for a better post-Checkout confirmation screen. It must **not** be the source of truth for unlocking access.

## 7. Minimal Data Model

Keep v1 minimal. One table can be enough if a server-side `users` table already exists; otherwise use a small companion billing table.

### Recommended fields

If stored on `users`:

- `id`
- `clerkUserId`
- `email` (optional convenience field, not join key)
- `stripeCustomerId`
- `stripeSubscriptionId`
- `stripePriceId`
- `subscriptionStatus`
- `subscriptionLookupKey`
- `currentPeriodEnd`
- `cancelAtPeriodEnd`
- `lastStripeEventId`
- `createdAt`
- `updatedAt`

If separated into `billing_accounts`:

- `userId` (unique FK)
- `stripeCustomerId`
- `stripeSubscriptionId`
- `stripePriceId`
- `subscriptionStatus`
- `subscriptionLookupKey`
- `currentPeriodEnd`
- `cancelAtPeriodEnd`
- `lastStripeEventId`
- `createdAt`
- `updatedAt`

### Event idempotency

Add either:

- `lastStripeEventId` on the billing row if you only do simple last-write handling, or preferably
- a dedicated `stripe_webhook_events` table keyed by `eventId`

Minimal `stripe_webhook_events` fields:

- `eventId` (PK/unique)
- `type`
- `processedAt`

This extra table is justified because Stripe retries events and doesn’t guarantee ordering.

## 8. Webhook Event Plan

### Minimum events to handle

Based on Stripe’s subscription and Checkout docs, the practical minimum set is:

- `checkout.session.completed`
  - Save the Stripe customer ID and correlate the Checkout to the internal user.
  - Stripe’s Checkout subscription guide says the customer returns to your site and that this webhook should be used to save the created customer and provision the subscription flow ([Stripe Checkout subscriptions guide](https://docs.stripe.com/payments/checkout/build-subscriptions?locale=en-GB)).
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
  - Stripe’s guide explicitly calls out these three subscription events for tracking active/overdue/cancelled status ([same guide](https://docs.stripe.com/payments/checkout/build-subscriptions?locale=en-GB)).
- `invoice.paid`
  - Stripe’s subscription webhook docs say you can provision access when the invoice is successfully paid and the subscription status is `active` ([Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)).
- `invoice.payment_failed`
  - Needed for delinquency state and user messaging ([same docs](https://docs.stripe.com/billing/subscriptions/webhooks)).

### Optional but useful

- `entitlements.active_entitlement_summary.updated`
  - Only if you adopt Stripe Entitlements ([Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks), [Stripe Entitlements](https://docs.stripe.com/billing/entitlements?locale=en-GB)).

### Processing rules

- Verify every webhook signature.
- Use raw request body.
- Make handlers idempotent.
- Treat events as eventually consistent.
- Do not assume ordering.
- Use object retrieval from Stripe when necessary to resolve ambiguity after out-of-order delivery.

## 9. Subscription Model Recommendation

Launch with **one monthly subscription**.

Optional:

- add one annual plan only if pricing/admin overhead is trivial

Do not launch with:

- usage-based billing
- metered add-ons
- multi-tier entitlements
- free trial unless product strategy strongly needs it

Why this is the right fit here:

- The app is still extension-first and BYOK-friendly.
- The near-term need is product access control, not complex billing math.
- One app subscription keeps Checkout, portal, webhook handling, support, and entitlement logic simple.
- BYOK can still be paid. The subscription is paying for the extension/product, not necessarily bundled model usage.

## 10. Extension UX Plan

Keep the UX small and consistent with the current Settings/account surface.

### Recommended placement

- Add an **Account** or **Billing** section inside the existing settings panel.
- Show:
  - current plan label
  - entitlement status badge
  - `Upgrade` button for free users
  - `Manage billing` button for paid users

### Locked feature behavior

- For premium-only actions, show the existing action UI plus a compact lock state and CTA.
- Do not redesign the whole app.
- Do not block basic sign-in/account management behind billing.

### Likely files affected later

- `src/ui/components/SettingsPanel.tsx`
- `src/app/App.tsx`
- a new extension-side billing client/helper
- possibly a new small account badge component

## 11. Security And Chrome Web Store Review Checklist

### Server-side only

These must stay server-side:

- Stripe secret API key
- webhook signing secret
- webhook processing
- Stripe customer/subscription truth
- entitlement truth

### Chrome permissions

Adding Stripe itself should not require new Chrome extension permissions if billing is handled through normal browser navigation/opened pages and backend API calls.

What does change:

- manifest host permissions may need the backend origin if the extension calls your API directly
- if Clerk remains in use, backend auth/token exchange must be disclosed accurately

### Privacy policy updates needed

Current privacy docs say there is no developer-operated backend ([PRIVACY.md](./PRIVACY.md), line 17). That will become false once billing is added.

Update the privacy policy and store disclosures to reflect:

- account identifiers sent to your backend
- Stripe customer/subscription metadata stored server-side
- third-party payment processor involvement
- whether billing email, customer ID, and subscription status are stored
- what remains local versus what becomes server-side

### Chrome Web Store disclosures and policy implications

Official Chrome docs reviewed:

- Chrome Web Store overview page says to "Disclose in-app purchases and set visibility" before publish/update ([Chrome Web Store docs](https://developer.chrome.com/docs/webstore?csw=1), lines 205-219).
- Chrome’s "Accepting Payment From Users" policy requires:
  - secure collection/storage/transmission of sensitive personal information
  - clear description of what is being sold
  - clear disclosure in the install description if payment is required for basic functionality
  - clear identification that you, not Google, are the seller
  ([Chrome policy](https://developer.chrome.com/docs/webstore/program-policies/accepting-payment), lines 100-108)
- Chrome’s disclosure policy requires transparency about data collection/use/sharing, and prominent disclosure plus affirmative consent if you collect user data not closely related to prominently described functionality ([Chrome disclosure policy](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements), lines 100-105).
- Chrome’s handling policy says not to publicly disclose financial/payment information or authentication information ([Chrome handling policy](https://developer.chrome.com/docs/webstore/program-policies/data-handling), lines 100-104).
- Chrome’s user data/privacy FAQ says privacy practices disclosures in the dashboard are required for publish/update and must match the privacy policy and actual behavior ([Chrome user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), lines 286-299).
- Chrome’s troubleshooting guide reiterates that financial/payment information and authentication information are sensitive, require a privacy policy, and must be securely transmitted ([Chrome troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting/), lines 423-425, 634-636, 658-662).

### Practical Chrome Web Store actions

- Update store listing to disclose paid subscription requirements if core functionality becomes paywalled.
- Fill out the privacy practices tab again once backend billing exists.
- Add/update the privacy policy URL.
- Ensure the listing and in-extension UX accurately describe:
  - what is free
  - what requires payment
  - what data goes to your backend
  - what data goes to Stripe

### Storage risks in extension

Do not store in extension storage:

- Stripe secret keys
- webhook secrets
- authoritative `isPaid` flags
- raw payment method details

It is acceptable to store:

- a non-authoritative cached entitlement snapshot for UI polish
- timestamps of last entitlement refresh

## 12. Phased Implementation Plan

## Phase 0 — Prerequisites / blockers

Scope:

- Introduce a minimal backend and durable DB.
- Decide the canonical auth model: Clerk-backed server auth.

Likely files affected:

- new backend app/repo package or adjacent service
- backend env config
- DB schema/migrations
- extension billing client config
- `PRIVACY.md`
- `docs/chrome-web-store-listing.md`

Acceptance criteria:

- Backend can authenticate extension users.
- Backend has a `users` record keyed by Clerk user ID.
- Backend can store Stripe IDs and subscription status.

Tests to run:

- backend auth integration test
- DB migration test
- extension-to-backend authenticated request smoke test

What not to touch:

- Anthropic direct-call architecture
- deterministic browser/research pipelines
- existing workspace permission model

## Phase 1 — Stripe test-mode backend integration

Scope:

- Add Stripe SDK to backend only.
- Create Stripe products/prices in test mode.
- Implement `POST /api/billing/create-checkout-session`.
- Implement `POST /api/billing/create-portal-session`.

Likely files affected:

- backend billing routes
- backend Stripe service module
- backend env docs
- extension billing client helper

Acceptance criteria:

- Authenticated user can start Checkout from extension.
- Authenticated paid user can open Customer Portal.
- No Stripe secret appears in extension code or manifest.

Tests to run:

- unit tests for session creation allowlist logic
- integration test for authenticated checkout creation
- negative test for unauthenticated access

What not to touch:

- do not build custom payment forms
- do not add Stripe Elements to extension UI

## Phase 2 — Webhook persistence and entitlement checks

Scope:

- Implement `POST /api/stripe/webhook`.
- Add idempotent event processing.
- Persist Stripe customer/subscription state.
- Implement `GET /api/me/entitlements`.

Likely files affected:

- backend webhook route
- backend billing persistence layer
- DB schema/migrations
- backend entitlement route

Acceptance criteria:

- Duplicate webhook deliveries do not corrupt state.
- Out-of-order deliveries do not leave entitlement state wrong.
- Extension can fetch authoritative entitlement state.

Tests to run:

- webhook signature verification tests
- duplicate event replay tests
- out-of-order event tests
- invoice paid / payment failed / subscription deleted state transition tests

What not to touch:

- do not trust Checkout redirect for unlocking features
- do not store subscription truth only in extension storage

## Phase 3 — Extension billing UI

Scope:

- Add small billing/account UI in settings.
- Add `Upgrade` and `Manage billing` actions.
- Add premium lock CTA states where needed.

Likely files affected:

- `src/ui/components/SettingsPanel.tsx`
- `src/app/App.tsx`
- new `src/billing/*` helper(s)
- possibly `src/app/styles.css`

Acceptance criteria:

- Free user sees upgrade path.
- Paid user sees plan state and portal link.
- Premium-gated actions consult backend entitlement response.

Tests to run:

- extension UI state tests
- mocked entitlement fetch tests
- Playwright happy path for upgrade CTA launch

What not to touch:

- do not redesign the app shell
- do not add broad new permissions unless strictly required

## Phase 4 — QA and Stripe CLI testing

Scope:

- End-to-end test mode validation.
- Stripe CLI webhook forwarding.
- Failure-path testing.

Likely files affected:

- test docs
- backend test fixtures
- optional Playwright mocks

Acceptance criteria:

- Checkout completion updates entitlements.
- Portal updates reflect back into app state.
- Failed payment state is visible and handled gracefully.

Tests to run:

- `stripe listen` + webhook forwarding
- `checkout.session.completed` replay
- `customer.subscription.updated` replay
- `customer.subscription.deleted` replay
- `invoice.payment_failed` replay

What not to touch:

- no live mode keys
- no production pricing switch yet

## Phase 5 — Production switch-over checklist

Scope:

- Move to live Stripe keys.
- Finalize Chrome Web Store/privacy disclosures.
- Roll out carefully.

Likely files affected:

- production env config
- privacy policy
- Chrome Web Store listing/disclosures
- support docs

Acceptance criteria:

- Live keys only on backend
- Webhook endpoint publicly reachable with TLS
- Listing/privacy disclosures updated
- Support path for refunds/cancellations documented

Tests to run:

- live-mode dry run on private/test listing if possible
- production webhook health check
- production portal session smoke test
- regression pass on extension auth/settings flows

What not to touch:

- no additional billing complexity at launch
- no usage billing without a separate decision

## 13. Exact Tests To Run

When implementation starts, run at minimum:

### Backend

1. Authenticated `create-checkout-session` returns a Stripe URL.
2. Unauthenticated `create-checkout-session` returns `401`.
3. Invalid plan lookup key returns `400`.
4. Authenticated `create-portal-session` returns a Stripe portal URL for an existing Stripe customer.
5. Webhook with invalid signature returns `400`.
6. Webhook with valid signature and `checkout.session.completed` stores `stripeCustomerId`.
7. Replaying the same webhook event twice is idempotent.
8. `customer.subscription.updated` changes subscription state correctly.
9. `customer.subscription.deleted` revokes paid access.
10. `invoice.paid` activates or confirms access.
11. `invoice.payment_failed` marks the account appropriately without granting access.
12. `GET /api/me/entitlements` returns the current server-side truth for the authenticated user.

### Extension

1. Signed-out user cannot access billing actions.
2. Signed-in free user sees `Upgrade`.
3. Signed-in paid user sees `Manage billing`.
4. Clicking `Upgrade` opens a backend-created Checkout flow.
5. Returning from Checkout does not unlock access until backend entitlement status becomes active.
6. Premium feature CTA refreshes entitlement state after checkout completion.
7. Cached local entitlement state never overrides a backend denial.

### Stripe CLI / integration

1. `stripe listen --forward-to <webhook-url>` works locally.
2. Test `checkout.session.completed` delivery.
3. Test `customer.subscription.updated`.
4. Test `customer.subscription.deleted`.
5. Test `invoice.payment_failed`.
6. Confirm duplicate deliveries do not create duplicate writes.

### Existing repo regression

Run these existing repo checks after extension-side billing UI changes:

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run test:extension`

## 14. Open Questions

1. Where will the backend live: same repo, adjacent service, or existing company backend not yet checked in here?
2. Is Clerk intended to be the long-term auth system, or only a temporary gate?
3. Which features are actually paid at launch:
   - all usage
   - advanced tools
   - workspace features
   - premium research/synthesis only
4. Does BYOK still require a paid subscription from day one?
5. Is there any need for annual pricing at launch, or should this stay monthly-only?
6. Will the extension call the backend directly from the side panel, or will part of billing orchestration live in the MV3 service worker?
7. Is there already an external database/service the team plans to use for auth + billing state?
8. Do you want the source of truth for access to be subscription-status-based only, or feature-flag-based in anticipation of multiple plans later?

## Official Documentation Reviewed

### Stripe

- Stripe Checkout subscriptions guide: https://docs.stripe.com/payments/checkout/build-subscriptions?locale=en-GB
- Stripe Checkout success page guidance: https://docs.stripe.com/payments/checkout/custom-success-page?locale=en-GB&payment-ui=embedded-components
- Stripe Checkout Sessions API: https://docs.stripe.com/api/checkout/sessions
- Stripe webhooks: https://docs.stripe.com/webhooks?lang=node
- Stripe webhook signature verification: https://docs.stripe.com/webhooks/signature
- Stripe customer portal: https://docs.stripe.com/customer-management
- Stripe subscriptions overview: https://docs.stripe.com/billing/subscriptions/overview
- Stripe subscription webhooks: https://docs.stripe.com/billing/subscriptions/webhooks
- Stripe entitlements: https://docs.stripe.com/billing/entitlements?locale=en-GB
- Stripe API keys: https://docs.stripe.com/keys
- Stripe secret key best practices: https://docs.stripe.com/keys-best-practices

### Chrome Web Store / Chrome for Developers

- Chrome Web Store overview: https://developer.chrome.com/docs/webstore?csw=1
- Chrome Web Store program policies: https://developer.chrome.com/docs/webstore/program-policies
- Accepting payment from users: https://developer.chrome.com/docs/webstore/program-policies/accepting-payment
- Disclosure requirements: https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements
- Handling requirements: https://developer.chrome.com/docs/webstore/program-policies/data-handling
- User data/privacy FAQ: https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- Chrome Web Store review process: https://developer.chrome.com/docs/webstore/review-process?authuser=1&hl=en
- Troubleshooting policy/privacy violations: https://developer.chrome.com/docs/webstore/troubleshooting/
- Update your item/privacy practices: https://developer.chrome.com/docs/webstore/update/
- Listing information: https://developer.chrome.com/docs/webstore/cws-dashboard-listing/
- Distribution / payment disclosure entry point: https://developer.chrome.com/docs/webstore/cws-dashboard-distribution
