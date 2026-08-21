import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { StoreProvider } from "./lib/store";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import "./styles/app.css";
import "./styles/crew-dots.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <StoreProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StoreProvider>
    </ErrorBoundary>
  </StrictMode>,
);
