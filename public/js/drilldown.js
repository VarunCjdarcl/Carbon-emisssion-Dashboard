// Customer drill-down: paginated, sortable shipment table modal.

const Drilldown = (() => {
  const COLUMNS = [
    { key: 'shipmentNo',           label: 'Shipment No.',          numeric: false },
    { key: 'consignmentNumber',    label: 'Consignment Number',    numeric: false },
    { key: 'vehicleType',          label: 'Vehicle Type',          numeric: false },
    { key: 'source',               label: 'Source',                numeric: false },
    { key: 'destination',          label: 'Destination',           numeric: false },
    { key: 'transportationMode',   label: 'Transportation Mode',   numeric: false },
    { key: 'carbonEmissionValue',  label: 'carbonEmissionValue',   numeric: true },
    { key: 'totalDistance',        label: 'TotalDistance',         numeric: true },
    { key: 'fuelUsed',             label: 'fuelUsed',              numeric: true },
    { key: 'aversionValue_lng',    label: 'aversionValue_lng',     numeric: true },
    { key: 'aversionValue_electric', label: 'aversionValue_electric', numeric: true },
    { key: 'aversionValue_hydrogen', label: 'aversionValue_hydrogen', numeric: true },
    { key: 'aversionValue_rail',   label: 'aversionValue_rail',    numeric: true },
  ];

  const state = {
    customer: null,
    rows: [],
    sortKey: 'shipmentNo',
    sortDir: 'asc',
    page: 1,
    pageSize: 10,
  };

  function attach() {
    document.querySelectorAll('#drilldownModal [data-close]').forEach(el => {
      el.addEventListener('click', close);
    });
    document.getElementById('drillDownload').addEventListener('click', downloadXlsx);
    document.getElementById('drillMail').addEventListener('click', () => {
      EmailModal.open({
        customer: state.customer,
        period: state.period,
        totals: state.totals,
      });
    });
    document.getElementById('prevPage').addEventListener('click', () => {
      if (state.page > 1) { state.page--; renderTable(); }
    });
    document.getElementById('nextPage').addEventListener('click', () => {
      const max = Math.max(1, Math.ceil(state.rows.length / state.pageSize));
      if (state.page < max) { state.page++; renderTable(); }
    });
  }

  async function open(customer) {
    state.customer = customer;
    state.page = 1;
    document.getElementById('drillCustomerName').textContent = `Group 1 : ${customer.customerName.toUpperCase()}`;
    document.getElementById('drilldownModal').hidden = false;

    const period = Period.getCurrent();
    state.period = period;

    document.getElementById('drillSummary').innerHTML = `<span class="stat-pill">Loading shipments…</span>`;
    document.querySelector('#drillTable thead').innerHTML = '';
    document.querySelector('#drillTable tbody').innerHTML = '';

    const params = new URLSearchParams();
    params.set('customer', customer.customerCode);
    params.set('preset', period.preset || 'thisMonth');
    if (period.preset === 'custom' && period.from && period.till) {
      params.set('from', period.from); params.set('till', period.till);
    }
    if (period.nowRef) params.set('now', String(period.nowRef));
    let data;
    try {
      data = await Util.api('/api/emissions/customer-shipments?' + params.toString());
    } catch (e) {
      Util.toast(e.message, 'error');
      return;
    }
    state.rows = data.shipments || [];
    state.totals = data.totals;
    state.customer = { ...customer, customerEmail: data.customerEmail || customer.customerEmail };
    renderHeader();
    renderTable();
    renderSummary(data);
  }

  function renderSummary(data) {
    const el = document.getElementById('drillSummary');
    const t = data.totals;
    el.innerHTML = `
      <span class="stat-pill"><strong>${Util.fmtNum(t.totalShipments, 0)}</strong> shipments</span>
      <span class="stat-pill stat-blue">Road emissions <strong>${Util.fmtNum(t.totalEmission, 0)}</strong> kg CO₂e</span>
      <span class="stat-pill">Rail aversion <strong>${Util.fmtNum(t.totalAversionRail, 0)}</strong> kg CO₂e</span>
      <span class="stat-pill">Distance <strong>${Util.fmtNum(t.totalDistance, 0)}</strong> km</span>
      <span class="stat-pill">${data.presetLabel}</span>
    `;
  }

  function renderHeader() {
    const head = document.querySelector('#drillTable thead');
    const tr = document.createElement('tr');
    for (const c of COLUMNS) {
      const th = document.createElement('th');
      th.className = c.numeric ? 'num' : '';
      const arrow = state.sortKey === c.key ? (state.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
      th.textContent = c.label + arrow;
      th.addEventListener('click', () => {
        if (state.sortKey === c.key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortKey = c.key; state.sortDir = c.numeric ? 'desc' : 'asc'; }
        renderHeader();
        renderTable();
      });
      tr.appendChild(th);
    }
    head.innerHTML = '';
    head.appendChild(tr);
  }

  function renderTable() {
    const tbody = document.querySelector('#drillTable tbody');
    const rows = sortedRows();
    const start = (state.page - 1) * state.pageSize;
    const slice = rows.slice(start, start + state.pageSize);
    tbody.innerHTML = '';
    for (const r of slice) {
      const tr = document.createElement('tr');
      for (const c of COLUMNS) {
        const td = document.createElement('td');
        td.className = c.numeric ? 'num' : '';
        if (c.key === 'shipmentNo') {
          td.innerHTML = `<a class="shipment-link" href="#">${Util.escapeHtml(r.shipmentNo || '')}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h7v7"/><path d="M10 14L21 3"/><path d="M21 21H3V3"/></svg>
          </a>`;
        } else {
          const v = r[c.key];
          td.textContent = c.numeric
            ? (v === null || v === undefined ? '—' : Util.fmtNum(v, 1))
            : (v ?? '—');
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    document.getElementById('drillCount').textContent = `${rows.length} shipments`;
    const max = Math.max(1, Math.ceil(rows.length / state.pageSize));
    document.getElementById('pageInfo').textContent = `${state.page} / ${max}`;
    document.getElementById('prevPage').disabled = state.page <= 1;
    document.getElementById('nextPage').disabled = state.page >= max;
  }

  function sortedRows() {
    const k = state.sortKey;
    const dir = state.sortDir === 'asc' ? 1 : -1;
    return [...state.rows].sort((a, b) => {
      const va = a[k]; const vb = b[k];
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  function close() { document.getElementById('drilldownModal').hidden = true; }

  function downloadXlsx() {
    if (!state.customer) return;
    const period = state.period || Period.getCurrent();
    const params = new URLSearchParams();
    params.set('customer', state.customer.customerCode);
    params.set('preset', period.preset || 'thisMonth');
    if (period.preset === 'custom' && period.from && period.till) {
      params.set('from', period.from); params.set('till', period.till);
    }
    if (period.nowRef) params.set('now', String(period.nowRef));
    const url = '/api/reports/customer.xlsx?' + params.toString();
    window.location.href = url;
  }

  return { attach, open, close, getState: () => state };
})();
