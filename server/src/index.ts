import { createApp } from "./app.js";
import { createStripeBillingService } from "./billing.js";
import { createClerkAuthenticator } from "./clerkAuth.js";
import { createStripeWebhookHandler } from "./webhook.js";
import { loadBackendEnv, requireClerkBackendEnv, requireStripeBillingEnv } from "./env.js";
import { SqliteUserStore } from "./userStore.js";
import Stripe from "stripe";

const env = requireStripeBillingEnv(requireClerkBackendEnv(loadBackendEnv()));
const userStore = new SqliteUserStore(env.databasePath);
const authenticator = createClerkAuthenticator(env);
const stripeClient = new Stripe(env.stripeSecretKey);
const webhookHandler = createStripeWebhookHandler({
  env,
  userStore,
  stripeClient
});
const billingService = createStripeBillingService({
  env,
  userStore
});
const app = createApp({
  authenticator,
  billingService,
  userStore,
  allowedOrigins: env.allowedOrigins,
  webhookHandler
});

app.listen(env.port, () => {
  console.log(`Backend listening on http://127.0.0.1:${env.port}`);
});
