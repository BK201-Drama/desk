import { useSyncExternalStore } from "react";
import { isEditing, onEditChange } from "../host/edit";

export function useEditing(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => onEditChange(() => onStoreChange()),
    isEditing,
    () => false
  );
}
