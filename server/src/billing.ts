import Stripe from "stripe";
import type { BackendEnv } from "./env.js";
import type { BillingPlan, BillingService, CreateCheckoutSessionArgs, CreatePortalSessionArgs, UserStore } from "./types.js";

const PRO_MONTHLY_PLAN: BillingPlan = "pro-monthly";

export class BillingNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingNotFoundError";
  }
}

type StripeCustomer = {
  id: string;
};

type StripeCheckoutSession = {
  url: string | null;
};

type StripePortalSession = {
  url: string;
};

type StripeClient = {
  customers: {
    create(params: Stripe.CustomerCreateParams): Promise<StripeCustomer>;
  };
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams): Promise<StripeCheckoutSession>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: Stripe.BillingPortal.SessionCreateParams): Promise<StripePortalSession>;
    };
  };
};

type BillingEnv = Required<
  Pick<
    BackendEnv,
    | "stripeSecretKey"
    | "stripePriceProMonthly"
    | "stripeCheckoutSuccessUrl"
    | "stripeCheckoutCancelUrl"
    | "stripePortalReturnUrl"
  >
>;

export function createStripeBillingService(args: {
  env: BillingEnv;
  userStore: UserStore;
  stripeClient?: StripeClient;
}): BillingService {
  const stripe = args.stripeClient ?? new Stripe(args.env.stripeSecretKey);

  return {
    async createCheckoutSession({ user, plan }: CreateCheckoutSessionArgs) {
      if (plan !== PRO_MONTHLY_PLAN) {
        throw new Error(`Unsupported billing plan: ${plan}`);
      }

      const ensuredUser = await ensureStripeCustomer({ stripe, userStore: args.userStore, user });
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: ensuredUser.stripeCustomerId ?? undefined,
        success_url: args.env.stripeCheckoutSuccessUrl,
        cancel_url: args.env.stripeCheckoutCancelUrl,
        line_items: [
          {
            price: args.env.stripePriceProMonthly,
            quantity: 1
          }
        ],
        metadata: {
          internalUserId: ensuredUser.id,
          clerkUserId: ensuredUser.clerkUserId,
          plan
        },
        subscription_data: {
          metadata: {
            internalUserId: ensuredUser.id,
            clerkUserId: ensuredUser.clerkUserId,
            plan
          }
        }
      });

      if (!session.url) {
        throw new Error("Stripe Checkout session did not include a hosted URL.");
      }

      return { url: session.url };
    },

    async createPortalSession({ user }: CreatePortalSessionArgs) {
      if (!user.stripeCustomerId) {
        throw new BillingNotFoundError("No Stripe customer exists for this user yet.");
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: args.env.stripePortalReturnUrl
      });

      return { url: session.url };
    }
  };
}

export function getPriceIdForPlan(env: BillingEnv, plan: BillingPlan): string {
  if (plan === PRO_MONTHLY_PLAN) {
    return env.stripePriceProMonthly;
  }

  return assertNever(plan);
}

async function ensureStripeCustomer(args: {
  stripe: StripeClient;
  userStore: UserStore;
  user: CreateCheckoutSessionArgs["user"];
}) {
  if (args.user.stripeCustomerId) {
    return args.user;
  }

  const customer = await args.stripe.customers.create({
    email: args.user.email ?? undefined,
    metadata: {
      internalUserId: args.user.id,
      clerkUserId: args.user.clerkUserId
    }
  });

  return args.userStore.setStripeCustomerId(args.user.id, customer.id);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported plan: ${String(value)}`);
}
