import "./styles.css";
import { readWorkspaceImageFile } from "../filesystem/workspaceStore";

const app = document.querySelector<HTMLElement>("#app");

void openImage();

async function openImage(): Promise<void> {
  if (!app) {
    return;
  }

  const path = new URL(globalThis.location.href).searchParams.get("path");
  if (!path) {
    renderStatus("No workspace image path was provided.", true);
    return;
  }

  try {
    const result = await readWorkspaceImageFile({ path });
    const url = URL.createObjectURL(result.file);
    const image = new Image();
    image.alt = result.name;
    image.decoding = "async";
    image.draggable = false;
    image.src = url;

    image.addEventListener("load", () => {
      document.title = `${result.name} (${image.naturalWidth} x ${image.naturalHeight})`;
      app.replaceChildren(image);
    }, { once: true });

    image.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      renderStatus(`Could not render ${result.path}.`, true);
    }, { once: true });

    globalThis.addEventListener("pagehide", () => URL.revokeObjectURL(url), { once: true });
  } catch (error) {
    renderStatus(error instanceof Error ? error.message : "Could not open the workspace image.", true);
  }
}

function renderStatus(message: string, isError = false): void {
  if (!app) {
    return;
  }

  const status = document.createElement("p");
  status.className = isError ? "status error" : "status";
  status.textContent = message;
  app.replaceChildren(status);
}
