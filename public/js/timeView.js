// Carbon Emission vs Time view — KPI tiles + grouped Road/Rail bar chart.

const TimeView = (() => {
  let chart = null;

  async function load(period, { signal } = {}) {
    const params = new URLSearchParams();
    params.set('preset', period.preset || 'thisMonth');
    if (period.preset === 'custom' && period.from && period.till) {
      params.set('from', period.from); params.set('till', period.till);
    }
    let data;
    try {
      data = await Util.api('/api/emissions/time?' + params.toString(), { signal });
    } catch (e) {
      if (Util.isAbortError(e)) return; // user moved on — don't toast
      Util.toast(e.message, 'error');
      return;
    }
    if (signal?.aborted) return; // late return — supervisor moved on
    renderKpis(data);
    renderChart(data);
    renderTotalEmission(data);

    const fallback = data.totals.totalRoadEmissions === 0
                  && data.totals.totalRailComparison === 0
                  && data.totals.totalShipments > 0;
    document.getElementById('chartTitle').textContent = fallback
      ? 'Shipments by Sub-period'
      : 'Emissions by Sub-period';
    document.getElementById('chartSubtitle').textContent = fallback
      ? `Live shipments · ${data.presetLabel} · emission fields not yet populated`
      : `Grouped by ${data.granularity} · ${data.presetLabel}`;
    const lu = document.getElementById('lastUpdated');
    if (lu) lu.textContent =
      new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function renderKpis({ totals, presetLabel }) {
    const grid = document.getElementById('kpiGrid');
    const road = Util.compactCO2(totals.totalRoadEmissions);
    const rail = Util.compactCO2(totals.totalRailComparison);
    const avg = Util.compactCO2(totals.avgEmissionPerShipment);
    grid.innerHTML = `
      <div class="kpi-tile blue">
        <div class="kpi-label">Total Road Emissions</div>
        <div class="kpi-value">${Util.fmtNum(road.value, 0)}</div>
        <div class="kpi-unit">${road.unit}</div>
        <div class="kpi-delta neutral">${presetLabel}</div>
      </div>
      <div class="kpi-tile green">
        <div class="kpi-label">Rail Aversion</div>
        <div class="kpi-value">${Util.fmtNum(rail.value, 0)}</div>
        <div class="kpi-unit">${rail.unit}</div>
        <div class="kpi-delta neutral">${presetLabel}</div>
      </div>
      <div class="kpi-tile navy">
        <div class="kpi-label">Total Shipments</div>
        <div class="kpi-value">${Util.fmtNum(totals.totalShipments, 0)}</div>
        <div class="kpi-unit">shipments</div>
        <div class="kpi-delta neutral">${presetLabel}</div>
      </div>
      <div class="kpi-tile orange">
        <div class="kpi-label">Avg Emission / Shipment</div>
        <div class="kpi-value">${Util.fmtNum(avg.value, 2)}</div>
        <div class="kpi-unit">${avg.unit} / shipment</div>
        <div class="kpi-delta neutral">${presetLabel}</div>
      </div>
    `;
  }

  function pctText(part, whole, suffix) {
    if (!whole) return `— ${suffix}`;
    const pct = Math.round((part / whole) * 100);
    return `↓ ${pct}% ${suffix}`;
  }

  function renderChart({ series, totals }) {
    const canvas = document.getElementById('timeChart');
    const ctx = canvas.getContext('2d');
    const labels = series.map(s => s.label);
    const road = series.map(s => s.road);
    const rail = series.map(s => s.rail);
    const counts = series.map(s => s.count);

    // Live TMS shipments returned by the list endpoint don't yet carry
    // carbonEmissionValue / aversionValue_rail (those fields are populated
    // only on Completed shipments). When that's the case, fall back to
    // plotting shipment counts so the chart isn't visually empty.
    const fallbackToCount = totals.totalRoadEmissions === 0
                          && totals.totalRailComparison === 0
                          && totals.totalShipments > 0;

    const datasets = fallbackToCount
      ? [{ label: 'Shipments', data: counts, backgroundColor: '#1a2b5f', borderRadius: 6, barPercentage: 0.7, categoryPercentage: 0.7 }]
      : [
          { label: 'Road emissions', data: road, backgroundColor: '#0ea5e9', borderRadius: 6, barPercentage: 0.7, categoryPercentage: 0.7 },
          { label: 'Rail aversion',  data: rail, backgroundColor: '#10b981', borderRadius: 6, barPercentage: 0.7, categoryPercentage: 0.7 },
        ];

    // Show / hide the legend dots and update axis title to match
    const yLabel = fallbackToCount ? '# shipments' : 'kg CO₂e';
    document.querySelector('.legend').style.display = fallbackToCount ? 'none' : 'flex';
    document.getElementById('chartSubtitle').dataset.fallback = String(fallbackToCount);

    const config = {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 350 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#111e45',
            padding: 12, displayColors: true, cornerRadius: 8,
            callbacks: {
              title: (items) => items[0].label,
              label: (ctx) => {
                const idx = ctx.dataIndex;
                if (fallbackToCount) return `  Shipments        ${Util.fmtNum(counts[idx], 0)}`;
                if (ctx.datasetIndex === 0) return `  Road emissions   ${Util.fmtNum(road[idx], 0)} kg CO₂e`;
                if (ctx.datasetIndex === 1) return `  Rail aversion  ${Util.fmtNum(rail[idx], 0)} kg CO₂e`;
                return '';
              },
              afterBody: (items) => fallbackToCount ? '' : `  Shipments        ${Util.fmtNum(counts[items[0].dataIndex], 0)}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#666' } },
          y: { ticks: { color: '#666', callback: v => v >= 1000 ? (v/1000)+'k' : v },
               grid: { color: '#eef0f5', drawBorder: false } },
        },
      },
    };

    if (chart) { chart.destroy(); }
    chart = new Chart(ctx, config);
  }

  function renderTotalEmission({ totals, presetLabel }) {
    const compact = Util.compactCO2(totals.totalRoadEmissions);
    document.getElementById('totalEmissionValue').textContent = Util.fmtNum(compact.value, 0);
    document.querySelector('#totalEmissionPanel span').textContent = compact.unit;
    document.getElementById('totalEmissionSub').textContent =
      `Sum of all road shipments · ${presetLabel}`;
  }

  return { load };
})();
