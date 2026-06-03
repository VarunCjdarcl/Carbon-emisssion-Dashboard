// Tiny shared helpers used across the dashboard scripts.

const Util = (() => {
  function fmtNum(n, dp = 0) {
    if (n === null || n === undefined || isNaN(n)) return '0';
    return Number(n).toLocaleString('en-IN', {
      minimumFractionDigits: dp, maximumFractionDigits: dp,
    });
  }

  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  }

  function fmtDateInput(ts) {
    return new Date(ts).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let msg = `Request failed: ${res.status}`;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    return res.json();
  }

  // True when the error came from an AbortController.abort() call.
  // Lets callers silently ignore cancellations instead of toasting them.
  function isAbortError(e) {
    return e && (e.name === 'AbortError' || e.code === 20 || e.code === 'ABORT_ERR');
  }

  function toast(message, kind = '') {
    const el = document.getElementById('toast');
    el.className = 'toast ' + kind;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 4200);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // Emission values are always shown in kilograms of CO₂-equivalent.
  function compactCO2(kg) {
    return { value: kg, unit: 'kg CO₂e' };
  }

  return { fmtNum, fmtDate, fmtDateInput, api, toast, debounce, escapeHtml, compactCO2, isAbortError };
})();
