"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useSession } from "./session";

/** GET helper bound to the current tenant. `path` null means "not ready yet". */
export function useGet<T>(path: string | null) {
  const { tenantId } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!path || !tenantId) return;
    setLoading(true);
    try {
      setData(await api<T>(tenantId, path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path, tenantId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}
