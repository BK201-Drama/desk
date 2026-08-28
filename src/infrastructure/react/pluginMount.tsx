import { createRoot, type Root } from "react-dom/client";
import type { ComponentType } from "react";
import type { HostContext, PluginComponentProps } from "../../host/types";

const reactRoots = new Map<string, Root>();

export function mountReactPlugin(
  id: string,
  container: HTMLElement,
  Component: ComponentType<PluginComponentProps>,
  ctx: HostContext
): void {
  unmountReactPlugin(id);
  const root = createRoot(container);
  root.render(<Component ctx={ctx} />);
  reactRoots.set(id, root);
}

export function unmountReactPlugin(id: string): void {
  const root = reactRoots.get(id);
  if (!root) return;
  root.unmount();
  reactRoots.delete(id);
}

export function hasReactPlugin(id: string): boolean {
  return reactRoots.has(id);
}
