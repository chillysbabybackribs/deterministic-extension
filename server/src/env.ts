import path from "node:path";

export type BackendEnv = {
  port: number;
  databasePath: string;
  allowedOrigins: string[];
  clerkAuthorizedParties: string[];
  clerkSecretKey?: string;
  clerkPublishableKey?: string;
  clerkJwtKey?: string;
  stripeSecretKey?: string;
  stripePriceProMonthly?: string;
  stripeCheckoutSuccessUrl?: string;
  stripeCheckoutCancelUrl?: string;
  stripePortalReturnUrl?: string;
  stripeWebhookSigningSecret?: string;
};

export function loadBackendEnv(env: NodeJS.ProcessEnv = process.env): BackendEnv {
  return {
    port: parsePort(env.BACKEND_PORT),
    databasePath: path.resolve(env.BACKEND_DATABASE_PATH?.trim() || "./server/data/app.sqlite"),
    allowedOrigins: parseCsvEnv(env.BACKEND_ALLOWED_ORIGINS, ["http://127.0.0.1:5173", "http://localhost:5173"]),
    clerkAuthorizedParties: parseCsvEnv(
      env.CLERK_AUTHORIZED_PARTIES,
      ["http://127.0.0.1:5173", "http://localhost:5173"]
    ),
    clerkSecretKey: trimOptional(env.CLERK_SECRET_KEY),
    clerkPublishableKey: trimOptional(env.CLERK_PUBLISHABLE_KEY),
    clerkJwtKey: normalizeMultilinePem(env.CLERK_JWT_KEY),
    stripeSecretKey: trimOptional(env.STRIPE_SECRET_KEY),
    stripePriceProMonthly: trimOptional(env.STRIPE_PRICE_PRO_MONTHLY),
    stripeCheckoutSuccessUrl: trimOptional(env.STRIPE_CHECKOUT_SUCCESS_URL),
    stripeCheckoutCancelUrl: trimOptional(env.STRIPE_CHECKOUT_CANCEL_URL),
    stripePortalReturnUrl: trimOptional(env.STRIPE_PORTAL_RETURN_URL),
    stripeWebhookSigningSecret: trimOptional(env.STRIPE_WEBHOOK_SIGNING_SECRET)
  };
}

export function requireClerkBackendEnv(env: BackendEnv): Required<Pick<BackendEnv, "clerkSecretKey" | "clerkPublishableKey">> & BackendEnv {
  if (!env.clerkSecretKey) {
    throw new Error("Missing CLERK_SECRET_KEY.");
  }

  if (!env.clerkPublishableKey) {
    throw new Error("Missing CLERK_PUBLISHABLE_KEY.");
  }

  return {
    ...env,
    clerkSecretKey: env.clerkSecretKey,
    clerkPublishableKey: env.clerkPublishableKey
  };
}

export function requireStripeBillingEnv(
  env: BackendEnv
): Required<
  Pick<
    BackendEnv,
    | "stripeSecretKey"
    | "stripePriceProMonthly"
    | "stripeCheckoutSuccessUrl"
    | "stripeCheckoutCancelUrl"
    | "stripePortalReturnUrl"
    | "stripeWebhookSigningSecret"
  >
> &
  BackendEnv {
  if (!env.stripeSecretKey) {
    throw new Error("Missing STRIPE_SECRET_KEY.");
  }

  if (!env.stripePriceProMonthly) {
    throw new Error("Missing STRIPE_PRICE_PRO_MONTHLY.");
  }

  if (!env.stripeCheckoutSuccessUrl) {
    throw new Error("Missing STRIPE_CHECKOUT_SUCCESS_URL.");
  }

  if (!env.stripeCheckoutCancelUrl) {
    throw new Error("Missing STRIPE_CHECKOUT_CANCEL_URL.");
  }

  if (!env.stripePortalReturnUrl) {
    throw new Error("Missing STRIPE_PORTAL_RETURN_URL.");
  }

  if (!env.stripeWebhookSigningSecret) {
    throw new Error("Missing STRIPE_WEBHOOK_SIGNING_SECRET.");
  }

  return {
    ...env,
    stripeSecretKey: env.stripeSecretKey,
    stripePriceProMonthly: env.stripePriceProMonthly,
    stripeCheckoutSuccessUrl: env.stripeCheckoutSuccessUrl,
    stripeCheckoutCancelUrl: env.stripeCheckoutCancelUrl,
    stripePortalReturnUrl: env.stripePortalReturnUrl,
    stripeWebhookSigningSecret: env.stripeWebhookSigningSecret
  };
}

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value?.trim() || "8787", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8787;
}

function parseCsvEnv(value: string | undefined, fallback: string[] = []): string[] {
  const parsed = (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return parsed.length ? parsed : fallback;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeMultilinePem(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\\n/g, "\n") : undefined;
}
