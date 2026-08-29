import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { bootstrapDesk, createDeskHostBridge } from "./app/bootstrap";
import { DeskShellProvider } from "./app/providers/DeskShellProvider";
import "./styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing");

const bridge = createDeskHostBridge();

createRoot(el).render(
  <StrictMode>
    <DeskShellProvider bridge={bridge}>
      <App />
    </DeskShellProvider>
  </StrictMode>
);

bootstrapDesk(bridge);
