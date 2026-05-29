import Stripe from "stripe";
import type { BackendEnv } from "./env.js";
import type { BillingPlan, UserStore } from "./types.js";

type WebhookBillingEnv = Required<Pick<BackendEnv, "stripePriceProMonthly" | "stripeWebhookSigningSecret">>;

type StripeWebhookClient = {
  webhooks: {
    constructEvent(body: Buffer | string, signature: string, secret: string): Stripe.Event;
  };
  subscriptions: {
    retrieve(
      id: string,
      params?: Stripe.SubscriptionRetrieveParams,
      options?: Stripe.RequestOptions
    ): Promise<Stripe.Subscription>;
  };
};

export class WebhookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookValidationError";
  }
}

export type StripeWebhookHandler = {
  handleSession(args: { signature: string; body: Buffer | string }): Promise<void>;
};
export function createStripeWebhookHandler(args: {
  env: WebhookBillingEnv;
  userStore: UserStore;
  stripeClient: StripeWebhookClient;
}): StripeWebhookHandler {
  return {
    async handleSession({ signature, body }) {
      let event: Stripe.Event;

      try {
        event = args.stripeClient.webhooks.constructEvent(body, signature, args.env.stripeWebhookSigningSecret);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid webhook payload.";
        throw new WebhookValidationError(message);
      }

      if (!isValidEvent(event)) {
        throw new WebhookValidationError("Invalid webhook payload.");
      }

      const wasFirstDelivery = args.userStore.recordWebhookEvent(event.id, event.type);
      if (!wasFirstDelivery) {
        return;
      }

      try {
        if (event.type === "checkout.session.completed") {
          await handleCheckoutCompleted(args, event);
        } else if (
          event.type === "customer.subscription.created" ||
          event.type === "customer.subscription.updated" ||
          event.type === "customer.subscription.deleted"
        ) {
          await handleSubscriptionChanged(args, event);
        }
      } catch (error) {
        args.userStore.clearWebhookEvent(event.id);
        throw error;
      }
    }
  };
}

async function handleCheckoutCompleted(
  args: {
    env: WebhookBillingEnv;
    userStore: UserStore;
    stripeClient: StripeWebhookClient;
  },
  event: Stripe.Event
): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  if (!isCheckoutSessionObject(session)) {
    throw new WebhookValidationError("Invalid checkout.session.completed payload.");
  }

  const customerId = extractId(session.customer);
  if (!customerId) {
    return;
  }

  const subscriptionId = extractId(session.subscription);
  if (!subscriptionId) {
    return;
  }

  const subscription = await args.stripeClient.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price"]
  });
  await updateSubscriptionState({ ...args, customerId, subscription, eventTimestamp: event.created });
}

async function handleSubscriptionChanged(
  args: {
    env: WebhookBillingEnv;
    userStore: UserStore;
    stripeClient: StripeWebhookClient;
  },
  event: Stripe.Event
): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  if (!isSubscriptionObject(subscription)) {
    throw new WebhookValidationError("Invalid subscription payload.");
  }

  const customerId = extractId(subscription.customer);
  if (!customerId) {
    return;
  }

  await updateSubscriptionState({ ...args, customerId, subscription, eventTimestamp: event.created });
}

async function updateSubscriptionState(args: {
  env: WebhookBillingEnv;
  userStore: UserStore;
  stripeClient: StripeWebhookClient;
  customerId: string;
  subscription: Stripe.Subscription;
  eventTimestamp: number;
}): Promise<void> {
  const user = args.userStore.getUserByStripeCustomerId(args.customerId);
  if (!user) {
    return;
  }

  if (
    Number.isFinite(args.eventTimestamp) &&
    typeof user.stripeSubscriptionUpdatedAt === "number" &&
    args.eventTimestamp <= user.stripeSubscriptionUpdatedAt
  ) {
    return;
  }

  const plan = getPlanForSubscription(args.env.stripePriceProMonthly, args.subscription);

  args.userStore.setStripeSubscriptionState({
    userId: user.id,
    stripeSubscriptionId: args.subscription.id,
    stripeSubscriptionStatus: args.subscription.status,
    stripeSubscriptionPlan: plan,
    stripeCurrentPeriodEnd: extractCurrentPeriodEnd(args.subscription),
    stripeSubscriptionUpdatedAt: args.eventTimestamp
  });
}

function getPlanForSubscription(
  subscriptionPriceId: string,
  subscription: Stripe.Subscription
): BillingPlan | null {
  const firstItem = subscription.items?.data?.[0];
  if (!firstItem?.price?.id) {
    return null;
  }

  return firstItem.price.id === subscriptionPriceId ? "pro-monthly" : null;
}

function extractId(value: string | { id: string } | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  return value.id;
}

function extractCurrentPeriodEnd(subscription: Stripe.Subscription): number | null {
  const typedSubscription = subscription as { current_period_end?: number | null };
  const value = typedSubscription.current_period_end;
  return typeof value === "number" ? value : null;
}

function isValidEvent(value: unknown): value is Stripe.Event {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeEvent = value as Stripe.Event;
  const eventData = maybeEvent.data as unknown;
  if (!eventData || typeof eventData !== "object") {
    return false;
  }

  const dataPayload = eventData as { object?: unknown };
  const hasObject = dataPayload?.object !== undefined && dataPayload?.object !== null;

  return (
    typeof maybeEvent.id === "string" &&
    typeof maybeEvent.type === "string" &&
    hasObject
  );
}

function isCheckoutSessionObject(value: unknown): value is Stripe.Checkout.Session {
  if (!value || typeof value !== "object") {
    return false;
  }

  const session = value as Stripe.Checkout.Session;
  return typeof session.id === "string";
}

function isSubscriptionObject(value: unknown): value is Stripe.Subscription {
  if (!value || typeof value !== "object") {
    return false;
  }

  const subscription = value as Stripe.Subscription;
  return (
    typeof subscription.id === "string" &&
    (typeof subscription.status === "string" || subscription.status == null)
  );
}
