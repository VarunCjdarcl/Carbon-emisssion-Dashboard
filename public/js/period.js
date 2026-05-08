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
    { id: 'last2years',    label: 'Last 2 Years',   sub: 'By quarter' },
    { id: 'custom',        label: 'Custom Range',   sub: 'Pick on calendar' },
  ];

  const state = {
    preset: 'thisMonth',
    from: null,
    till: null,
    visMonth: new Date(),  // calendar visible month
  };

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

    // Default: This Month
    selectPreset('thisMonth', { silent: true });
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
    if (id === 'last2years') return 'quarter';
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
      case 'last2years': return { from: startOfDay(addDays(now,-729)).getTime(), till: endOfDay(now).getTime() };
      default: return null;
    }
  }

  function renderCalendar() {
    const grid = document.getElementById('calGrid');
    const title = document.getElementById('calTitle');
    grid.innerHTML = '';
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
      const dayMs = d.setHours(0,0,0,0);
      if (state.from && state.till) {
        const fromMs = new Date(state.from).setHours(0,0,0,0);
        const tillMs = new Date(state.till).setHours(0,0,0,0);
        if (dayMs >= fromMs && dayMs <= tillMs) cell.classList.add('in-range');
        if (dayMs === fromMs || dayMs === tillMs) cell.classList.add('range-end');
      }
      cell.addEventListener('click', () => onCalendarClick(d));
      grid.appendChild(cell);
    }
  }

  function onCalendarClick(d) {
    state.preset = 'custom';
    document.querySelectorAll('.preset').forEach(p => {
      p.classList.toggle('active', p.dataset.id === 'custom');
    });
    if (!state.from || (state.from && state.till)) {
      state.from = new Date(d).setHours(0,0,0,0);
      state.till = null;
    } else if (d.getTime() < state.from) {
      state.till = state.from;
      state.from = new Date(d).setHours(0,0,0,0);
    } else {
      state.till = new Date(d).setHours(23,59,59,999);
    }
    document.getElementById('groupedBy').textContent = 'auto';
    document.getElementById('fromField').value = state.from ? Util.fmtDateInput(state.from) : '';
    document.getElementById('toField').value = state.till ? Util.fmtDateInput(state.till) : '';
    renderCalendar();
  }

  function applyAndClose() {
    if (!state.from || !state.till) {
      Util.toast('Please pick a complete date range.', 'error');
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
