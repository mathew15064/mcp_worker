interface WorkerStatus {id: string; enabled: boolean; connected: boolean; last_seen_at?: string | null}
interface WorkerProbe {id: string; ok: boolean; latency_ms?: number}
interface WorkerStatusResponse {workers: WorkerStatus[]; probe?: WorkerProbe | null}
interface ProfileEdit {id?: string; name?: string; description?: string; worker_id?: string; enabled?: boolean}
interface ApiError {message?: string; duration_ms?: number; version?: string}
(() => {
  'use strict';

  const $ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode | null | undefined = document): T | null => root?.querySelector<T>(selector) || null;
  const $$ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode | null | undefined = document): T[] => Array.from(root?.querySelectorAll<T>(selector) || []);
  const modalOpeners = new WeakMap<HTMLElement, HTMLElement>();
  const focusableSelector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([type="hidden"]):not([disabled])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function setTheme(theme: string) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('bot-report-theme', theme);
    $$('[data-theme-toggle]').forEach(button => {
      button.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
      button.setAttribute('title', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    });
  }

  setTheme(localStorage.getItem('bot-report-theme') || 'dark');
  $$<HTMLInputElement>('[data-account-return-to]').forEach(input => {
    input.value = `${window.location.pathname}${window.location.search}`;
  });
  $$('[data-theme-toggle]').forEach(button => button.addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  }));

  function focusables(root: HTMLElement) {
    return $$(focusableSelector, root).filter(element => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && !element.hidden;
    });
  }

  function openModal(id: string | undefined, opener: Element | null = document.activeElement) {
    const backdrop = id ? document.getElementById(id) : null;
    if (!backdrop) return;
    if (opener instanceof HTMLElement) modalOpeners.set(backdrop, opener);
    backdrop.classList.add('open');
    backdrop.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    const first = focusables(backdrop)[0];
    if (first) requestAnimationFrame(() => first.focus());
  }

  function closeModal(backdrop: HTMLElement | null, { restoreFocus = true }: {restoreFocus?: boolean} = {}) {
    if (!backdrop) return;
    backdrop.classList.remove('open');
    backdrop.setAttribute('aria-hidden', 'true');
    if (!$('.modal-backdrop.open')) document.body.classList.remove('modal-open');
    if (backdrop.id === 'confirm-modal') pendingForm = null;
    const opener = modalOpeners.get(backdrop);
    modalOpeners.delete(backdrop);
    if (restoreFocus && opener?.isConnected) requestAnimationFrame(() => opener.focus());
  }

  $$('[data-modal-open]').forEach(button => button.addEventListener('click', () => openModal(button.dataset.modalOpen, button)));
  $$('[data-modal-close]').forEach(button => button.addEventListener('click', () => closeModal(button.closest('.modal-backdrop'))));
  $$('[data-auto-open="true"]').forEach(backdrop => openModal(backdrop.id, null));

  function trapModalFocus(event: KeyboardEvent, backdrop: HTMLElement) {
    if (event.key !== 'Tab') return false;
    const items = focusables(backdrop);
    if (!items.length) return false;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return true;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
      return true;
    }
    return false;
  }

  function toast(kind: string, title: string, message: string) {
    const stack = $('#toast-stack');
    if (!stack || !message) return;
    const item = document.createElement('div');
    item.className = `toast toast-${kind}`;
    item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    item.innerHTML = '<div><div class="toast-title"></div><div class="toast-message"></div></div>';
    $('.toast-title', item)!.textContent = title;
    $('.toast-message', item)!.textContent = message;
    stack.appendChild(item);
    setTimeout(() => item.remove(), 4800);
  }

  const flash = $('#flash-data');
  if (flash) {
    if (flash.dataset.success) toast('success', 'Success', flash.dataset.success);
    if (flash.dataset.error) toast('error', 'Something went wrong', flash.dataset.error);
  }

  async function copyText(value: string | undefined, button: HTMLElement | null = null) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      const original = button?.innerHTML;
      if (button) {
        button.innerHTML = 'Copied';
        setTimeout(() => { button.innerHTML = original || ''; }, 1200);
      }
      toast('success', 'Copied', 'Value copied to clipboard.');
    } catch (_) {
      toast('error', 'Copy failed', 'Clipboard access is unavailable.');
    }
  }

  $$('[data-copy-value]').forEach(button => button.addEventListener('click', () => copyText(button.dataset.copyValue, button)));
  $$('[data-copy-target]').forEach(button => button.addEventListener('click', () => {
    const target = button.dataset.copyTarget ? document.getElementById(button.dataset.copyTarget) : null;
    copyText(target?.textContent?.trim() || (target instanceof HTMLInputElement ? target.value : ''), button);
  }));

  function prettyAuditPayload(raw: string | null | undefined) {
    if (raw === null || raw === undefined || raw === '') return 'Payload was not captured for this legacy audit event.';
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed._audit_truncated && typeof parsed.preview === 'string') return parsed.preview;
      return JSON.stringify(parsed, null, 2);
    } catch (_) {
      return String(raw);
    }
  }

  async function loadAuditDetail(id: string | undefined) {
    const requestPayload = $('#audit-request-payload');
    const responsePayload = $('#audit-response-payload');
    const requestNote = $('#audit-request-note');
    const responseNote = $('#audit-response-note');
    if (!requestPayload || !responsePayload) return;
    requestPayload.textContent = 'Loading request payload…';
    responsePayload.textContent = 'Loading response payload…';
    if (requestNote) requestNote.hidden = true;
    if (responseNote) responseNote.hidden = true;
    try {
      const response = await fetch(`/admin/audit/${encodeURIComponent(id || '')}`, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const detail = await response.json();
      const set = (selector: string, value: string) => { const target = $(selector); if (target) target.textContent = value ?? '—'; };
      set('#audit-detail-request-id', detail.request_id || '—');
      set('#audit-detail-client', detail.client_display_name || detail.client_id || 'Unknown client');
      set('#audit-detail-method', detail.mcp_method || '—');
      set('#audit-detail-tool', detail.tool_name || '—');
      set('#audit-detail-result', detail.result || '—');
      set('#audit-detail-http', `${detail.http_status ?? '—'} · ${detail.duration_ms ?? '—'} ms`);
      requestPayload.textContent = prettyAuditPayload(detail.request_payload);
      responsePayload.textContent = prettyAuditPayload(detail.response_payload);
      if (requestNote) requestNote.hidden = !detail.request_truncated;
      if (responseNote) responseNote.hidden = !detail.response_truncated;
    } catch (_) {
      requestPayload.textContent = 'Unable to load audit payload.';
      responsePayload.textContent = 'Unable to load audit payload.';
      toast('error', 'Audit detail unavailable', 'The request/response payload could not be loaded.');
    }
  }

  $$('[data-audit-detail]').forEach(button => button.addEventListener('click', () => loadAuditDetail(button.dataset.auditDetail)));

  $$<HTMLInputElement>('[data-table-search]').forEach(input => input.addEventListener('input', () => {
    const table = document.getElementById(input.dataset.tableSearch || '');
    if (!table) return;
    const query = input.value.trim().toLowerCase();
    let visible = 0;
    $$('tbody tr', table).forEach(row => {
      const haystack = (row.dataset.search || row.textContent || '').toLowerCase();
      row.hidden = Boolean(query && !haystack.includes(query));
      if (!row.hidden) visible += 1;
    });
    const empty = document.querySelector<HTMLElement>(`[data-search-empty="${input.dataset.tableSearch}"]`);
    if (empty) empty.hidden = visible !== 0;
  }));

  $$<HTMLSelectElement>('[data-page-size]').forEach(select => select.addEventListener('change', () => {
    select.closest<HTMLFormElement>('form')?.requestSubmit();
  }));

  function closeDropdown(details: HTMLDetailsElement) {
    details.removeAttribute('open');
    const summary = $('summary', details);
    summary?.setAttribute('aria-expanded', 'false');
  }

  function positionDropdown(details: HTMLDetailsElement) {
    const summary = $('summary', details);
    const menu = $<HTMLElement>('.menu', details);
    if (!summary || !menu) return;
    const trigger = summary.getBoundingClientRect();
    const menuBox = menu.getBoundingClientRect();
    const gap = 6;
    const margin = 10;
    let left = trigger.right - menuBox.width;
    left = Math.max(margin, Math.min(left, window.innerWidth - menuBox.width - margin));
    let top = trigger.bottom + gap;
    if (top + menuBox.height > window.innerHeight - margin) top = trigger.top - menuBox.height - gap;
    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
  }

  $$<HTMLDetailsElement>('.dropdown').forEach(details => {
    const summary = $('summary', details);
    summary?.setAttribute('aria-expanded', 'false');
    details.addEventListener('toggle', () => {
      if (!details.open) {
        summary?.setAttribute('aria-expanded', 'false');
        return;
      }
      $$<HTMLDetailsElement>('.dropdown[open]').filter(other => other !== details).forEach(closeDropdown);
      summary?.setAttribute('aria-expanded', 'true');
      positionDropdown(details);
      requestAnimationFrame(() => positionDropdown(details));
    });
  });

  document.addEventListener('click', event => {
    $$<HTMLDetailsElement>('.dropdown[open]').forEach(details => {
      if (event.target instanceof Node && !details.contains(event.target)) closeDropdown(details);
    });
  });
  window.addEventListener('resize', () => $$<HTMLDetailsElement>('.dropdown[open]').forEach(closeDropdown));
  window.addEventListener('scroll', () => $$<HTMLDetailsElement>('.dropdown[open]').forEach(closeDropdown), true);

  let pendingForm: HTMLFormElement | null = null;
  const confirmModal = $('#confirm-modal');
  $$<HTMLFormElement>('form[data-confirm-title]').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    pendingForm = form;
    if (!confirmModal) return form.submit();
    $('#confirm-title')!.textContent = form.dataset.confirmTitle || 'Confirm action';
    $('#confirm-message')!.textContent = form.dataset.confirmMessage || 'Are you sure?';
    $('#confirm-action')!.textContent = form.dataset.confirmAction || 'Continue';
    $('#confirm-action')!.className = `btn ${form.dataset.confirmDanger === 'true' ? 'btn-danger' : 'btn-primary'}`;
    const opener = event.submitter || document.activeElement;
    openModal('confirm-modal', opener);
  }));
  $('#confirm-action')?.addEventListener('click', () => {
    if (!pendingForm) return;
    const form = pendingForm;
    pendingForm = null;
    closeModal(confirmModal, { restoreFocus: false });
    form.submit();
  });

  // The Worker initiates its own WSS connection. After Enable, poll for that
  // connection and confirm it with a real WebSocket ping/pong before reporting success.
  const workerStatusTable = $('#workers-table[data-worker-status-url]');
  if (workerStatusTable) {
    const workerRows = new Map<string, HTMLElement>($$('tbody tr[data-worker-id]', workerStatusTable).map(row => [row.dataset.workerId || '', row]));
    const searchInput = $<HTMLInputElement>('[data-table-search="workers-table"]');
    let checkingWorkerId = workerStatusTable.dataset.workerCheck || '';
    const checkDeadline = Date.now() + 30000;
    let checkingFinished = false;
    if (checkingWorkerId) {
      const badge = $('[data-worker-connection]', workerRows.get(checkingWorkerId));
      if (badge) badge.textContent = 'Checking…';
    }

    const statusTable = workerStatusTable;
    function finishWorkerCheck() {
      checkingFinished = true;
      checkingWorkerId = '';
      statusTable.dataset.workerCheck = '';
      const page = new URL(window.location.href);
      if (page.searchParams.has('check')) {
        page.searchParams.delete('check');
        window.history.replaceState(null, '', page.pathname + page.search + page.hash);
      }
    }

    async function refreshWorkerConnections() {
      try {
        const url = new URL(statusTable.dataset.workerStatusUrl || '', window.location.origin);
        if (checkingWorkerId) url.searchParams.set('check', checkingWorkerId);
        const response = await fetch(url, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as WorkerStatusResponse;
        if (!Array.isArray(payload.workers)) throw new Error('Invalid Worker status response');
        const counts: Record<'online' | 'offline' | 'disabled', number> = { online: 0, offline: 0, disabled: 0 };
        let checkingWorker: WorkerStatus | null = null;
        for (const worker of payload.workers) {
          const row = workerRows.get(worker.id);
          if (!row) continue;
          if (worker.id === checkingWorkerId) checkingWorker = worker;
          const state = !worker.enabled ? 'disabled' : worker.connected ? 'online' : 'offline';
          counts[state] += 1;
          const waiting = worker.id === checkingWorkerId && !checkingFinished &&
            Date.now() < checkDeadline && !(payload.probe?.id === worker.id && payload.probe.ok && worker.connected);
          const label = waiting ? 'Checking…' : state[0].toUpperCase() + state.slice(1);
          const badge = $('[data-worker-connection]', row);
          if (badge) {
            badge.textContent = label;
            badge.className = `badge ${state === 'online' ? 'badge-ok' : 'badge-off'}`;
            badge.title = waiting ? 'Waiting for outbound Worker reconnect and WSS ping/pong' : '';
          }
          row.dataset.search = `${row.dataset.workerSearchBase || ''} ${label}`;
          const lastSeen = $('[data-worker-last-seen]', row);
          if (lastSeen) {
            const timestamp = worker.last_seen_at ? new Date(worker.last_seen_at) : null;
            lastSeen.textContent = timestamp && !Number.isNaN(timestamp.getTime())
              ? timestamp.toLocaleString('en-GB') : 'Never';
          }
        }
        for (const type of ['online', 'offline', 'disabled'] as const) {
          const badge = `[data-worker-count="${type}"]`;
          const element = $(badge);
          if (element) element.textContent = `${counts[type]} ${type}`;
        }
        if (searchInput?.value) searchInput.dispatchEvent(new Event('input'));
        if (checkingWorkerId && !checkingFinished) {
          if (!checkingWorker?.enabled) {
            toast('error', 'Worker check cancelled', 'The Worker was disabled or is no longer available.');
            finishWorkerCheck();
          } else if (checkingWorker.connected && payload.probe?.id === checkingWorkerId && payload.probe.ok) {
            const latency = payload.probe.latency_ms;
            toast('success', 'Worker connection verified', `Outbound WSS is online. Ping/pong succeeded${Number.isFinite(latency) ? ` in ${latency} ms` : ''}.`);
            finishWorkerCheck();
          } else if (Date.now() >= checkDeadline) {
            toast('error', 'Worker connection not confirmed', checkingWorker.connected
              ? 'The WebSocket opened, but its ping/pong check did not succeed.'
              : 'The Worker has not reconnected yet. Check the Worker service and authentication logs.');
            finishWorkerCheck();
          }
        }
      } catch (_) {
        if (checkingWorkerId && Date.now() >= checkDeadline) {
          toast('error', 'Worker status unavailable', 'Unable to verify the Worker connection. Please refresh or check server logs.');
          finishWorkerCheck();
        }
      } finally {
        window.setTimeout(refreshWorkerConnections, checkingWorkerId ? 2500 : 5000);
      }
    }
    refreshWorkerConnections();
  }

  const workerEditForm = $<HTMLFormElement>('#worker-edit-form');
  $$('[data-worker-edit]').forEach(button => button.addEventListener('click', () => {
    try {
      const worker = JSON.parse(button.dataset.workerEdit || '{}') as {id?: string;name?: string};
      const routeBase = button.dataset.workerRouteBase || '/admin/workers';
      if (!worker?.id || !workerEditForm) throw new Error('missing worker');
      workerEditForm.action = `${routeBase}/${encodeURIComponent(worker.id)}/edit`;
      const name = workerEditForm.elements.namedItem('name');
      if (name instanceof HTMLInputElement) name.value = worker.name || '';
    } catch (_) {
      toast('error', 'Unable to edit Worker', 'Worker data could not be loaded.');
    }
  }));

  const accountSshForm = $<HTMLFormElement>('#account-ssh-form');
  function configureAccountSshForm(profile: ProfileEdit | null = null) {
    if (!accountSshForm) return;
    const editing = Boolean(profile?.id);
    const routeBase = accountSshForm.dataset.routeBase || '/account/ssh-profiles';
    accountSshForm.action = editing ? `${routeBase}/${encodeURIComponent(profile?.id || '')}/update` : routeBase;
    const set = (name: string, value: string | null | undefined) => {
      const field = accountSshForm.elements.namedItem(name);
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) field.value = value ?? '';
    };
    set('name', profile?.name || '');
    set('description', profile?.description || '');
    set('worker_id', profile?.worker_id || '');
    const enabled = accountSshForm.elements.namedItem('enabled');
    if (enabled instanceof HTMLInputElement) enabled.checked = profile ? Boolean(profile.enabled) : true;
    const title = $('#account-ssh-title');
    if (title) title.textContent = 'Edit SSH Profile';
  }
  $$('[data-account-ssh-edit]').forEach(button => button.addEventListener('click', () => {
    try { configureAccountSshForm(JSON.parse(button.dataset.accountSshEdit || '{}') as ProfileEdit); }
    catch (_) { toast('error', 'Unable to edit SSH Profile', 'Profile data could not be loaded.'); }
  }));

  $$<HTMLFormElement>('form[data-terminal-test]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const original = button?.innerHTML || '';
    if (button) {
      button.disabled = true;
      button.textContent = 'Testing…';
    }
    const dropdown = form.closest<HTMLDetailsElement>('.dropdown');
    if (dropdown) closeDropdown(dropdown);
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: new URLSearchParams([...new FormData(form).entries()].map(([key, value]) => [key, String(value)]))
      });
      const payload = await response.json().catch(() => ({})) as ApiError;
      if (!response.ok) throw new Error(payload.message || 'Connection test failed.');
      const detail = `${payload.message || 'Connection verified.'}${Number.isFinite(payload.duration_ms) ? ` ${payload.duration_ms} ms.` : ''}`;
      toast('success', `${form.dataset.profileName || 'Terminal'} is reachable`, detail);
    } catch (error) {
      toast('error', `${form.dataset.profileName || 'Terminal'} connection failed`, error instanceof Error ? error.message : 'Connection test failed.');
    } finally {
      if (button) {
        button.disabled = false;
        button.innerHTML = original || '';
      }
    }
  }));

  const sidebar = $('#admin-sidebar');
  const mobileMenu = $('[data-mobile-menu]');
  const sidebarScrim = $('[data-sidebar-scrim]');
  const sidebarCollapse = $('[data-sidebar-collapse]');
  const sidebarCollapseKey = 'bot-report-sidebar-collapsed';

  function setSidebar(open: boolean) {
    if (!sidebar || !mobileMenu) return;
    sidebar.classList.toggle('open', open);
    sidebarScrim?.classList.toggle('open', open);
    mobileMenu.setAttribute('aria-expanded', String(open));
    mobileMenu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    document.body.classList.toggle('sidebar-open', open);
  }

  function setSidebarCollapsed(collapsed: boolean, { persist = true }: {persist?: boolean} = {}) {
    if (!sidebar || !sidebarCollapse) return;
    const desktop = window.matchMedia('(min-width: 781px)').matches;
    const active = desktop && collapsed;
    sidebar.classList.toggle('collapsed', active);
    document.body.classList.toggle('sidebar-collapsed', active);
    sidebarCollapse.setAttribute('aria-label', active ? 'Expand sidebar' : 'Collapse sidebar');
    sidebarCollapse.setAttribute('title', active ? 'Expand sidebar' : 'Collapse sidebar');
    sidebarCollapse.setAttribute('aria-expanded', String(!active));
    if (persist) localStorage.setItem(sidebarCollapseKey, String(collapsed));
  }

  const savedSidebarCollapsed = localStorage.getItem(sidebarCollapseKey) === 'true';
  setSidebarCollapsed(savedSidebarCollapsed, { persist: false });
  mobileMenu?.addEventListener('click', () => setSidebar(!sidebar?.classList.contains('open')));
  sidebarScrim?.addEventListener('click', () => setSidebar(false));
  sidebarCollapse?.addEventListener('click', () => setSidebarCollapsed(!sidebar?.classList.contains('collapsed')));
  window.addEventListener('resize', () => setSidebarCollapsed(localStorage.getItem(sidebarCollapseKey) === 'true', { persist: false }));
  $$('.nav-link', sidebar || document).forEach(link => link.addEventListener('click', () => setSidebar(false)));

  document.addEventListener('keydown', event => {
    const modal = $('.modal-backdrop.open');
    if (modal && trapModalFocus(event, modal)) return;
    if (event.key !== 'Escape') return;
    if (modal) {
      if (modal.dataset.static !== 'true') closeModal(modal);
      return;
    }
    const dropdown = $<HTMLDetailsElement>('.dropdown[open]');
    if (dropdown) {
      closeDropdown(dropdown);
      $('summary', dropdown)?.focus();
      return;
    }
    if (sidebar?.classList.contains('open')) {
      setSidebar(false);
      mobileMenu?.focus();
    }
  });

  $$<HTMLButtonElement>('[data-test-database]').forEach(button => button.addEventListener('click', async event => {
    event.preventDefault();
    const form = button.form;
    if (!form) return;
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = 'Testing…';
    try {
      const response = await fetch(button.formAction, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams([...new FormData(form).entries()].map(([key, value]) => [key, String(value)]))
      });
      const payload = await response.json().catch(() => ({})) as ApiError;
      if (!response.ok) throw new Error(payload.message || 'MySQL connection failed.');
      toast('success', 'MySQL connection successful', `${payload.version || 'MySQL'} · ${payload.duration_ms ?? '—'} ms`);
    } catch (error) {
      toast('error', 'MySQL connection failed', error instanceof Error ? error.message : 'Unable to connect to MySQL.');
    } finally {
      button.disabled = false;
      button.innerHTML = original || '';
    }
  }));

  $$<HTMLFormElement>('form[data-disable-on-submit]').forEach(form => form.addEventListener('submit', () => {
    $$<HTMLButtonElement>('button[type="submit"]', form).forEach(button => {
      button.disabled = true;
      button.dataset.originalHtml = button.innerHTML;
      button.textContent = 'Saving…';
    });
  }));
})();
