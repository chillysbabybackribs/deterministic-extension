import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { ClerkAuthProvider, ClerkUserControls } from "./auth/ClerkAuth";
import "./app/styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ClerkAuthProvider>
      <App authControls={<ClerkUserControls />} />
    </ClerkAuthProvider>
  </React.StrictMode>
);
