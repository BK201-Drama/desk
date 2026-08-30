import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { bootstrapDesk, createDeskHostBridge } from "./app/bootstrap";
import { DeskShellProvider } from "./app/providers/DeskShellProvider";
import { preloadGithubBoot } from "./plugins/github/boot";
import { preloadStockBoot } from "./plugins/stock/boot";
import { preloadCursorBoot } from "./plugins/token-capsule/boot";
import "./styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing");

const bridge = createDeskHostBridge();

async function start() {
  // 首屏关键面板：磁盘缓存先就位，再挂 React（并行读，都很快）
  const t0 = performance.now();
  await Promise.all([
    preloadGithubBoot().catch(() => undefined),
    preloadStockBoot().catch(() => undefined),
    preloadCursorBoot().catch(() => undefined),
  ]);
  console.info(`[desk] panel caches ready in ${Math.round(performance.now() - t0)}ms`);

  createRoot(el!).render(
    <StrictMode>
      <DeskShellProvider bridge={bridge}>
        <App />
      </DeskShellProvider>
    </StrictMode>
  );

  bootstrapDesk(bridge);
}

void start();
