// Carbon Emission vs Customer view — orange bar chart with drill-down on click.

const CustomerView = (() => {
  let chart = null;
  let lastData = null;

  async function load(period, customerCode) {
    const params = new URLSearchParams();
    params.set('preset', period.preset || 'thisMonth');
    if (period.preset === 'custom' && period.from && period.till) {
      params.set('from', period.from); params.set('till', period.till);
    }
    if (customerCode) params.set('customer', customerCode);
    let data;
    try {
      data = await Util.api('/api/emissions/customers?' + params.toString());
    } catch (e) {
      Util.toast(e.message, 'error');
      return;
    }
    lastData = data;

    document.getElementById('customerSubtitle').textContent =
      (customerCode ? `Selected customer · ${data.presetLabel}` : `All customers · ${data.presetLabel}`);
    document.getElementById('custTotal').textContent = Util.fmtNum(data.totals.total, 0);
    document.getElementById('custAvg').textContent = Util.fmtNum(data.totals.avg, 0);
    document.getElementById('custTop').textContent = data.totals.top || '—';

    renderKpis(data);
    renderChart(data, customerCode);
    document.getElementById('lastUpdated').textContent =
      new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function renderKpis({ customers, totals, presetLabel }) {
    const totalEmissions = customers.reduce((a, c) => a + c.totalEmissions, 0);
    const totalRail = customers.reduce((a, c) => a + c.totalRail, 0);
    const totalShipments = customers.reduce((a, c) => a + c.totalShipments, 0);
    const grid = document.getElementById('kpiGrid');
    const teCompact = Util.compactCO2(totalEmissions);
    const trCompact = Util.compactCO2(totalRail);
    grid.innerHTML = `
      <div class="kpi-tile orange">
        <div class="kpi-label">Total Emissions</div>
        <div class="kpi-value">${Util.fmtNum(teCompact.value, teCompact.unit === 'tonnes CO₂' ? 2 : 0)}</div>
        <div class="kpi-unit">${teCompact.unit}</div>
        <div class="kpi-delta neutral">${presetLabel}</div>
      </div>
      <div class="kpi-tile green">
        <div class="kpi-label">Rail Aversion</div>
        <div class="kpi-value">${Util.fmtNum(trCompact.value, trCompact.unit === 'tonnes CO₂' ? 2 : 0)}</div>
        <div class="kpi-unit">${trCompact.unit}</div>
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

    // Wrap long customer names onto two lines so the X-axis stays readable
    // even when there are 12+ bars in view.
    const labels = customers.map(c => wrapLabel(c.customerName, 14));

    // Live mode fallback: when emission fields are missing from the source
    // data (TMS list endpoint currently returns Planned shipments only,
    // which lack carbonEmissionValue), plot shipment counts so the chart
    // isn't visually empty.
    const totalEmissions = customers.reduce((a, c) => a + c.totalEmissions, 0);
    const fallbackToCount = totalEmissions === 0
                         && customers.some(c => c.totalShipments > 0);
    const data = customers.map(c => fallbackToCount ? c.totalShipments : c.totalEmissions);
    const backgrounds = customers.map(c => c.customerCode === customerCode ? '#1a2b5f' : '#f97316');

    const datasetLabel = fallbackToCount ? 'Shipments' : 'Carbon emission (kg CO₂)';
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
          const cust = customers[idx];
          if (cust) Drilldown.open(cust);
        },
        onHover: (evt, els) => { canvas.style.cursor = els.length ? 'pointer' : 'default'; },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#111e45', padding: 12, cornerRadius: 8,
            callbacks: {
              title: (items) => customers[items[0].dataIndex].customerName,
              label: (ctx) => {
                const c = customers[ctx.dataIndex];
                if (fallbackToCount) {
                  return [
                    `  Shipments        ${Util.fmtNum(c.totalShipments, 0)}`,
                    `  Emissions        not yet populated`,
                  ];
                }
                return [
                  `  Total emissions  ${Util.fmtNum(c.totalEmissions, 0)} kg CO₂`,
                  `  Total shipments  ${Util.fmtNum(c.totalShipments, 0)}`,
                  `  Rail aversion    ${Util.fmtNum(c.totalRail, 0)} kg CO₂`,
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
