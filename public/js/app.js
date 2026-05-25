// Top-level wiring for the dashboard.

(function () {
  const state = { view: 'time' };

  Period.init({ onApply: refresh });
  CustomerFilter.init({ onChange: refresh });
  Drilldown.attach();
  EmailModal.attach();

  document.getElementById('viewSelect').addEventListener('change', e => {
    state.view = e.target.value;
    syncViewVisibility();
    refresh();
  });

  // Bootstrap: detect demo mode pill
  fetch('/api/health').then(r => r.json()).then(h => {
    const pill = document.getElementById('envPill');
    if (h.demo) { pill.textContent = 'demo mode'; pill.classList.add('demo'); }
    else        { pill.textContent = 'live TMS'; pill.classList.remove('demo'); }
  }).catch(() => {});

  syncViewVisibility();
  refresh();

  function syncViewVisibility() {
    const isCustomer = state.view === 'customer';
    document.getElementById('timeViewCard').hidden = isCustomer;
    document.getElementById('customerViewCard').hidden = !isCustomer;
    CustomerFilter.show(isCustomer);
  }

  // ---- Request supervisor ----
  // Only one refresh() can be in-flight at a time. New refresh aborts old.
  // The loader is deferred 200ms so cached/instant responses don't flicker.
  let activeController = null;
  let loaderTimer = null;

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
