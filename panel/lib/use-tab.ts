"use client";
import { useState, useCallback, useEffect } from "react";
import { usePathname } from "next/navigation";

function readTab(def: string): string {
  if (typeof window === "undefined") return def;
  try {
    return new URL(location.href).searchParams.get("t") || def;
  } catch {
    return def;
  }
}

// Tab-within-a-page state, mirrored to ?t= so a tab survives reload and is linkable. Read from
// window.location rather than useSearchParams, which would need a Suspense boundary in every page.
//
// It is re-read whenever the pathname changes, NOT on mount only. On a client-side navigation Next
// mounts the destination page before window.location reflects the new URL, so a mount-only read saw
// the URL we were leaving and silently fell back to `def`. Every arrival carrying a ?t= landed on
// the wrong tab: a `/secrets` bookmark redirected to /consumers/?t=access and rendered Consumers,
// and every in-app go(slug, tab) hop ignored its tab. The effect runs after commit, by which point
// the URL has settled.
export function useTab(def: string): [string, (v: string) => void] {
  const [tab, setTab] = useState<string>(() => readTab(def));
  const path = usePathname();
  useEffect(() => {
    setTab(readTab(def));
  }, [path, def]);
  const set = useCallback((v: string) => {
    try {
      const u = new URL(location.href);
      u.searchParams.set("t", v);
      history.replaceState({}, "", u);
    } catch {
      /* ignore */
    }
    setTab(v);
  }, []);
  return [tab, set];
}
