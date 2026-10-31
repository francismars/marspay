import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

const RATE_LIMIT_BACKOFF_MS = 60_000;

let onDashboardUnauthorized: (() => void) | null = null;
let dashboardSessionExpired = false;

/** App registers this so a 401 from polling returns to the login screen and stops every poll. */
export function setDashboardUnauthorizedHandler(handler: (() => void) | null): void {
  onDashboardUnauthorized = handler;
}

/** Call after a successful login so polling can start again. */
export function noteDashboardAuthorized(): void {
  dashboardSessionExpired = false;
}

function expireDashboardSession(): void {
  if (dashboardSessionExpired) return;
  dashboardSessionExpired = true;
  onDashboardUnauthorized?.();
}

function formatFetchError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Failed to load';
}

/**
 * Fetch when `active` is true; poll on an interval when `active && poll`.
 * Skips the request burst from mounting inactive tabs.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  active: boolean,
  poll: boolean,
  intervalMs = 15000
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const backoffUntilRef = useRef(0);
  const loadedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!active || dashboardSessionExpired) return;
    if (Date.now() < backoffUntilRef.current) return;

    if (!loadedRef.current) setLoading(true);
    try {
      setError(null);
      const result = await fetcherRef.current();
      setData(result);
      loadedRef.current = true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        expireDashboardSession();
        return;
      }
      if (e instanceof ApiError && e.status === 429) {
        backoffUntilRef.current = Date.now() + RATE_LIMIT_BACKOFF_MS;
        setError(
          'Too many requests — live refresh paused for 1 minute. Disable live refresh or wait.'
        );
      } else {
        setError(formatFetchError(e));
      }
    } finally {
      setLoading(false);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  useEffect(() => {
    if (!active || !poll) return;
    const id = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, poll, intervalMs, refresh]);

  return { data, error, loading, refresh };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function formatTs(iso: string | number | null | undefined): string {
  if (iso == null) return '—';
  try {
    const d = typeof iso === 'number' ? new Date(iso) : new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString();
  } catch {
    return String(iso);
  }
}
