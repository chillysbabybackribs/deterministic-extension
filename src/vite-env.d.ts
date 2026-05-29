/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BYPASS_CLERK_AUTH?: string;
  readonly VITE_BACKEND_API_URL?: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_CLERK_FRONTEND_API?: string;
}
