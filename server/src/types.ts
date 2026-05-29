export type UserRecord = {
  id: string;
  clerkUserId: string;
  email: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeSubscriptionStatus: string | null;
  stripeSubscriptionPlan: BillingPlan | null;
  stripeCurrentPeriodEnd: number | null;
  stripeSubscriptionUpdatedAt: number | null;
  createdAt: string;
  updatedAt: string;
};

export type EntitlementResponse = {
  isActive: boolean;
  plan: BillingPlan | null;
  status: string | null;
  currentPeriodEnd: number | null;
};

export type AuthenticatedRequestContext = {
  clerkUserId: string;
  sessionId: string | null;
  email: string | null;
  user: UserRecord;
};

export type AuthResult = {
  clerkUserId: string;
  sessionId: string | null;
  email: string | null;
};

export type UserStore = {
  getOrCreateUser(args: {
    clerkUserId: string;
    email: string | null;
  }): UserRecord;
  setStripeCustomerId(userId: string, stripeCustomerId: string): UserRecord;
  getUserByStripeCustomerId(stripeCustomerId: string): UserRecord | null;
  setStripeSubscriptionState(args: {
    userId: string;
    stripeSubscriptionId: string | null;
    stripeSubscriptionStatus: string | null;
    stripeSubscriptionPlan: BillingPlan | null;
    stripeCurrentPeriodEnd: number | null;
    stripeSubscriptionUpdatedAt?: number | null;
  }): UserRecord;
  hasProcessedWebhookEvent(eventId: string): boolean;
  recordWebhookEvent(eventId: string, type: string): boolean;
  clearWebhookEvent(eventId: string): void;
};

export type Authenticator = (request: Request) => Promise<AuthResult | null>;

export type BillingPlan = "pro-monthly";

export type CreateCheckoutSessionArgs = {
  user: UserRecord;
  plan: BillingPlan;
};

export type CreatePortalSessionArgs = {
  user: UserRecord;
};

export type BillingService = {
  createCheckoutSession(args: CreateCheckoutSessionArgs): Promise<{ url: string }>;
  createPortalSession(args: CreatePortalSessionArgs): Promise<{ url: string }>;
};
