// Top-level wiring for the dashboard.

(function () {
  const state = { view: 'time' };

  // ---- Request supervisor state ----
  // Declared up here (not after the function defs) so the initial refresh()
  // call during bootstrap doesn't hit the Temporal Dead Zone on these `let`s.
  // Only one refresh() runs at a time; a new one aborts the previous.
  // The loader is deferred 200ms so cached/instant responses don't flicker.
  let activeController = null;
  let loaderTimer = null;

  // Bootstrap runs after /api/health resolves so we can pick a default preset
  // that actually contains data. When ETL is caught up, `last7` is used (fresh
  // 7-day view). When the synced dataset is behind (dev without TMS, paused
  // ETL, etc.), we widen to `last1year` so the dashboard never opens empty.
  fetch('/api/health', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : {})
    .catch(() => ({}))
    .then(h => {
      const pill = document.getElementById('envPill');
      if (pill) {
        if (h.demo) { pill.textContent = 'demo mode'; pill.classList.add('demo'); }
        else        { pill.textContent = 'live TMS'; pill.classList.remove('demo'); }
      }

      // When the synced dataset is behind "today", anchor every preset to the
      // newest available data instead of real-now. This keeps "Last 7 Days"
      // meaningful (7 days ending on the freshest data) and lets the dashboard
      // open with real content by default.
      const latest = h.latestDataAt ? new Date(h.latestDataAt).getTime() : null;
      let nowRef = null;
      if (latest) {
        const daysStale = (Date.now() - latest) / 86400000;
        if (daysStale > 2) { nowRef = latest; renderDataFreshness(latest, daysStale); }
      }

      bootstrap('last7', nowRef);
    });

  function bootstrap(defaultPreset, nowRef) {
    // Each init/attach is isolated: a failure in a peripheral module (modals,
    // customer list) must never stop the dashboard from loading its data on open.
    safe('Period.init',        () => Period.init({ onApply: refresh, defaultPreset, nowRef }));
    safe('CustomerFilter.init',() => CustomerFilter.init({ onChange: refresh }));
    safe('Drilldown.attach',   () => Drilldown.attach());
    safe('EmailModal.attach',  () => EmailModal.attach());

    safe('viewSelect', () => {
      document.getElementById('viewSelect').addEventListener('change', e => {
        state.view = e.target.value;
        syncViewVisibility();
        refresh();
      });
    });

    safe('syncViewVisibility', syncViewVisibility);
    refresh();
  }

  function renderDataFreshness(latestMs, daysStale) {
    const host = document.getElementById('activePill');
    if (!host) return;
    // A small note under the topbar. Only shown when data is > 2 days behind,
    // to avoid noise on a live-ETL production deployment.
    if (daysStale <= 2) return;
    let el = document.getElementById('dataFreshness');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dataFreshness';
      el.className = 'data-freshness';
      const container = document.querySelector('.container');
      if (container) container.insertBefore(el, container.firstChild);
    }
    const d = new Date(latestMs).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const days = Math.round(daysStale);
    el.textContent = `Local dataset is ${days} days behind — showing data as of ${d}. All time windows (Last 7 Days, This Month, etc.) are anchored to this date.`;
  }

  function safe(label, fn) {
    try { fn(); }
    catch (err) { console.error(`[init] ${label} failed:`, err); }
  }

  function syncViewVisibility() {
    const isCustomer = state.view === 'customer';
    document.getElementById('timeViewCard').hidden = isCustomer;
    document.getElementById('customerViewCard').hidden = !isCustomer;
    CustomerFilter.show(isCustomer);
  }

  // ---- Request supervisor ----
  async function refresh() {
    if (activeController) activeController.abort();
    const controller = new AbortController();
    activeController = controller;
    const period = Period.getCurrent();
    const cust = CustomerFilter.getCurrent();

    // Defer loader so cached (sub-200ms) responses never show it
    clearTimeout(loaderTimer);
    loaderTimer = setTimeout(() => {
      if (controller === activeController) showLoading(true);
    }, 200);

    try {
      if (state.view === 'time') {
        await TimeView.load(period, { signal: controller.signal });
      } else {
        await CustomerView.load(period, cust.code, { signal: controller.signal });
      }
    } finally {
      // Only the latest refresh hides the loader; aborted ones leave it alone
      if (controller === activeController) {
        clearTimeout(loaderTimer);
        showLoading(false);
        activeController = null;
      }
    }
  }

  function showLoading(on) {
    let el = document.getElementById('globalLoader');
    if (!el && on) {
      el = document.createElement('div');
      el.id = 'globalLoader';
      el.className = 'global-loader';
      el.innerHTML = `
        <div class="loader-card">
          <div class="spinner"></div>
          <div class="loader-text">
            <strong>Loading data…</strong>
            <span>Pulling from TMS — instant when cached, up to ~1 min on cold ranges.</span>
          </div>
        </div>`;
      document.body.appendChild(el);
    }
    if (el) el.classList.toggle('show', !!on);
  }
})();
