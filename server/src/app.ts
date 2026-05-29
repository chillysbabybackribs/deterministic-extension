import cors, { type CorsOptions } from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { BillingNotFoundError } from "./billing.js";
import type {
  AuthenticatedRequestContext,
  Authenticator,
  BillingPlan,
  BillingService,
  EntitlementResponse,
  UserStore
} from "./types.js";
import type { StripeWebhookHandler } from "./webhook.js";
import { WebhookValidationError } from "./webhook.js";

type AppDeps = {
  authenticator: Authenticator;
  billingService: BillingService;
  userStore: UserStore;
  allowedOrigins: string[];
  webhookHandler?: StripeWebhookHandler;
};

type AuthedRequest = Request & {
  authContext?: AuthenticatedRequestContext;
};

const noOpWebhookHandler: StripeWebhookHandler = {
  async handleSession() {}
};

export function createApp({
  authenticator,
  billingService,
  userStore,
  allowedOrigins,
  webhookHandler = noOpWebhookHandler
}: AppDeps) {
  const app = express();

  app.use(cors(corsOptions(allowedOrigins)));

  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (request, response, next) => {
    const signature = request.header("stripe-signature");
    if (!signature) {
      response.status(400).json({ error: "Missing Stripe-Signature header." });
      return;
    }

    if (!(request.body instanceof Buffer)) {
      response.status(400).json({ error: "Webhook request body must be a raw JSON payload." });
      return;
    }

    try {
      await webhookHandler.handleSession({
        signature,
        body: request.body
      });

      response.json({ received: true });
    } catch (error) {
      if (error instanceof WebhookValidationError) {
        response.status(400).json({ error: error.message });
        return;
      }

      next(error);
    }
  });

  app.use(express.json());

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "billing-foundation-backend"
    });
  });

  app.get("/api/me", requireAuth({ authenticator, userStore }), (request, response) => {
    const authContext = (request as AuthedRequest).authContext;
    if (!authContext) {
      response.status(500).json({ error: "Missing authenticated user context." });
      return;
    }

    response.json({
      user: {
        id: authContext.user.id,
        clerkUserId: authContext.user.clerkUserId,
        email: authContext.user.email
      }
    });
  });

  app.get("/api/me/entitlements", requireAuth({ authenticator, userStore }), (request, response) => {
    const authContext = (request as AuthedRequest).authContext;
    if (!authContext) {
      response.status(500).json({ error: "Missing authenticated user context." });
      return;
    }

    response.json(toEntitlementResponse(authContext.user));
  });

  app.post("/api/billing/create-checkout-session", requireAuth({ authenticator, userStore }), async (request, response, next) => {
    const authContext = (request as AuthedRequest).authContext;
    if (!authContext) {
      response.status(500).json({ error: "Missing authenticated user context." });
      return;
    }

    const plan = request.body?.plan;
    if (!isBillingPlan(plan)) {
      response.status(400).json({ error: "Invalid billing plan." });
      return;
    }

    try {
      const session = await billingService.createCheckoutSession({
        user: authContext.user,
        plan
      });
      response.json(session);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/billing/create-portal-session", requireAuth({ authenticator, userStore }), async (request, response, next) => {
    const authContext = (request as AuthedRequest).authContext;
    if (!authContext) {
      response.status(500).json({ error: "Missing authenticated user context." });
      return;
    }

    try {
      const session = await billingService.createPortalSession({
        user: authContext.user
      });
      response.json(session);
    } catch (error) {
      if (error instanceof BillingNotFoundError) {
        response.status(404).json({ error: error.message });
        return;
      }

      next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error(error);
    response.status(500).json({ error: "Internal server error." });
  });

  return app;
}

function isBillingPlan(value: unknown): value is BillingPlan {
  return value === "pro-monthly";
}

function toEntitlementResponse(user: AuthenticatedRequestContext["user"]): EntitlementResponse {
  const now = Math.floor(Date.now() / 1000);
  const hasRecentPeriod =
    typeof user.stripeCurrentPeriodEnd === "number" && user.stripeCurrentPeriodEnd > now;
  const isActive = Boolean(
    user.stripeSubscriptionStatus &&
      ["active", "trialing", "past_due"].includes(user.stripeSubscriptionStatus) &&
      hasRecentPeriod
  );

  return {
    isActive,
    plan: user.stripeSubscriptionPlan,
    status: user.stripeSubscriptionStatus,
    currentPeriodEnd: user.stripeCurrentPeriodEnd
  };
}

function requireAuth({ authenticator, userStore }: Pick<AppDeps, "authenticator" | "userStore">) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const authResult = await authenticator(toFetchRequest(request));
      if (!authResult) {
        response.status(401).json({ error: "Unauthorized" });
        return;
      }

      const user = userStore.getOrCreateUser({
        clerkUserId: authResult.clerkUserId,
        email: authResult.email
      });

      (request as AuthedRequest).authContext = {
        clerkUserId: authResult.clerkUserId,
        sessionId: authResult.sessionId,
        email: authResult.email,
        user
      };

      next();
    } catch (error) {
      next(error);
    }
  };
}

function corsOptions(allowedOrigins: string[]): CorsOptions {
  const normalized = new Set(allowedOrigins.map((origin) => origin.trim()).filter(Boolean));

  return {
    origin(origin, callback) {
      if (!origin || normalized.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by backend CORS.`));
    }
  };
}

function toFetchRequest(request: Request): globalThis.Request {
  const origin = `${request.protocol}://${request.get("host")}`;
  const url = new URL(request.originalUrl || request.url, origin);
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const part of value) {
        headers.append(key, part);
      }
      continue;
    }

    if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  return new Request(url, {
    method: request.method,
    headers
  });
}
