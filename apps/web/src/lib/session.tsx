"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export interface Login {
  token: string;
  role: string;
  customerId: string | null;
}
interface Ctx {
  tenantId: string;
  setTenantId: (v: string) => void;
  ready: boolean;
  login: Login | null;
  setLogin: (l: Login | null) => void;
}
const C = createContext<Ctx>({
  tenantId: "",
  setTenantId: () => {},
  ready: false,
  login: null,
  setLogin: () => {},
});
const KEY = "slotflow.tenantId";
const LKEY = "slotflow.login";

/** Read by api() outside React: the bearer token of the current login, if any. */
let token: string | null = null;
export const currentToken = () => token;

/**
 * Tenant selection (dev mode) and the optional JWT login. Browser storage can throw, so every access is
 * guarded; losing it only means logging in again.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [tenantId, set] = useState("");
  const [ready, setReady] = useState(false);
  const [login, setLoginState] = useState<Login | null>(null);
  useEffect(() => {
    try {
      set(localStorage.getItem(KEY) ?? "");
      const l = localStorage.getItem(LKEY);
      if (l) {
        const parsed = JSON.parse(l) as Login;
        token = parsed.token;
        setLoginState(parsed);
      }
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
  const setLogin = (l: Login | null) => {
    token = l?.token ?? null;
    setLoginState(l);
    try {
      if (l) localStorage.setItem(LKEY, JSON.stringify(l));
      else localStorage.removeItem(LKEY);
    } catch {
      /* ignore */
    }
  };
  return (
    <C.Provider value={{ tenantId, setTenantId, ready, login, setLogin }}>{children}</C.Provider>
  );
}
export const useSession = () => useContext(C);
