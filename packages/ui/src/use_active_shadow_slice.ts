import { useSyncExternalStore } from "react";
import {
  EMPTY_SHADOW_SLICE,
  getShadowSliceSnapshot,
  subscribeShadowSliceUrl,
  type ActiveShadowSlice,
} from "./desk_quick_jump.ts";

export function useActiveShadowSlice(): ActiveShadowSlice {
  return useSyncExternalStore(
    subscribeShadowSliceUrl,
    getShadowSliceSnapshot,
    () => EMPTY_SHADOW_SLICE,
  );
}
