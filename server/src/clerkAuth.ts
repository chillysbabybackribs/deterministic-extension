import { createClerkClient } from "@clerk/backend";
import type { BackendEnv } from "./env.js";
import type { AuthResult, Authenticator } from "./types.js";

export function createClerkAuthenticator(env: BackendEnv): Authenticator {
  if (!env.clerkSecretKey || !env.clerkPublishableKey) {
    throw new Error("Clerk backend auth requires CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY.");
  }

  const clerkClient = createClerkClient({
    secretKey: env.clerkSecretKey,
    publishableKey: env.clerkPublishableKey
  });

  return async (request: Request): Promise<AuthResult | null> => {
    const requestState = await clerkClient.authenticateRequest(request, {
      authorizedParties: env.clerkAuthorizedParties.length ? env.clerkAuthorizedParties : undefined,
      jwtKey: env.clerkJwtKey
    });

    if (!requestState.isAuthenticated) {
      return null;
    }

    const auth = requestState.toAuth();
    if (!auth.userId) {
      return null;
    }

    const user = await clerkClient.users.getUser(auth.userId);
    const email = user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId)?.emailAddress ?? null;

    return {
      clerkUserId: auth.userId,
      sessionId: auth.sessionId,
      email
    };
  };
}
