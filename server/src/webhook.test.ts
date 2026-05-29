import { describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { WebhookValidationError, createStripeWebhookHandler } from "./webhook.js";
import { createMemoryUserStore } from "./userStore.js";

describe("createStripeWebhookHandler", () => {
  it("stores subscription data on checkout.session.completed", async () => {
    const userStore = createMemoryUserStore();
    const user = userStore.getOrCreateUser({ clerkUserId: "user_1", email: "person@example.com" });
    userStore.setStripeCustomerId(user.id, "cus_123");

    const stripeClient = createStripeClient({
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue(createSubscription({ id: "sub_123", status: "active", currentPeriodEnd: 1710000000 }))
      }
    });

    const handler = createStripeWebhookHandler({
      env: testEnv(),
      userStore,
      stripeClient
    });

    await handler.handleSession({
      signature: "t=123,v1=abc",
      body: Buffer.from(
        '{"id":"evt_123","type":"checkout.session.completed","data":{"object":{"id":"cs_123","customer":"cus_123","subscription":"sub_123"}}}'
      )
    });

    expect(stripeClient.subscriptions.retrieve).toHaveBeenCalledWith("sub_123", { expand: ["items.data.price"] });
    expect(userStore.getUserByStripeCustomerId("cus_123")).toMatchObject({
      stripeSubscriptionId: "sub_123",
      stripeSubscriptionStatus: "active",
      stripeSubscriptionPlan: "pro-monthly",
      stripeCurrentPeriodEnd: 1710000000
    });
    expect(userStore.hasProcessedWebhookEvent("evt_123")).toBe(true);
  });

  it("stores subscription data on customer.subscription.updated", async () => {
    const userStore = createMemoryUserStore();
    const user = userStore.getOrCreateUser({ clerkUserId: "user_1", email: "person@example.com" });
    userStore.setStripeCustomerId(user.id, "cus_456");

    const handler = createStripeWebhookHandler({
      env: testEnv(),
      userStore,
      stripeClient: createStripeClient()
    });

    await handler.handleSession({
      signature: "t=123,v1=abc",
      body: Buffer.from(
        '{"id":"evt_456","type":"customer.subscription.updated","data":{"object":{"id":"sub_456","status":"canceled","customer":"cus_456","items":{"data":[{"price":{"id":"price_test_monthly"}}]},"current_period_end":1710002000}}}'
      )
    });

    expect(userStore.getUserByStripeCustomerId("cus_456")).toMatchObject({
      stripeSubscriptionId: "sub_456",
      stripeSubscriptionStatus: "canceled",
      stripeSubscriptionPlan: "pro-monthly",
      stripeCurrentPeriodEnd: 1710002000
    });
  });

  it("does not overwrite newer state with stale subscription events", async () => {
    const userStore = createMemoryUserStore();
    const user = userStore.getOrCreateUser({ clerkUserId: "user_1", email: "person@example.com" });
    userStore.setStripeCustomerId(user.id, "cus_stale");

    const handler = createStripeWebhookHandler({
      env: testEnv(),
      userStore,
      stripeClient: createStripeClient()
    });

    await handler.handleSession({
      signature: "t=123,v1=abc",
      body: Buffer.from(
        '{"id":"evt_new","type":"customer.subscription.updated","created":1710002000,"data":{"object":{"id":"sub_new","status":"active","customer":"cus_stale","items":{"data":[{"price":{"id":"price_test_monthly"}}]},"current_period_end":1710002000}}}'
      )
    });

    await handler.handleSession({
      signature: "t=123,v1=abc",
      body: Buffer.from(
        '{"id":"evt_old","type":"customer.subscription.updated","created":1710001000,"data":{"object":{"id":"sub_old","status":"canceled","customer":"cus_stale","items":{"data":[{"price":{"id":"price_test_monthly"}}]},"current_period_end":1710001000}}}'
      )
    });

    expect(userStore.getUserByStripeCustomerId("cus_stale")).toMatchObject({
      stripeSubscriptionId: "sub_new",
      stripeSubscriptionStatus: "active",
      stripeCurrentPeriodEnd: 1710002000,
      stripeSubscriptionUpdatedAt: 1710002000
    });
  });

  it("ignores duplicate webhook events once processed", async () => {
    const userStore = createMemoryUserStore();
    const user = userStore.getOrCreateUser({ clerkUserId: "user_1", email: "person@example.com" });
    userStore.setStripeCustomerId(user.id, "cus_789");

    const stripeClient = createStripeClient();
    const handler = createStripeWebhookHandler({
      env: testEnv(),
      userStore,
      stripeClient
    });

    await handler.handleSession({
      signature: "t=123,v1=abc",
      body: Buffer.from(
        '{"id":"evt_789","type":"customer.subscription.created","data":{"object":{"id":"sub_789","status":"active","customer":"cus_789","items":{"data":[{"price":{"id":"price_test_monthly"}}]},"current_period_end":1710000000}}}'
      )
    });

    await handler.handleSession({
      signature: "t=123,v1=abc",
      body: Buffer.from(
        '{"id":"evt_789","type":"customer.subscription.created","data":{"object":{"id":"sub_789","status":"active","customer":"cus_789","items":{"data":[{"price":{"id":"price_test_monthly"}}]},"current_period_end":1710000000}}}'
      )
    });

    expect(stripeClient.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(userStore.getUserByStripeCustomerId("cus_789")).toMatchObject({
      stripeSubscriptionId: "sub_789"
    });
  });

  it("allows a retry when first webhook delivery fails before completion", async () => {
    const userStore = createMemoryUserStore();
    const user = userStore.getOrCreateUser({ clerkUserId: "user_1", email: "person@example.com" });
    userStore.setStripeCustomerId(user.id, "cus_retry");

    const stripeClient = createStripeClient({
      subscriptions: {
        retrieve: vi
          .fn()
          .mockRejectedValueOnce(new Error("temporary stripe error"))
          .mockResolvedValue(createSubscription({ id: "sub_retry", status: "active", currentPeriodEnd: 1710000000 }))
      }
    });
    const handler = createStripeWebhookHandler({
      env: testEnv(),
      userStore,
      stripeClient
    });

    const body = Buffer.from(
      '{"id":"evt_retry","type":"checkout.session.completed","data":{"object":{"id":"cs_retry","customer":"cus_retry","subscription":"sub_retry"}}}'
    );

    await expect(
      handler.handleSession({
        signature: "t=123,v1=abc",
        body
      })
    ).rejects.toThrow("temporary stripe error");

    expect(userStore.hasProcessedWebhookEvent("evt_retry")).toBe(false);

    await handler.handleSession({
      signature: "t=123,v1=abc",
      body
    });

    expect(stripeClient.subscriptions.retrieve).toHaveBeenCalledTimes(2);
    expect(userStore.getUserByStripeCustomerId("cus_retry")).toMatchObject({
      stripeSubscriptionId: "sub_retry"
    });
    expect(userStore.hasProcessedWebhookEvent("evt_retry")).toBe(true);
  });

  it("throws validation errors for invalid signatures", async () => {
    const handler = createStripeWebhookHandler({
      env: testEnv(),
      userStore: createMemoryUserStore(),
      stripeClient: {
        ...createStripeClient(),
        webhooks: {
          constructEvent: vi.fn().mockImplementation(() => {
            throw new Error("Bad signature");
          })
        }
      }
    });

    await expect(
      handler.handleSession({
        signature: "invalid",
        body: Buffer.from('{"id":"evt_bad","type":"checkout.session.completed"}')
      })
    ).rejects.toBeInstanceOf(WebhookValidationError);
  });

  it("rejects malformed event payloads before processing", async () => {
    const handler = createStripeWebhookHandler({
      env: testEnv(),
      userStore: createMemoryUserStore(),
      stripeClient: {
        ...createStripeClient(),
        webhooks: {
          constructEvent: vi.fn().mockReturnValue({ notAnEvent: true } as unknown as Stripe.Event)
        }
      }
    });

    await expect(
      handler.handleSession({
        signature: "t=123,v1=abc",
        body: Buffer.from("{}")
      })
    ).rejects.toBeInstanceOf(WebhookValidationError);
  });

  it("rejects checkout session events missing data.object", async () => {
    const handler = createStripeWebhookHandler({
      env: testEnv(),
      userStore: createMemoryUserStore(),
      stripeClient: createStripeClient()
    });

    await expect(
      handler.handleSession({
        signature: "t=123,v1=abc",
        body: Buffer.from('{"id":"evt_no_object","type":"checkout.session.completed","data":{}}')
      })
    ).rejects.toBeInstanceOf(WebhookValidationError);
  });

  it("rejects events with non-object data payloads", async () => {
    const handler = createStripeWebhookHandler({
      env: testEnv(),
      userStore: createMemoryUserStore(),
      stripeClient: createStripeClient()
    });

    await expect(
      handler.handleSession({
        signature: "t=123,v1=abc",
        body: Buffer.from('{"id":"evt_bad_data","type":"checkout.session.completed","data":123}')
      })
    ).rejects.toBeInstanceOf(WebhookValidationError);
  });

  it("ignores checkout session payloads missing customer metadata", async () => {
    const userStore = createMemoryUserStore();
    const stripeClient = createStripeClient();
    const handler = createStripeWebhookHandler({
      env: testEnv(),
      userStore,
      stripeClient
    });

    await handler.handleSession({
      signature: "t=123,v1=abc",
      body: Buffer.from(
        '{"id":"evt_no_customer","type":"checkout.session.completed","data":{"object":{"id":"cs_123","subscription":"sub_123"}}}'
      )
    });

    expect(stripeClient.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("stores unsupported event IDs for forward-compatibility and ignores body", async () => {
    const userStore = createMemoryUserStore();
    const stripeClient = createStripeClient();
    const handler = createStripeWebhookHandler({
      env: testEnv(),
      userStore,
      stripeClient
    });

    await handler.handleSession({
      signature: "t=123,v1=abc",
      body: Buffer.from(
        '{"id":"evt_unsupported","type":"invoice.payment_failed","data":{"object":{"id":"in_123"}}}'
      )
    });

    expect(userStore.hasProcessedWebhookEvent("evt_unsupported")).toBe(true);
    expect(stripeClient.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});

function createStripeClient(overrides: Record<string, unknown> = {}) {
  return {
    webhooks: {
      constructEvent: vi.fn().mockImplementation((body: Buffer | string) => {
        return JSON.parse(body.toString()) as unknown as Stripe.Event;
      })
    },
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue(createSubscription({}))
    },
    ...overrides
  };
}

function createSubscription(overrides: Partial<Stripe.Subscription> & { currentPeriodEnd?: number | null } = {}) {
  return {
    id: "sub_123",
    status: "active",
    current_period_end: overrides.currentPeriodEnd ?? 1710000000,
    items: {
      data: [
        {
          price: {
            id: "price_test_monthly"
          }
        }
      ]
    },
    ...overrides
  } as Stripe.Subscription;
}

function testEnv() {
  return {
    stripePriceProMonthly: "price_test_monthly",
    stripeWebhookSigningSecret: "whsec_123"
  };
}
