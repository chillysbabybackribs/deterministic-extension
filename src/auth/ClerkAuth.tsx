import {
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton
} from "@clerk/chrome-extension";
import type { ReactNode } from "react";
import { Component } from "react";
import { persistentClerkSessionCache } from "./clerkSessionStorage";
import { getExtensionOrigin, getSidePanelRedirectUrl } from "./extensionUrl";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const CLERK_FRONTEND_API = import.meta.env.VITE_CLERK_FRONTEND_API;
const BYPASS_CLERK_AUTH = import.meta.env.VITE_BYPASS_CLERK_AUTH === "1";

const clerkAppearance = {
  elements: {
    socialButtonsRoot: "clerk-extension-hidden",
    dividerRow: "clerk-extension-hidden"
  }
};

export type ClerkAuthProviderProps = {
  children: ReactNode;
};

export function ClerkAuthProvider({ children }: ClerkAuthProviderProps) {
  if (BYPASS_CLERK_AUTH) {
    return <>{children}</>;
  }

  const redirectUrl = getSidePanelRedirectUrl();
  const extensionOrigin = getExtensionOrigin();

  if (!PUBLISHABLE_KEY) {
    return <MissingClerkConfiguration />;
  }

  return (
    <ClerkErrorBoundary>
      <ClerkProvider
        publishableKey={PUBLISHABLE_KEY}
        afterSignOutUrl={redirectUrl}
        signInFallbackRedirectUrl={redirectUrl}
        signUpFallbackRedirectUrl={redirectUrl}
        allowedRedirectProtocols={["chrome-extension:"]}
        allowedRedirectOrigins={extensionOrigin ? [extensionOrigin] : undefined}
        storageCache={persistentClerkSessionCache}
        appearance={clerkAppearance}
      >
        <ClerkLoading>
          <div className="auth-screen">
            <div className="auth-panel">
              <div className="auth-eyebrow">Browser Chat Assistant</div>
              <h1>Checking your session...</h1>
            </div>
          </div>
        </ClerkLoading>
        <ClerkLoaded>
          <Show when="signed-out">
            <AuthGate redirectUrl={redirectUrl} />
          </Show>
          <Show when="signed-in">{children}</Show>
        </ClerkLoaded>
      </ClerkProvider>
    </ClerkErrorBoundary>
  );
}

export function ClerkUserControls() {
  if (BYPASS_CLERK_AUTH) {
    return null;
  }

  return (
    <div className="clerk-user-controls">
      <UserButton />
    </div>
  );
}

function AuthGate({ redirectUrl }: { redirectUrl: string }) {
  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <div className="auth-eyebrow">Browser Chat Assistant</div>
        <h1>Sign in to continue.</h1>
        <div className="auth-actions">
          <SignInButton mode="modal" fallbackRedirectUrl={redirectUrl} appearance={clerkAppearance}>
            <button className="auth-primary-button" type="button">
              Sign in
            </button>
          </SignInButton>
          <SignUpButton mode="modal" fallbackRedirectUrl={redirectUrl} appearance={clerkAppearance}>
            <button className="auth-secondary-button" type="button">
              Sign up
            </button>
          </SignUpButton>
        </div>
      </div>
    </div>
  );
}

function MissingClerkConfiguration() {
  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <div className="auth-eyebrow">Browser Chat Assistant</div>
        <h1>Clerk is not configured.</h1>
        <p className="auth-note">
          Set `VITE_CLERK_PUBLISHABLE_KEY` and rebuild the extension.
        </p>
        <p className="auth-note">
          For a stable Chrome extension login, also set `CLERK_FRONTEND_API` and `CRX_PUBLIC_KEY`.
        </p>
      </div>
    </div>
  );
}

type ClerkErrorBoundaryState = {
  message?: string;
};

class ClerkErrorBoundary extends Component<{ children: ReactNode }, ClerkErrorBoundaryState> {
  state: ClerkErrorBoundaryState = {};

  static getDerivedStateFromError(error: unknown): ClerkErrorBoundaryState {
    const message = error instanceof Error ? error.message : String(error);
    return { message };
  }

  render() {
    if (!this.state.message) {
      return this.props.children;
    }

    return (
      <div className="auth-screen">
        <div className="auth-panel">
          <div className="auth-eyebrow">Browser Chat Assistant</div>
          <h1>Clerk failed to initialize.</h1>
          <p className="auth-note">{this.state.message}</p>
          <p className="auth-note">
            Confirm that Clerk allows your extension origin and that the built manifest includes the Clerk
            frontend host permission.
          </p>
          {CLERK_FRONTEND_API ? (
            <p className="auth-note">Configured Clerk frontend API: {CLERK_FRONTEND_API}</p>
          ) : null}
        </div>
      </div>
    );
  }
}
