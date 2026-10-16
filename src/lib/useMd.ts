// Reactive hook over the Obsidian bridge: load, follow external edits, and
// write back with compare-and-swap + automatic re-read on conflict.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Backend } from "./types";
import { showToast } from "./undo";

export interface MdState {
  content: string;
  exists: boolean;
  loading: boolean;
}

export function useMd(
  backend: Backend | null,
  which: "journal",
): MdState & { mutate: (fn: (content: string) => string) => Promise<void> } {
  const [state, setState] = useState<MdState>({ content: "", exists: false, loading: true });
  const mtimeRef = useRef(0);

  const load = useCallback(async () => {
    if (!backend) return;
    try {
      const f = await backend.mdRead(which);
      mtimeRef.current = f.mtime_ms;
      setState({ content: f.content, exists: f.exists, loading: false });
    } catch {
      setState((s) => ({ ...s, loading: false }));
    }
  }, [backend, which]);

  useEffect(() => {
    load();
    if (!backend) return;
    return backend.onMdChanged((changed) => {
      if (changed === which) load();
    });
  }, [backend, which, load]);

  const mutate = useCallback(
    async (fn: (content: string) => string) => {
      if (!backend) return;
      const next = fn(state.content);
      if (next === state.content) return;
      try {
        mtimeRef.current = await backend.mdWrite(which, next, mtimeRef.current);
        setState((s) => ({ ...s, content: next, exists: true }));
      } catch (e) {
        showToast(`${String(e).includes("conflict") ? "File changed in Obsidian — reloaded" : e}`, false);
        await load();
      }
    },
    [backend, which, state.content, load],
  );

  return { ...state, mutate };
}
