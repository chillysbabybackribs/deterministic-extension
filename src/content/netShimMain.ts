/**
 * MAIN-world content-script entry, registered at document_start (see
 * pageShimCapture.ensureShimContentScripts). Installs the network shim before
 * the page's own scripts run. Idempotent via the window sentinel inside
 * installNetworkShim, so it is safe alongside an on-demand executeScript.
 */
import { SHIM_MESSAGE_TYPE, installNetworkShim } from "../tools/networkCapture/shimInjection";

installNetworkShim(SHIM_MESSAGE_TYPE);
