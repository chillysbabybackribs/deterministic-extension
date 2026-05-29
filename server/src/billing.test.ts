import { describe, expect, it, vi } from "vitest";
import { BillingNotFoundError, createStripeBillingService } from "./billing.js";
import { createMemoryUserStore } from "./userStore.js";

describe("createStripeBillingService", () => {
  it("creates and stores a stripe customer before creating a checkout session", async () => {
    const userStore = createMemoryUserStore();
    const user = userStore.getOrCreateUser({
      clerkUserId: "clerk_user_1",
      email: "person@example.com"
    });
    const stripeClient = createStripeClient();
    const service = createStripeBillingService({
      env: testEnv(),
      userStore,
      stripeClient
    });

    const result = await service.createCheckoutSession({
      user,
      plan: "pro-monthly"
    });

    expect(result.url).toBe("https://checkout.stripe.com/pay/cs_test_123");
    expect(stripeClient.customers.create).toHaveBeenCalledWith({
      email: "person@example.com",
      metadata: {
        internalUserId: user.id,
        clerkUserId: "clerk_user_1"
      }
    });
    expect(stripeClient.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        customer: "cus_created_123",
        success_url: "http://127.0.0.1:5173/billing/success",
        cancel_url: "http://127.0.0.1:5173/billing/cancel",
        line_items: [
          {
            price: "price_test_monthly",
            quantity: 1
          }
        ],
        metadata: {
          internalUserId: user.id,
          clerkUserId: "clerk_user_1",
          plan: "pro-monthly"
        },
        subscription_data: {
          metadata: {
            internalUserId: user.id,
            clerkUserId: "clerk_user_1",
            plan: "pro-monthly"
          }
        }
      })
    );

    const reusedUser = userStore.getOrCreateUser({
      clerkUserId: "clerk_user_1",
      email: "person@example.com"
    });
    expect(reusedUser.stripeCustomerId).toBe("cus_created_123");
    userStore.close();
  });

  it("reuses an existing stripe customer for checkout", async () => {
    const userStore = createMemoryUserStore();
    const created = userStore.getOrCreateUser({
      clerkUserId: "clerk_user_1",
      email: "person@example.com"
    });
    const existingUser = userStore.setStripeCustomerId(created.id, "cus_existing_123");
    const stripeClient = createStripeClient();
    const service = createStripeBillingService({
      env: testEnv(),
      userStore,
      stripeClient
    });

    await service.createCheckoutSession({
      user: existingUser,
      plan: "pro-monthly"
    });

    expect(stripeClient.customers.create).not.toHaveBeenCalled();
    expect(stripeClient.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_existing_123"
      })
    );
    userStore.close();
  });

  it("returns a portal session url for a user with an existing stripe customer id", async () => {
    const userStore = createMemoryUserStore();
    const created = userStore.getOrCreateUser({
      clerkUserId: "clerk_user_1",
      email: "person@example.com"
    });
    const user = userStore.setStripeCustomerId(created.id, "cus_existing_123");
    const stripeClient = createStripeClient();
    const service = createStripeBillingService({
      env: testEnv(),
      userStore,
      stripeClient
    });

    const result = await service.createPortalSession({ user });

    expect(result.url).toBe("https://billing.stripe.com/p/session/test_123");
    expect(stripeClient.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: "cus_existing_123",
      return_url: "http://127.0.0.1:5173/settings"
    });
    userStore.close();
  });

  it("throws a not found error when a portal session is requested before checkout", async () => {
    const userStore = createMemoryUserStore();
    const user = userStore.getOrCreateUser({
      clerkUserId: "clerk_user_1",
      email: "person@example.com"
    });
    const service = createStripeBillingService({
      env: testEnv(),
      userStore,
      stripeClient: createStripeClient()
    });

    await expect(service.createPortalSession({ user })).rejects.toBeInstanceOf(BillingNotFoundError);
    userStore.close();
  });

  it("propagates stripe failures from checkout session creation", async () => {
    const userStore = createMemoryUserStore();
    const user = userStore.getOrCreateUser({
      clerkUserId: "clerk_user_1",
      email: "person@example.com"
    });
    const stripeClient = createStripeClient({
      checkout: {
        sessions: {
          create: vi.fn().mockRejectedValue(new Error("stripe failure"))
        }
      }
    });
    const service = createStripeBillingService({
      env: testEnv(),
      userStore,
      stripeClient
    });

    await expect(
      service.createCheckoutSession({
        user,
        plan: "pro-monthly"
      })
    ).rejects.toThrow("stripe failure");
    userStore.close();
  });
});

function createStripeClient(overrides: Record<string, unknown> = {}) {
  return {
    customers: {
      create: vi.fn().mockResolvedValue({ id: "cus_created_123" })
    },
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_test_123" })
      }
    },
    billingPortal: {
      sessions: {
        create: vi.fn().mockResolvedValue({ url: "https://billing.stripe.com/p/session/test_123" })
      }
    },
    ...overrides
  };
}

function testEnv() {
  return {
    stripeSecretKey: "sk_test_123",
    stripePriceProMonthly: "price_test_monthly",
    stripeCheckoutSuccessUrl: "http://127.0.0.1:5173/billing/success",
    stripeCheckoutCancelUrl: "http://127.0.0.1:5173/billing/cancel",
    stripePortalReturnUrl: "http://127.0.0.1:5173/settings"
  };
}
