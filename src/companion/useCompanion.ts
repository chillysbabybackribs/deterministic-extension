/**
 * React hook owning companion presence + the opt-in pill's dismiss state.
 *
 * Presence is polled (and re-checked when the panel regains focus) so the UI
 * upgrades to "Full mode" within a few seconds of the daemon coming up — the
 * auto-detection that makes install feel seamless. Dismiss state is per-message
 * and session-scoped: dismissing a pill is "not now", and a later limited task
 * produces a new message with a fresh pill.
 */

import { useCallback, useEffect, useState } from "react";
import { checkCompanionHealth, type CompanionHealth } from "./companionClient";

const POLL_INTERVAL_MS = 15_000;

export type UseCompanion = {
  connected: boolean;
  health: CompanionHealth;
  dismissedGapMessageIds: ReadonlySet<string>;
  dismissGap: (messageId: string) => void;
  /** Open the install/setup flow. Returns the setup affordance for the caller. */
  requestInstall: () => void;
  /** Whether the setup panel is open. */
  setupOpen: boolean;
  closeSetup: () => void;
  /** Force an immediate presence re-check (e.g. after the user says they installed). */
  refresh: () => void;
};

export function useCompanion(): UseCompanion {
  const [health, setHealth] = useState<CompanionHealth>({ connected: false });
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [setupOpen, setSetupOpen] = useState(false);

  const refresh = useCallback(() => {
    void checkCompanionHealth().then(setHealth);
  }, []);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, POLL_INTERVAL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const dismissGap = useCallback((messageId: string) => {
    setDismissed((current) => {
      const next = new Set(current);
      next.add(messageId);
      return next;
    });
  }, []);

  const requestInstall = useCallback(() => setSetupOpen(true), []);
  const closeSetup = useCallback(() => setSetupOpen(false), []);

  return {
    connected: health.connected,
    health,
    dismissedGapMessageIds: dismissed,
    dismissGap,
    requestInstall,
    setupOpen,
    closeSetup,
    refresh
  };
}
