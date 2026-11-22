import { useEffect, useRef } from 'react';

type TurnstileApi = {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export function TurnstileWidget({
  siteKey,
  action,
  onToken,
}: {
  siteKey: string;
  action: 'login' | 'register' | 'config-test';
  onToken: (token: string) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  callback.current = onToken;

  useEffect(() => {
    if (!siteKey || !element.current) return;
    let disposed = false;
    let widgetId: string | undefined;
    const render = () => {
      if (disposed || widgetId || !window.turnstile || !element.current) return;
      widgetId = window.turnstile.render(element.current, {
        sitekey: siteKey,
        action,
        callback: (value) => {
          if (!disposed) callback.current(value);
        },
        'expired-callback': () => callback.current(''),
        'error-callback': () => callback.current(''),
      });
    };
    let script = document.querySelector<HTMLScriptElement>('script[data-mcp-turnstile]');
    if (!script) {
      script = document.createElement('script');
      script.dataset.mcpTurnstile = 'true';
      script.async = true;
      script.defer = true;
      script.src = SCRIPT_URL;
      document.head.appendChild(script);
    }
    script.addEventListener('load', render);
    render();
    return () => {
      disposed = true;
      callback.current('');
      script?.removeEventListener('load', render);
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [siteKey, action]);

  return <div className="min-h-16" ref={element} aria-label="Cloudflare Turnstile verification" />;
}
