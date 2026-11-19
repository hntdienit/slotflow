"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface Ctx {
  tenantId: string;
  setTenantId: (v: string) => void;
  ready: boolean;
}
const C = createContext<Ctx>({ tenantId: "", setTenantId: () => {}, ready: false });
const KEY = "slotflow.tenantId";

/** Dev-time tenant selection (replaced by the JWT claim when auth lands). Browser storage can throw, so every access is guarded. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [tenantId, set] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      set(localStorage.getItem(KEY) ?? "");
    } catch {
      /* storage unavailable */
    }
    setReady(true);
  }, []);
  const setTenantId = (v: string) => {
    set(v.trim());
    try {
      localStorage.setItem(KEY, v.trim());
    } catch {
      /* ignore */
    }
  };
  return <C.Provider value={{ tenantId, setTenantId, ready }}>{children}</C.Provider>;
}
export const useSession = () => useContext(C);
