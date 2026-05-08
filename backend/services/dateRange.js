// Resolves a "preset" string + optional custom from/till into absolute timestamps.

function startOfDay(d) { d = new Date(d); d.setHours(0, 0, 0, 0); return d; }
function endOfDay(d)   { d = new Date(d); d.setHours(23, 59, 59, 999); return d; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function startOfWeekMonday(d) {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - dow);
  return x;
}

function resolvePreset(preset, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  let from, till;
  switch (preset) {
    case 'today':
      from = startOfDay(now); till = endOfDay(now); break;
    case 'yesterday': {
      const y = addDays(now, -1);
      from = startOfDay(y); till = endOfDay(y); break;
    }
    case 'thisWeek':
      from = startOfWeekMonday(now); till = endOfDay(now); break;
    case 'previousWeek': {
      const startThis = startOfWeekMonday(now);
      from = addDays(startThis, -7);
      till = endOfDay(addDays(startThis, -1));
      break;
    }
    case 'last7':
      from = startOfDay(addDays(now, -6)); till = endOfDay(now); break;
    case 'thisMonth': {
      const x = new Date(now.getFullYear(), now.getMonth(), 1);
      from = startOfDay(x); till = endOfDay(now); break;
    }
    case 'previousMonth': {
      const x = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      from = startOfDay(x); till = endOfDay(e); break;
    }
    case 'last30':
      from = startOfDay(addDays(now, -29)); till = endOfDay(now); break;
    case 'last2months':
      from = startOfDay(addDays(now, -59)); till = endOfDay(now); break;
    case 'last5months':
      from = startOfDay(addDays(now, -149)); till = endOfDay(now); break;
    case 'last1year':
      from = startOfDay(addDays(now, -364)); till = endOfDay(now); break;
    case 'last2years':
      from = startOfDay(addDays(now, -729)); till = endOfDay(now); break;
    case 'custom':
    default: {
      if (!opts.from || !opts.till) {
        // Default to last 30 days if custom but no dates supplied
        from = startOfDay(addDays(now, -29)); till = endOfDay(now);
      } else {
        from = startOfDay(new Date(Number(opts.from)));
        till = endOfDay(new Date(Number(opts.till)));
      }
      break;
    }
  }
  return { from: from.getTime(), till: till.getTime() };
}

function presetLabel(preset) {
  const map = {
    today: 'Today',
    yesterday: 'Yesterday',
    thisWeek: 'This Week',
    previousWeek: 'Previous Week',
    last7: 'Last 7 Days',
    thisMonth: 'This Month',
    previousMonth: 'Previous Month',
    last30: 'Last 30 Days',
    last2months: 'Last 2 Months',
    last5months: 'Last 5 Months',
    last1year: 'Last 1 Year',
    last2years: 'Last 2 Years',
    custom: 'Custom Range',
  };
  return map[preset] || preset;
}

module.exports = { resolvePreset, presetLabel };
