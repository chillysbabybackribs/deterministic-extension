/**
 * ISOLATED-world content-script entry, registered at document_start (see
 * pageShimCapture.ensureShimContentScripts). Relays the MAIN-world shim's
 * window.postMessage events up to the service worker from the earliest point.
 * Idempotent via the window sentinel inside installShimBridge.
 */
import { RELAY_MESSAGE_TYPE, SHIM_MESSAGE_TYPE, installShimBridge } from "../tools/networkCapture/shimInjection";

installShimBridge(SHIM_MESSAGE_TYPE, RELAY_MESSAGE_TYPE);
