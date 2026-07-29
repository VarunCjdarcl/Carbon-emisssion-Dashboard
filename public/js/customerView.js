// Carbon Emission vs Customer view — orange bar chart with drill-down on click.

const CustomerView = (() => {
  let chart = null;
  let lastData = null;

  // Plotting all ~800 customers turns the X-axis into an unreadable smear.
  // The backend returns them sorted by emissions (highest first), so we chart
  // only the biggest contributors. KPI tiles + Total/Avg/Top still reflect
  // every customer — this cap is purely a chart-readability limit.
  const TOP_N = 15;

  async function load(period, customerCode, { signal } = {}) {
    const params = new URLSearchParams();
    params.set('preset', period.preset || 'thisMonth');
    if (period.preset === 'custom' && period.from && period.till) {
      params.set('from', period.from); params.set('till', period.till);
    }
    if (period.nowRef) params.set('now', String(period.nowRef));
    if (customerCode) params.set('customer', customerCode);
    let data;
    try {
      data = await Util.api('/api/emissions/customers?' + params.toString(), { signal });
    } catch (e) {
      if (Util.isAbortError(e)) return; // user moved on — don't toast
      Util.toast(e.message, 'error');
      return;
    }
    if (signal?.aborted) return; // late return — supervisor moved on
    lastData = data;

    const totalCust = data.customers.length;
    const subtitleScope = customerCode
      ? 'Selected customer'
      : (totalCust > TOP_N ? `Top ${TOP_N} of ${totalCust} customers` : 'All customers');
    document.getElementById('customerSubtitle').textContent =
      `${subtitleScope} · ${data.presetLabel}`;
    document.getElementById('custTotal').textContent = Util.fmtNum(data.totals.total, 0);
    document.getElementById('custAvg').textContent = Util.fmtNum(data.totals.avg, 0);
    document.getElementById('custTop').textContent = data.totals.top || '—';

    renderKpis(data);
    renderChart(data, customerCode);
    const lu = document.getElementById('lastUpdated');
    if (lu) lu.textContent =
      new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function renderKpis({ customers, totals, presetLabel }) {
    const totalEmissions = customers.reduce((a, c) => a + c.totalEmissions, 0);
    const totalShipments = customers.reduce((a, c) => a + c.totalShipments, 0);
    const grid = document.getElementById('kpiGrid');
    const teCompact = Util.compactCO2(totalEmissions);
    grid.innerHTML = `
      <div class="kpi-tile orange">
        <div class="kpi-label">Total Emissions</div>
        <div class="kpi-value">${Util.fmtNum(teCompact.value, 0)}</div>
        <div class="kpi-unit">${teCompact.unit}</div>
        <div class="kpi-delta neutral">${presetLabel}</div>
      </div>
      <div class="kpi-tile navy">
        <div class="kpi-label">Customers</div>
        <div class="kpi-value">${Util.fmtNum(customers.length, 0)}</div>
        <div class="kpi-unit">with shipments</div>
      </div>
      <div class="kpi-tile blue">
        <div class="kpi-label">Total Shipments</div>
        <div class="kpi-value">${Util.fmtNum(totalShipments, 0)}</div>
        <div class="kpi-unit">shipments</div>
      </div>
    `;
  }

  function renderChart({ customers }, customerCode) {
    const canvas = document.getElementById('customerChart');
    const ctx = canvas.getContext('2d');

    // Only chart the biggest contributors — see TOP_N note above. `customers`
    // is already sorted by emissions desc, so a slice gives the top N.
    const shown = customers.slice(0, TOP_N);

    // Wrap long customer names onto two lines so the X-axis stays readable
    // even when there are 12+ bars in view.
    const labels = shown.map(c => wrapLabel(c.customerName, 14));

    // Live mode fallback: when emission fields are missing from the source
    // data (TMS list endpoint currently returns Planned shipments only,
    // which lack carbonEmissionValue), plot shipment counts so the chart
    // isn't visually empty.
    const totalEmissions = shown.reduce((a, c) => a + c.totalEmissions, 0);
    const fallbackToCount = totalEmissions === 0
                         && shown.some(c => c.totalShipments > 0);
    const data = shown.map(c => fallbackToCount ? c.totalShipments : c.totalEmissions);
    const backgrounds = shown.map(c => c.customerCode === customerCode ? '#1a2b5f' : '#f97316');

    const datasetLabel = fallbackToCount ? 'Shipments' : 'Carbon emission (kg CO₂e)';
    const config = {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: datasetLabel,
          data, backgroundColor: backgrounds, borderRadius: 6,
          barPercentage: 0.7, categoryPercentage: 0.7,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 350 },
        onClick: (evt, elements) => {
          if (!elements.length) return;
          const idx = elements[0].index;
          const cust = shown[idx];
          if (cust) Drilldown.open(cust);
        },
        onHover: (evt, els) => { canvas.style.cursor = els.length ? 'pointer' : 'default'; },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#111e45', padding: 12, cornerRadius: 8,
            callbacks: {
              title: (items) => shown[items[0].dataIndex].customerName,
              label: (ctx) => {
                const c = shown[ctx.dataIndex];
                if (fallbackToCount) {
                  return [
                    `  Shipments        ${Util.fmtNum(c.totalShipments, 0)}`,
                    `  Emissions        not yet populated`,
                  ];
                }
                return [
                  `  Total emissions  ${Util.fmtNum(c.totalEmissions, 0)} kg CO₂e`,
                  `  Total shipments  ${Util.fmtNum(c.totalShipments, 0)}`,
                  `  Rail aversion    ${Util.fmtNum(c.totalRail, 0)} kg CO₂e`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: '#666',
              font: { size: 11 },
              maxRotation: 35,
              minRotation: 0,
              autoSkip: false,
            },
          },
          y: { ticks: { color: '#666', callback: v => v >= 1000 ? (v/1000)+'k' : v }, grid: { color: '#eef0f5', drawBorder: false } },
        },
      },
    };

    if (chart) chart.destroy();
    chart = new Chart(ctx, config);
  }

  function wrapLabel(text, maxLen) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const lines = [];
    let cur = '';
    for (const w of words) {
      if (!cur) { cur = w; continue; }
      if ((cur + ' ' + w).length <= maxLen) cur += ' ' + w;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    // Cap at two lines to keep the axis compact; truncate the rest.
    if (lines.length > 2) {
      lines[1] = lines[1] + '…';
      lines.length = 2;
    }
    return lines;
  }

  function getLast() { return lastData; }

  return { load, getLast };
})();
