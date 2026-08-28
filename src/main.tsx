import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { bootstrapDesk } from "./app/bootstrap";
import "./styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing");

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>
);

bootstrapDesk();
