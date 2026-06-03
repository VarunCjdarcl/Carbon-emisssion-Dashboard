// Period filter — preset list + a Mon-first calendar with range selection.

const Period = (() => {
  const PRESETS = [
    { id: 'today',         label: 'Today',          sub: 'By hour' },
    { id: 'yesterday',     label: 'Yesterday',      sub: 'By hour' },
    { id: 'thisWeek',      label: 'This Week',      sub: 'By day' },
    { id: 'previousWeek',  label: 'Previous Week',  sub: 'By day' },
    { id: 'last7',         label: 'Last 7 Days',    sub: 'By day' },
    { id: 'thisMonth',     label: 'This Month',     sub: 'By week' },
    { id: 'previousMonth', label: 'Previous Month', sub: 'By week' },
    { id: 'last30',        label: 'Last 30 Days',   sub: 'By week' },
    { id: 'last2months',   label: 'Last 2 Months',  sub: 'By week' },
    { id: 'last5months',   label: 'Last 5 Months',  sub: 'By month' },
    { id: 'last1year',     label: 'Last 1 Year',    sub: 'By month' },
    { id: 'custom',        label: 'Custom Range',   sub: 'Pick on calendar' },
  ];

  const state = {
    preset: 'last7',
    from: null,
    till: null,
    hoverTs: null,         // day under the cursor while picking the 2nd endpoint
    visMonth: new Date(),  // calendar visible month
  };

  let calCells = [];       // live references to the 42 day cells for in-place repaint

  let onApplyCb = () => {};

  function init({ onApply }) {
    onApplyCb = onApply || (() => {});
    renderPresets();

    document.getElementById('periodBtn').addEventListener('click', e => {
      e.stopPropagation();
      const dd = document.getElementById('periodDropdown');
      dd.hidden = !dd.hidden;
      if (!dd.hidden) renderCalendar();
    });
    document.getElementById('calPrev').addEventListener('click', () => {
      state.visMonth.setMonth(state.visMonth.getMonth() - 1);
      renderCalendar();
    });
    document.getElementById('calNext').addEventListener('click', () => {
      state.visMonth.setMonth(state.visMonth.getMonth() + 1);
      renderCalendar();
    });
    document.getElementById('applyPeriod').addEventListener('click', applyAndClose);

    document.addEventListener('click', e => {
      const dd = document.getElementById('periodDropdown');
      if (dd.hidden) return;
      if (dd.contains(e.target)) return;
      if (e.target.closest('#periodBtn')) return;
      dd.hidden = true;
    });

    // Default: Last 7 Days (always shows a full week of recent data on open)
    selectPreset('last7', { silent: true });
    syncButtons();
  }

  function renderPresets() {
    const el = document.getElementById('periodPresets');
    el.innerHTML = '';
    for (const p of PRESETS) {
      const div = document.createElement('div');
      div.className = 'preset' + (p.id === state.preset ? ' active' : '');
      div.dataset.id = p.id;
      div.innerHTML = `<div class="preset-label">${p.label}</div><div class="preset-sub">${p.sub}</div>`;
      div.addEventListener('click', () => selectPreset(p.id));
      el.appendChild(div);
    }
    const reset = document.createElement('div');
    reset.className = 'preset';
    reset.innerHTML = `<div class="preset-label">Reset</div><div class="preset-sub">Clear current range</div>`;
    reset.addEventListener('click', () => {
      state.from = null; state.till = null;
      renderCalendar();
      document.getElementById('fromField').value = '';
      document.getElementById('toField').value = '';
    });
    el.appendChild(reset);
  }

  function selectPreset(id, { silent } = {}) {
    state.preset = id;
    document.querySelectorAll('.preset').forEach(p => {
      p.classList.toggle('active', p.dataset.id === id);
    });
    const range = computePresetRange(id);
    if (range) {
      state.from = range.from;
      state.till = range.till;
      state.visMonth = new Date(range.till);
    }
    document.getElementById('groupedBy').textContent = pickGrouping(id);
    document.getElementById('fromField').value = state.from ? Util.fmtDateInput(state.from) : '';
    document.getElementById('toField').value = state.till ? Util.fmtDateInput(state.till) : '';
    renderCalendar();
    if (silent) syncButtons();
  }

  function pickGrouping(id) {
    if (id === 'today' || id === 'yesterday') return 'hour';
    if (['thisWeek','previousWeek','last7'].includes(id)) return 'day';
    if (['thisMonth','previousMonth','last30','last2months'].includes(id)) return 'week';
    if (['last5months','last1year'].includes(id)) return 'month';
    return 'auto';
  }

  function computePresetRange(id) {
    const now = new Date();
    const startOfDay = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
    const endOfDay   = d => { const x = new Date(d); x.setHours(23,59,59,999); return x; };
    const addDays    = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
    const startOfWeek = d => { const x = startOfDay(d); const dow = (x.getDay()+6)%7; x.setDate(x.getDate()-dow); return x; };

    switch (id) {
      case 'today': return { from: startOfDay(now).getTime(), till: endOfDay(now).getTime() };
      case 'yesterday': { const y = addDays(now,-1); return { from: startOfDay(y).getTime(), till: endOfDay(y).getTime() }; }
      case 'thisWeek': return { from: startOfWeek(now).getTime(), till: endOfDay(now).getTime() };
      case 'previousWeek': { const s = startOfWeek(now); return { from: addDays(s,-7).getTime(), till: endOfDay(addDays(s,-1)).getTime() }; }
      case 'last7': return { from: startOfDay(addDays(now,-6)).getTime(), till: endOfDay(now).getTime() };
      case 'thisMonth': return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)).getTime(), till: endOfDay(now).getTime() };
      case 'previousMonth': { const s = new Date(now.getFullYear(), now.getMonth()-1, 1); const e = new Date(now.getFullYear(), now.getMonth(), 0); return { from: startOfDay(s).getTime(), till: endOfDay(e).getTime() }; }
      case 'last30': return { from: startOfDay(addDays(now,-29)).getTime(), till: endOfDay(now).getTime() };
      case 'last2months': return { from: startOfDay(addDays(now,-59)).getTime(), till: endOfDay(now).getTime() };
      case 'last5months': return { from: startOfDay(addDays(now,-149)).getTime(), till: endOfDay(now).getTime() };
      case 'last1year': return { from: startOfDay(addDays(now,-364)).getTime(), till: endOfDay(now).getTime() };
      default: return null;
    }
  }

  function renderCalendar() {
    const grid = document.getElementById('calGrid');
    const title = document.getElementById('calTitle');
    grid.innerHTML = '';
    calCells = [];
    const v = state.visMonth;
    title.textContent = v.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const first = new Date(v.getFullYear(), v.getMonth(), 1);
    const dow = (first.getDay() + 6) % 7;
    const startDate = new Date(first); startDate.setDate(first.getDate() - dow);

    for (let i = 0; i < 42; i++) {
      const d = new Date(startDate); d.setDate(startDate.getDate() + i);
      const cell = document.createElement('div');
      cell.className = 'cal-cell';
      if (d.getMonth() !== v.getMonth()) cell.classList.add('muted');
      cell.textContent = d.getDate();
      const dayMs = new Date(d).setHours(0, 0, 0, 0);
      cell._ts = dayMs;
      cell.addEventListener('click', () => onCalendarClick(dayMs));
      // Live range preview: while the start is picked but the end isn't,
      // hovering a day highlights the tentative range up to the cursor.
      cell.addEventListener('mouseenter', () => {
        if (state.from != null && state.till == null) { state.hoverTs = dayMs; paintRange(); }
      });
      calCells.push(cell);
      grid.appendChild(cell);
    }
    // Drop the preview once the cursor leaves the grid.
    grid.onmouseleave = () => {
      if (state.hoverTs != null) { state.hoverTs = null; paintRange(); }
    };
    paintRange();
  }

  // Repaint range highlight on the existing cells — no DOM rebuild, so the
  // selection tracks the cursor smoothly instead of flickering each click.
  function paintRange() {
    const fromMs = state.from != null ? new Date(state.from).setHours(0, 0, 0, 0) : null;
    // Span end = the committed `till`, else the hovered day (live preview).
    const endMs = state.till != null
      ? new Date(state.till).setHours(0, 0, 0, 0)
      : (state.from != null ? state.hoverTs : null);

    let lo = fromMs, hi = endMs;
    if (lo != null && hi != null && hi < lo) { const t = lo; lo = hi; hi = t; }

    for (const cell of calCells) {
      const ts = cell._ts;
      const isEnd = (fromMs != null && ts === fromMs) || (endMs != null && ts === endMs);
      const inRange = lo != null && hi != null && ts >= lo && ts <= hi && !isEnd;
      cell.classList.toggle('range-end', isEnd);
      cell.classList.toggle('in-range', inRange);
    }
  }

  function onCalendarClick(dayMs) {
    state.preset = 'custom';
    document.querySelectorAll('.preset').forEach(p => {
      p.classList.toggle('active', p.dataset.id === 'custom');
    });
    const fromMs = state.from != null ? new Date(state.from).setHours(0, 0, 0, 0) : null;
    if (state.from == null || state.till != null) {
      // Start a fresh range.
      state.from = dayMs;
      state.till = null;
    } else if (dayMs < fromMs) {
      // Clicked before the start — flip them so the range stays valid.
      state.till = new Date(state.from).setHours(23, 59, 59, 999);
      state.from = dayMs;
    } else {
      state.till = new Date(dayMs).setHours(23, 59, 59, 999);
    }
    state.hoverTs = null;
    document.getElementById('groupedBy').textContent = 'auto';
    document.getElementById('fromField').value = state.from ? Util.fmtDateInput(state.from) : '';
    document.getElementById('toField').value = state.till ? Util.fmtDateInput(state.till) : '';
    paintRange();
  }

  function applyAndClose() {
    if (!state.from || !state.till) {
      Util.toast('Please pick a complete date range.', 'error');
      return;
    }
    const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000; // 1 year, inclusive
    if (state.till - state.from > MAX_RANGE_MS) {
      Util.toast('Date range is limited to a maximum of 1 year.', 'error');
      return;
    }
    document.getElementById('periodDropdown').hidden = true;
    syncButtons();
    onApplyCb(getCurrent());
  }

  function syncButtons() {
    const meta = PRESETS.find(p => p.id === state.preset);
    const label = state.preset === 'custom'
      ? `${Util.fmtDateInput(state.from)} – ${Util.fmtDateInput(state.till)}`
      : (meta ? meta.label : 'Custom Range');
    document.getElementById('periodLabel').textContent = label;
    document.getElementById('activePill').textContent = label;
  }

  function getCurrent() {
    return {
      preset: state.preset,
      from: state.from,
      till: state.till,
    };
  }

  return { init, getCurrent, applyAndClose };
})();
