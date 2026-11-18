import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { UiState } from '@/types';
import { ApiError, loadUiState, postAction } from '@/lib/api';

interface AppContextValue {
  state: UiState | null;
  loading: boolean;
  error: string;
  busy: boolean;
  refresh: () => Promise<void>;
  submit: (
    path: string,
    data?: FormData | Record<string, string | number | boolean | undefined>,
  ) => Promise<void>;
}
const AppContext = createContext<AppContextValue | null>(null);

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider.');
  return value;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<UiState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedView, setLoadedView] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const view = location.pathname + location.search;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await loadUiState(view);
      setState(next);
      setLoadedView(view);
      if (next.flash?.error) toast.error(next.flash.error);
      if (next.flash?.success) toast.success(next.flash.success);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Unable to load this page.';
      setError(message);
      setLoadedView(view);
      if (reason instanceof ApiError && reason.status === 401 && view !== '/login') {
        const target = '/login?returnTo=' + encodeURIComponent(view);
        navigate(target, { replace: true });
      }
    } finally {
      setLoading(false);
    }
  }, [navigate, view]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = useCallback(
    async (
      path: string,
      data: FormData | Record<string, string | number | boolean | undefined> = {},
    ) => {
      if (!state) throw new Error('Session not ready.');
      setBusy(true);
      try {
        const redirectTo = await postAction(path, data, state.csrfToken);
        if (redirectTo === view) await refresh();
        else navigate(redirectTo);
      } catch (reason) {
        toast.error(reason instanceof Error ? reason.message : 'Action failed.');
        throw reason;
      } finally {
        setBusy(false);
      }
    },
    [navigate, refresh, state, view],
  );

  // A route transition must not render the previous route's authorization state.
  const routeLoading = loading || loadedView !== view;
  const value = useMemo(
    () => ({ state, loading: routeLoading, error, busy, refresh, submit }),
    [state, routeLoading, error, busy, refresh, submit],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
