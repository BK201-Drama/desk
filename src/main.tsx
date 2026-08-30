import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { bootstrapDesk, createDeskHostBridge } from "./app/bootstrap";
import { DeskShellProvider } from "./app/providers/DeskShellProvider";
import { preloadGithubBoot } from "./plugins/github/boot";
import "./styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing");

const bridge = createDeskHostBridge();

async function start() {
  // 缓存先就位再挂 React：GitHub 首帧必须直接有数据，不能「等面板 chunk + 再 IPC」
  const t0 = performance.now();
  await preloadGithubBoot().catch(() => undefined);
  console.info(`[desk] github cache ready in ${Math.round(performance.now() - t0)}ms`);

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
