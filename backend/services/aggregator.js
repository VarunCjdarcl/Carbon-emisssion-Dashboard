// Aggregation utilities for emission data.
// Granularity rules follow the BRD time-period filter table.

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function hourKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
}

function hourLabel(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:00`;
}

function weekIndex(ts, fromTs) {
  const from = new Date(fromTs); from.setHours(0, 0, 0, 0);
  const cur = new Date(ts); cur.setHours(0, 0, 0, 0);
  return Math.floor((cur.getTime() - from.getTime()) / 86400000 / 7) + 1;
}

function weekKey(ts, fromTs) {
  return `W${pad(weekIndex(ts, fromTs))}`;
}

function weekLabel(ts, fromTs) {
  return `Week ${weekIndex(ts, fromTs)}`;
}

function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function monthLabel(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

function quarterKey(ts) {
  const d = new Date(ts);
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}

function quarterLabel(ts) {
  const d = new Date(ts);
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `Q${q} ${d.getFullYear()}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

const GRANULARITY = {
  hour:    { key: (ts) => hourKey(ts),         label: (ts) => hourLabel(ts),         name: 'hour' },
  day:     { key: (ts) => dayKey(ts),          label: (ts) => dayLabel(ts),          name: 'day' },
  week:    { key: (ts, from) => weekKey(ts, from), label: (ts, from) => weekLabel(ts, from), name: 'week' },
  month:   { key: (ts) => monthKey(ts),        label: (ts) => monthLabel(ts),        name: 'month' },
  quarter: { key: (ts) => quarterKey(ts),      label: (ts) => quarterLabel(ts),      name: 'quarter' },
};

function pickGranularity(preset, from, till) {
  switch (preset) {
    case 'today':
    case 'yesterday':
      return 'hour';
    case 'thisWeek':
    case 'previousWeek':
    case 'last7':
      return 'day';
    case 'thisMonth':
    case 'previousMonth':
    case 'last30':
    case 'last2months':
      return 'week';
    case 'last5months':
    case 'last1year':
      return 'month';
    default: {
      // Custom range — auto-pick from window length
      const days = Math.max(1, Math.round((till - from) / 86400000));
      if (days <= 2) return 'hour';
      if (days <= 14) return 'day';
      if (days <= 90) return 'week';
      if (days <= 540) return 'month';
      return 'quarter';
    }
  }
}

function aggregateByTime(shipments, { from, till, preset }) {
  const granularity = pickGranularity(preset, from, till);
  const g = GRANULARITY[granularity];
  const buckets = new Map(); // key -> {label, sortTs, road, rail, count}

  let totalRoad = 0, totalRail = 0, totalCount = shipments.length;
  for (const s of shipments) {
    const key = g.key(s.completionTime, from);
    const label = g.label(s.completionTime, from);
    if (!buckets.has(key)) {
      buckets.set(key, { key, label, sortTs: s.completionTime, road: 0, rail: 0, count: 0 });
    }
    const b = buckets.get(key);
    b.count++;
    if (typeof s.carbonEmissionValue === 'number') {
      b.road += s.carbonEmissionValue;
      totalRoad += s.carbonEmissionValue;
    }
    if (typeof s.aversionValue_rail === 'number') {
      b.rail += s.aversionValue_rail;
      totalRail += s.aversionValue_rail;
    }
    b.sortTs = Math.min(b.sortTs, s.completionTime);
  }

  // Fill empty buckets so the chart shows continuous time, not gaps.
  fillEmptyBuckets(buckets, from, till, granularity);

  const series = Array.from(buckets.values()).sort((a, b) => a.sortTs - b.sortTs);

  return {
    granularity,
    series: series.map(b => ({
      label: b.label,
      road: round2(b.road),
      rail: round2(b.rail),
      count: b.count,
    })),
    totals: {
      totalRoadEmissions: round2(totalRoad),
      totalRailComparison: round2(totalRail),
      totalShipments: totalCount,
      avgEmissionPerShipment: totalCount ? round2(totalRoad / totalCount) : 0,
    },
  };
}

function fillEmptyBuckets(buckets, from, till, granularity) {
  const g = GRANULARITY[granularity];
  let cur = new Date(from);
  cur.setMilliseconds(0);
  if (granularity === 'hour') cur.setMinutes(0, 0, 0);
  else cur.setHours(0, 0, 0, 0);

  const end = new Date(till);
  while (cur.getTime() <= end.getTime()) {
    const ts = cur.getTime();
    const key = g.key(ts, from);
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        label: g.label(ts, from),
        sortTs: ts,
        road: 0, rail: 0, count: 0,
      });
    }
    if (granularity === 'hour') cur.setHours(cur.getHours() + 1);
    else if (granularity === 'day') cur.setDate(cur.getDate() + 1);
    else if (granularity === 'week') cur.setDate(cur.getDate() + 7);
    else if (granularity === 'month') cur.setMonth(cur.getMonth() + 1);
    else if (granularity === 'quarter') cur.setMonth(cur.getMonth() + 3);
  }
}

function aggregateByCustomer(shipments, { customerCode } = {}) {
  const map = new Map();
  for (const s of shipments) {
    if (customerCode && s.customerCode !== customerCode) continue;
    const code = s.customerCode || 'UNK';
    if (!map.has(code)) {
      map.set(code, {
        customerCode: code,
        customerName: s.customerName || code,
        customerEmail: s.customerEmail || '',
        totalEmissions: 0,
        totalRail: 0,
        totalShipments: 0,
      });
    }
    const c = map.get(code);
    c.totalShipments++;
    if (typeof s.carbonEmissionValue === 'number') c.totalEmissions += s.carbonEmissionValue;
    if (typeof s.aversionValue_rail === 'number') c.totalRail += s.aversionValue_rail;
  }
  const list = Array.from(map.values())
    .map(c => ({
      ...c,
      totalEmissions: round2(c.totalEmissions),
      totalRail: round2(c.totalRail),
    }))
    .sort((a, b) => b.totalEmissions - a.totalEmissions);

  const sumEmissions = list.reduce((a, b) => a + b.totalEmissions, 0);
  const avg = list.length ? sumEmissions / list.length : 0;

  return {
    customers: list,
    totals: {
      total: round2(sumEmissions),
      avg: round2(avg),
      top: list[0]?.customerName || null,
    },
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  aggregateByTime,
  aggregateByCustomer,
  pickGranularity,
  GRANULARITY,
  fillEmptyBuckets,
  round2,
};
