import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { StoreProvider } from "./lib/store";
import { isWorkshopSurface } from "./lib/workshop-pack";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { WorkshopBreakout } from "./ui/WorkshopBreakout";
import "./styles/app.css";
import "./styles/crew-dots.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

// The Workshop breakout is read-only and holds no desk state. Mounted inside
// StoreProvider it loaded the desk, saved it back stale over the live window's
// chats, and queued and sent every scheduled job a second time.
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      {isWorkshopSurface() ? (
        <WorkshopBreakout />
      ) : (
        <StoreProvider>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </StoreProvider>
      )}
    </ErrorBoundary>
  </StrictMode>,
);
