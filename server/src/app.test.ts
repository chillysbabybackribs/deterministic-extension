import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { BillingNotFoundError } from "./billing.js";
import { WebhookValidationError } from "./webhook.js";
import { createMemoryUserStore, type SqliteUserStore } from "./userStore.js";
import type { AuthResult, Authenticator, BillingService } from "./types.js";

describe("backend app", () => {
  let userStore: SqliteUserStore | undefined;

  afterEach(() => {
    userStore?.close();
    userStore = undefined;
  });

  it("returns a healthy status from /api/health", async () => {
    const app = buildApp(async () => null);

    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      service: "billing-foundation-backend"
    });
  });

  it("rejects /api/me when the bearer token is missing", async () => {
    const app = buildApp(async (req) => {
      expect(req.headers.get("authorization")).toBeNull();
      return null;
    });

    const response = await request(app).get("/api/me");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects /api/me when the bearer token is invalid", async () => {
    const app = buildApp(async (req) => {
      expect(req.headers.get("authorization")).toBe("Bearer invalid-token");
      return null;
    });

    const response = await request(app)
      .get("/api/me")
      .set("Authorization", "Bearer invalid-token");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
  });

  it("creates and returns a durable user for a valid Clerk-authenticated request", async () => {
    const authResult: AuthResult = {
      clerkUserId: "user_clerk_123",
      sessionId: "sess_123",
      email: "person@example.com"
    };
    const app = buildApp(async (req) => {
      expect(req.headers.get("authorization")).toBe("Bearer valid-token");
      return authResult;
    });

    const first = await request(app)
      .get("/api/me")
      .set("Authorization", "Bearer valid-token");
    const second = await request(app)
      .get("/api/me")
      .set("Authorization", "Bearer valid-token");

    expect(first.status).toBe(200);
    expect(first.body.user).toMatchObject({
      clerkUserId: "user_clerk_123",
      email: "person@example.com"
    });
    expect(first.body.user.id).toEqual(second.body.user.id);
  });

  it("rejects checkout session creation without a token", async () => {
    const app = buildApp(async () => null);

    const response = await request(app)
      .post("/api/billing/create-checkout-session")
      .send({ plan: "pro-monthly" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects checkout session creation for an invalid plan", async () => {
    const billingService = createBillingService();
    const app = buildApp(validAuthenticator, billingService);

    const response = await request(app)
      .post("/api/billing/create-checkout-session")
      .set("Authorization", "Bearer valid-token")
      .send({ plan: "invalid-plan" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid billing plan." });
    expect(billingService.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns a controlled 500 when checkout session creation fails", async () => {
    const billingService = createBillingService({
      createCheckoutSession: vi.fn().mockRejectedValue(new Error("Stripe exploded"))
    });
    const app = buildApp(validAuthenticator, billingService);

    const response = await request(app)
      .post("/api/billing/create-checkout-session")
      .set("Authorization", "Bearer valid-token")
      .send({ plan: "pro-monthly" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error." });
  });

  it("returns checkout session URL from billing service", async () => {
    const billingService = createBillingService({
      createCheckoutSession: vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/pay/session_123" })
    });
    const app = buildApp(validAuthenticator, billingService);

    const response = await request(app)
      .post("/api/billing/create-checkout-session")
      .set("Authorization", "Bearer valid-token")
      .send({ plan: "pro-monthly" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ url: "https://checkout.stripe.com/pay/session_123" });
    expect(billingService.createCheckoutSession).toHaveBeenCalledWith({
      user: expect.objectContaining({ clerkUserId: "user_clerk_123" }),
      plan: "pro-monthly"
    });
  });

  it("rejects portal session creation without a token", async () => {
    const app = buildApp(async () => null);

    const response = await request(app)
      .post("/api/billing/create-portal-session")
      .send({});

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects entitlement checks without a token", async () => {
    const app = buildApp(async () => null);

    const response = await request(app).get("/api/me/entitlements");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
  });

  it("returns entitlement status for a known user", async () => {
    const app = buildApp(validAuthenticator, createBillingService());

    const authUser = userStore?.getOrCreateUser({
      clerkUserId: "user_clerk_123",
      email: "person@example.com"
    });

    const futureDate = Math.floor(Date.now() / 1000) + 3600;
    if (authUser) {
      userStore?.setStripeSubscriptionState({
        userId: authUser.id,
        stripeSubscriptionId: "sub_123",
        stripeSubscriptionStatus: "active",
        stripeSubscriptionPlan: "pro-monthly",
        stripeCurrentPeriodEnd: futureDate
      });
    }

    const response = await request(app)
      .get("/api/me/entitlements")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      isActive: true,
      plan: "pro-monthly",
      status: "active",
      currentPeriodEnd: futureDate
    });
  });

  it("accepts webhook calls with raw body and successful signature validation", async () => {
    const webhookHandler = {
      handleSession: vi.fn().mockResolvedValue(undefined)
    };
    const app = buildApp(validAuthenticator, createBillingService(), webhookHandler);

    const response = await request(app)
      .post("/api/stripe/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=abc")
      .send('{"type":"checkout.session.completed","id":"evt_1"}');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(webhookHandler.handleSession).toHaveBeenCalledWith({
      signature: "t=123,v1=abc",
      body: expect.any(Buffer)
    });
  });

  it("rejects webhook requests without a signature header", async () => {
    const webhookHandler = {
      handleSession: vi.fn().mockResolvedValue(undefined)
    };
    const app = buildApp(validAuthenticator, createBillingService(), webhookHandler);

    const response = await request(app)
      .post("/api/stripe/webhook")
      .set("Content-Type", "application/json")
      .send('{"type":"checkout.session.completed","id":"evt_1"}');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Missing Stripe-Signature header." });
    expect(webhookHandler.handleSession).not.toHaveBeenCalled();
  });

  it("returns 400 for webhook signature validation failures", async () => {
    const webhookHandler = {
      handleSession: vi.fn().mockRejectedValue(new WebhookValidationError("Invalid signature."))
    };
    const app = buildApp(validAuthenticator, createBillingService(), webhookHandler);

    const response = await request(app)
      .post("/api/stripe/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "invalid")
      .send('{"type":"checkout.session.completed","id":"evt_1"}');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid signature." });
  });

  it("returns 404 when no stripe customer exists for a portal session", async () => {
    const billingService = createBillingService({
      createPortalSession: vi.fn().mockRejectedValue(new BillingNotFoundError("No Stripe customer exists for this user yet."))
    });
    const app = buildApp(validAuthenticator, billingService);

    const response = await request(app)
      .post("/api/billing/create-portal-session")
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "No Stripe customer exists for this user yet." });
  });

  it("returns portal session URL from billing service", async () => {
    const billingService = createBillingService();
    const app = buildApp(validAuthenticator, billingService);

    const response = await request(app)
      .post("/api/billing/create-portal-session")
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ url: "https://billing.stripe.com/session/test" });
    expect(billingService.createPortalSession).toHaveBeenCalledWith({
      user: expect.objectContaining({ clerkUserId: "user_clerk_123" })
    });
  });

  it("ignores any client-provided customer id when creating a portal session", async () => {
    const billingService = createBillingService();
    const app = buildApp(validAuthenticator, billingService);

    const response = await request(app)
      .post("/api/billing/create-portal-session")
      .set("Authorization", "Bearer valid-token")
      .send({ customerId: "cus_from_client_should_be_ignored" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ url: "https://billing.stripe.com/session/test" });
    expect(billingService.createPortalSession).toHaveBeenCalledWith({
      user: expect.objectContaining({
        clerkUserId: "user_clerk_123"
      })
    });
  });

  it("does not grant entitlement when subscription period end is missing", async () => {
    const app = buildApp(validAuthenticator, createBillingService());

    const authUser = userStore?.getOrCreateUser({
      clerkUserId: "user_clerk_123",
      email: "person@example.com"
    });
    if (authUser) {
      userStore?.setStripeSubscriptionState({
        userId: authUser.id,
        stripeSubscriptionId: "sub_123",
        stripeSubscriptionStatus: "active",
        stripeSubscriptionPlan: "pro-monthly",
        stripeCurrentPeriodEnd: null
      });
    }

    const response = await request(app)
      .get("/api/me/entitlements")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      isActive: false,
      plan: "pro-monthly",
      status: "active",
      currentPeriodEnd: null
    });
  });

  function buildApp(
    authenticator: Authenticator,
    billingService: BillingService = createBillingService(),
    webhookHandler?: { handleSession: () => Promise<void> }
  ) {
    userStore = createMemoryUserStore();

    return createApp({
      authenticator,
      billingService,
      userStore,
      webhookHandler,
      allowedOrigins: ["http://127.0.0.1:5173", "chrome-extension://test-extension-id"]
    });
  }
});

const validAuthenticator: Authenticator = async (req) => {
  expect(req.headers.get("authorization")).toBe("Bearer valid-token");
  return {
    clerkUserId: "user_clerk_123",
    sessionId: "sess_123",
    email: "person@example.com"
  };
};

function createBillingService(overrides: Partial<BillingService> = {}): BillingService {
  return {
    createCheckoutSession: vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/pay/test" }),
    createPortalSession: vi.fn().mockResolvedValue({ url: "https://billing.stripe.com/session/test" }),
    ...overrides
  };
}
