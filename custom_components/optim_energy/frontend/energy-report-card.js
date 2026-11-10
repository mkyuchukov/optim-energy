// Live energy report card for Home Assistant. No dependencies; reads recorder statistics.
const DEFAULTS = {
  tariff: 'input_number.client_tariff',
  // Meters and selections come from Home Assistant, through window.portalModel in building-cards.js.
  meters: {},
  views: [],
};

// Charts only an electrician needs. Clients do not see them, here or under Customise.
const TECH_BLOCKS = new Set(['phases', 'duration', 'voltage', 'frequency', 'powerFactor', 'temperature', 'linkQuality']);
const BLOCKS = [
  ['kpis', 'Headline figures'], ['power', 'Power over time'], ['split', 'When energy is used'], ['energy', 'Energy and cost by day'],
  ['cumulative', 'Usage so far vs last period'], ['profile', 'Average daily profile'], ['heat', 'Usage by hour and day'], ['weekday', 'Usage pattern'],
  ['phases', 'Phases'], ['duration', 'Load duration'], ['voltage', 'Voltage'], ['frequency', 'Frequency'], ['powerFactor', 'Power factor'], ['temperature', 'Device temperature'], ['linkQuality', 'Link quality'], ['breakdown', 'Usage by device'], ['savings', 'Potential savings (estimate)'],
];
const EXTRA_CHARTS = [['powerFactor', 'Power factor', '%', { y0: 0, y1: 100 }], ['temperature', 'Device temperature', '°C', {}], ['linkQuality', 'Link quality', 'LQI', { y0: 0, y1: 255 }]];
const PERIODS = [['h1', 'Last hour', 1], ['h6', 'Last 6 hours', 6], ['h24', 'Last 24 hours', 24], ['d7', 'Last 7 days', 168], ['d30', 'Last 30 days', 720]];
// The period in words, for labels: "today", "last 24 hours", "last 3 days".
const periodName = (p) => ({ today: 'today', month: 'this month', lastmonth: 'last month', range: 'chosen dates' }[p.key] || (p.key === 'last' ? `last ${p.n} ${Number(p.n) === 1 ? p.unit.replace(/s$/, '') : p.unit}` : (PERIODS.find(([k]) => k === p.key)?.[1] || '').toLowerCase()));
const HOUR = 3600000;

// Adds hourly rows of several meters together.
const peakOf = (r) => (r.combined ? r.mean : r.max);
function combine(lists) {
  if (lists.length === 1) return lists[0] || [];
  const out = new Map();
  for (const rows of lists) for (const r of rows || []) {
    const k = +new Date(r.start), o = out.get(k) || { start: k, change: 0, mean: 0, min: 0, max: 0, combined: true };
    o.change += r.change || 0; o.mean += r.mean || 0; o.min += r.min || 0; o.max += r.max || 0;
    out.set(k, o);
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

function statsFor(meters, s) {
  return {
    energy: combine(meters.map((m) => s[m.energy] || [])),
    power: combine(meters.map((m) => s[m.power] || [])),
    frequency: meters.flatMap((m) => s[m.frequency] || []),
    ...Object.fromEntries(EXTRA_CHARTS.map(([k]) => [k, meters.flatMap((m) => s[m[k]] || [])])),
    voltages: meters.flatMap((m) => m.voltages.map((id) => s[id] || [])),
    // Phase split only means something for one three-phase meter.
    phases: meters.length === 1 && meters[0].phases ? Object.fromEntries(Object.entries(meters[0].phases).map(([k, id]) => [k, s[id] || []])) : {},
  };
}

function localParts(ms, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, weekend: p.weekday === 'Sat' || p.weekday === 'Sun' };
}

// Pure so it can be tested: stats = { energy, power, phases: {A,B,C}, voltages: [[]], frequency } of recorder rows.
function analyse(stats, tariff, tz, opts = {}) {
  const priceAt = typeof tariff === 'function' ? tariff : () => tariff;
  const stuck = opts.stuck || new Set(), isStuck = (t) => stuck.has(t);
  const isComplete = (h) => opts.start == null || (h.t >= opts.start && h.t + HOUR <= opts.end);
  const realPeaks = (stats.power || []).filter((r) => r.max != null && !isStuck(+new Date(r.start))).map((r) => r.max), realPeak = realPeaks.length ? Math.max(...realPeaks) : null;
  const maxByStart = new Map((stats.power || []).map((r) => [+new Date(r.start), r.max]));
  const hours = [];
  let caughtUpKwh = 0, caughtUpHours = 0, emptyHours = 0;
  const caught = new Map(), meanByStart = new Map((stats.power || []).map((r) => [+new Date(r.start), r.mean]));
  for (const r of stats.energy || []) {
    const t = +new Date(r.start), kwh = r.change || 0, maxW = maxByStart.get(t);
    // A meter catching up after an outage reports days of energy in one hour. Well above its recorded peak is not real use.
    // The margin allows for meters that report rarely and miss short spikes.
    // Stuck power says nothing about that hour, so its ceiling comes from the period's real peak.
    const limitW = isStuck(t) ? realPeak : maxW, ceiling = opts.trusted ? Infinity : limitW == null ? 5 : (limitW / 1000) * 2 + 0.1;
    if (kwh > ceiling || kwh < 0) { caughtUpKwh += Math.max(kwh, 0); caughtUpHours++; caught.set(t, kwh); continue; }
    if (kwh === 0) { emptyHours++; continue; }
    hours.push({ t, kwh, eur: kwh * priceAt(t), mean: isStuck(t) ? undefined : meanByStart.get(t), max: isStuck(t) ? undefined : maxW, ...localParts(t, tz) });
  }
  const valid = new Set(hours.map((h) => h.t));
  const total = hours.reduce((s, h) => s + h.kwh, 0);
  const dayMap = new Map(), dayEur = new Map();
  for (const h of hours) { dayMap.set(h.day, (dayMap.get(h.day) || 0) + h.kwh); dayEur.set(h.day, (dayEur.get(h.day) || 0) + h.eur); }
  const days = [...dayMap].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, kwh]) => ({ day, kwh, eur: dayEur.get(day) }));
  const cost = hours.reduce((t, h) => t + h.eur, 0), price = total > 0 ? cost / total : priceAt(Date.now());

  const split = { work: 0, after: 0, weekend: 0 }, splitEur = { work: 0, after: 0, weekend: 0 };
  const afterHours = [], weekendHours = [];
  for (const h of hours) {
    const k = h.weekend ? 'weekend' : h.hour >= 8 && h.hour < 19 ? 'work' : 'after';
    split[k] += h.kwh; splitEur[k] += h.eur;
    if (k === 'weekend') weekendHours.push(h); else if (k === 'after') afterHours.push(h);
  }
  const mean = (a) => (a.length ? a.reduce((s, h) => s + h.kwh, 0) / a.length : 0);
  // Always-on load: weekend average, or the quietest fifth of hours when the period has little weekend data.
  // Part-hours at the edges of a period would look like quiet hours, so only whole hours count.
  const sorted = hours.filter(isComplete).sort((a, b) => a.kwh - b.kwh), fullWeekend = weekendHours.filter(isComplete);
  const baseKw = fullWeekend.length >= 12 ? mean(fullWeekend) : mean(sorted.slice(0, Math.max(1, Math.floor(sorted.length / 5))));
  const scale = hours.length ? 8760 / hours.length : 0;
  const five = (x) => Math.round(x / 5) * 5;
  const halveKwh = baseKw * 8760 * 0.5;
  const extraKwh = Math.max(0, split.after - baseKw * afterHours.length) * scale;
  const savings = [
    { action: 'Halve the always-on load', kwh: five(halveKwh), eur: five(halveKwh * price) },
    { action: 'Switch off extra after-hours load', kwh: five(extraKwh), eur: five(extraKwh * price) },
  ];
  const saveEur = savings[0].eur + savings[1].eur;
  const yearEur = five(total * scale * price);

  const phases = Object.entries(stats.phases || {}).map(([name, rows]) => ({ name, kwh: rows.filter((r) => valid.has(+new Date(r.start))).reduce((s, r) => s + (r.change || 0), 0) }));
  const phaseDays = new Map();
  for (const [name, rows] of Object.entries(stats.phases || {})) for (const r of rows) {
    const t = +new Date(r.start);
    if (!valid.has(t)) continue;
    const day = localParts(t, tz).day, row = phaseDays.get(day) || { day };
    row[name] = (row[name] || 0) + (r.change || 0);
    phaseDays.set(day, row);
  }
  const phaseTotal = phases.reduce((s, p) => s + p.kwh, 0);
  phases.forEach((p) => { p.share = phaseTotal ? Math.round((p.kwh / phaseTotal) * 100) : 0; });

  // During an outage statistics repeat the last known value, so only hours with real readings count.
  const pw = (stats.power || []).filter((r) => r.max != null && valid.has(+new Date(r.start)) && !isStuck(+new Date(r.start)));
  // Devices peak at different moments, so a total's peak is its highest combined average, not its highest readings added up.
  const peakRow = pw.reduce((b, r) => (b && peakOf(b) >= peakOf(r) ? b : r), null);
  const range = (rows) => {
    const a = rows.filter((r) => r.min != null);
    return a.length ? { min: Math.min(...a.map((r) => r.min)), max: Math.max(...a.map((r) => r.max)) } : null;
  };
  return {
    hours, days, total, cost, price, split, splitEur, baseW: opts.start != null && sorted.length < 12 ? null : Math.round(baseKw * 1000), savings, saveEur, yearEur,
    saveShare: yearEur ? Math.round((saveEur / yearEur) * 100) : 0,
    phases, phaseDays: [...phaseDays.values()].sort((x, y) => (x.day < y.day ? -1 : 1)),
    peak: peakRow && { w: Math.round(peakOf(peakRow)), t: +new Date(peakRow.start), average: !!peakRow.combined },
    meanW: pw.length ? Math.round(pw.reduce((s, r) => s + (r.mean || 0), 0) / pw.length) : null,
    voltage: range((stats.voltages || []).flat()),
    frequency: range(stats.frequency || []),
    covered: hours.length, caughtUpHours, caughtUpKwh, emptyHours, caught, valid,
  };
}

// A local wall-clock time in the Home Assistant time zone.
function zonedTime(y, m, d, tz, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m, d, hh, mm);
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(guess)).forEach((x) => { p[x.type] = +x.value; });
  return new Date(guess - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess));
}
function localInput(ms, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function parseInput(v, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
  return m ? zonedTime(+m[1], +m[2] - 1, +m[3], tz, +m[4], +m[5]) : null;
}
// Everything except last month and a fixed date range runs up to now, so it stays live.
function periodRange(p, nowMs, tz) {
  const preset = PERIODS.find(([k]) => k === p.key);
  if (preset) return { start: new Date(nowMs - preset[2] * HOUR), end: new Date(nowMs), live: true };
  const [y, m, d] = localParts(nowMs, tz).day.split('-').map(Number);
  if (p.key === 'today') return { start: zonedTime(y, m - 1, d, tz), end: new Date(nowMs), live: true };
  if (p.key === 'month') return { start: zonedTime(y, m - 1, 1, tz), end: new Date(nowMs), live: true };
  if (p.key === 'lastmonth') return { start: zonedTime(y, m - 2, 1, tz), end: zonedTime(y, m - 1, 1, tz), live: false };
  if (p.key === 'last') {
    const n = Number(p.n), unit = { minutes: HOUR / 60, hours: HOUR, days: 24 * HOUR }[p.unit];
    return n > 0 && unit ? { start: new Date(nowMs - n * unit), end: new Date(nowMs), live: true } : { start: new Date(0), end: new Date(0), live: false };
  }
  const a = parseInput(p.from, tz), b = parseInput(p.to, tz);
  return a && b && +b > +a ? { start: a, end: new Date(Math.min(+b, nowMs)), live: +b >= nowMs } : { start: new Date(0), end: new Date(0), live: false };
}
// How finely the charts split a period: minutes, then hours, then days.
function chartStep(span) {
  return span <= 2 * HOUR ? 60000 : span <= 48 * HOUR ? HOUR : 24 * HOUR;
}
function readingPts(hist) {
  return (hist || []).map((r) => ({ t: (r.lu ?? r.lc) * 1000, v: parseFloat(r.s) })).sort((a, b) => a.t - b.t);
}
// Raw readings to one row per minute. A minute with no reading stays empty: nothing is calculated to fill it.
// holdMs is only for slow values like voltage, because Home Assistant stores nothing when a value repeats.
function minuteRows(hist, startMs, endMs, holdMs = 0) {
  const pts = readingPts(hist), out = [];
  let i = 0, last = null;
  for (let k = startMs - (startMs % 60000); k < endMs; k += 60000) {
    const vals = [];
    for (; i < pts.length && pts[i].t < k + 60000; i++) {
      last = Number.isFinite(pts[i].v) ? pts[i] : null;
      if (last && pts[i].t >= k) vals.push(last.v);
    }
    if (!vals.length && last && k - last.t <= holdMs) vals.push(last.v);
    if (vals.length) out.push({ start: k, mean: vals.reduce((a, v) => a + v, 0) / vals.length, min: Math.min(...vals), max: Math.max(...vals) });
  }
  return out;
}
// Statistics repeat the last value while a sensor is silent, so an hour whose power never moved had no real reading.
function stuckHours(rows, lastUpdate, nowMs) {
  const out = new Set();
  for (const r of rows) {
    const t = +new Date(r.start);
    if (t + HOUR > nowMs ? lastUpdate < t : r.min != null && r.min === r.max) out.add(t);
  }
  return out;
}
// Voltage and frequency across meters: the average at each moment, over the meters that have a reading.
function averageRows(lists) {
  const lists2 = lists.filter((l) => l && l.length);
  if (lists2.length === 1) return lists2[0];
  const out = new Map();
  for (const rows of lists2) for (const r of rows) {
    if (r.mean == null) continue;
    const k = +new Date(r.start), o = out.get(k) || { start: k, sum: 0, n: 0, min: Infinity, max: -Infinity };
    o.sum += r.mean; o.n++;
    if (r.min != null) o.min = Math.min(o.min, r.min);
    if (r.max != null) o.max = Math.max(o.max, r.max);
    out.set(k, o);
  }
  return [...out.values()].sort((a, b) => a.start - b.start).map((o) => ({ start: o.start, mean: o.sum / o.n, min: o.min === Infinity ? null : o.min, max: o.max === -Infinity ? null : o.max }));
}
// The meters' own readings added up: at each reading, what every meter has counted so far.
function sumMeterPts(lists) {
  const events = lists.flatMap((pts, i) => pts.map((p) => ({ t: p.t, i, v: p.v - pts[0].v }))).sort((a, b) => a.t - b.t);
  const cur = lists.map(() => 0);
  return events.map((e) => { cur[e.i] = e.v; return { t: e.t, v: cur.reduce((a, v) => a + v, 0) }; });
}
// The hour in progress is how far the meter's own counter has moved since the hour began.
function hourSoFar(energyPts) {
  const E = energyPts.filter((p) => Number.isFinite(p.v));
  if (!E.length) return 0;
  const sofar = E[E.length - 1].v - E[0].v;
  return sofar >= 0 && sofar < 20 ? sofar : 0;
}
// A counter's moves per minute. A minute in which the counter did not move has no row.
function minuteEnergy(hist, startMs, endMs) {
  const pts = readingPts(hist).filter((p) => Number.isFinite(p.v)), at = new Map();
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].v - pts[i - 1].v, t = pts[i].t;
    if (d > 0 && d < 20 && t >= startMs && t < endMs) { const k = t - (t % 60000); at.set(k, (at.get(k) || 0) + d); }
  }
  return [...at].sort(([a], [b]) => a - b).map(([start, change]) => ({ start, change }));
}
function toDaily(rows, tz) {
  return groupRows(rows, (t) => { const [y, m, d] = localParts(t, tz).day.split('-').map(Number); return +zonedTime(y, m - 1, d, tz); });
}
// 5-minute rows grouped into hours.
function toHourly(rows) {
  return groupRows(rows, (t) => t - (t % HOUR));
}
function groupRows(rows, keyOf) {
  const out = new Map();
  for (const r of rows || []) {
    const t = +new Date(r.start), k = keyOf(t), o = out.get(k) || { start: k, change: 0, n: 0, sum: 0, min: Infinity, max: -Infinity };
    o.change += r.change || 0;
    if (r.mean != null) { o.sum += r.mean; o.n++; }
    if (r.min != null) o.min = Math.min(o.min, r.min);
    if (r.max != null) o.max = Math.max(o.max, r.max);
    if (r.state != null) o.state = r.state;
    out.set(k, o);
  }
  return [...out.values()].sort((a, b) => a.start - b.start).map((o) => ({ start: o.start, change: o.change, state: o.state, mean: o.n ? o.sum / o.n : null, min: o.min === Infinity ? null : o.min, max: o.max === -Infinity ? null : o.max }));
}
function dailyProfile(hours) {
  const bins = { weekday: Array.from({ length: 24 }, () => []), weekend: Array.from({ length: 24 }, () => []) };
  for (const h of hours) bins[h.weekend ? 'weekend' : 'weekday'][h.hour].push(h.kwh * 1000);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return { weekday: bins.weekday.map(avg), weekend: bins.weekend.map(avg) };
}
function weekdayAverages(days) {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], sum = Array(7).fill(0), n = Array(7).fill(0);
  for (const d of days) { const i = (new Date(`${d.day}T12:00:00Z`).getUTCDay() + 6) % 7; sum[i] += d.kwh; n[i]++; }
  return names.map((name, i) => ({ name, kwh: n[i] ? sum[i] / n[i] : null, days: n[i] }));
}
function durationCurve(rows) {
  const v = (rows || []).map((r) => r.mean).filter((x) => x != null).sort((a, b) => b - a);
  return v.map((w, i) => ({ pct: v.length > 1 ? (i / (v.length - 1)) * 100 : 0, w }));
}
function cumulativeSeries(hours) {
  let sum = 0;
  return [...hours].sort((a, b) => a.t - b.t).map((h) => { sum += h.kwh; return { t: h.t, v: sum }; });
}
function heatCells(a, start, end, tz) {
  const byT = new Map(a.hours.map((h) => [h.t, h]));
  const days = new Map();
  for (let t = +start - (+start % HOUR); t < +end; t += HOUR) {
    const p = localParts(t, tz), h = byT.get(t);
    // An hour only partly inside the period has no finished statistics, which doesn't mean the device was down.
    if (!h && !a.caught.has(t) && (t < +start || t + HOUR > +end)) continue;
    const cell = h ? { t, hour: p.hour, day: p.day, status: 'ok', kwh: h.kwh, eur: h.eur, mean: h.mean, max: h.max }
      : a.caught.has(t) ? { t, hour: p.hour, day: p.day, status: 'catchup', kwh: a.caught.get(t) }
        : { t, hour: p.hour, day: p.day, status: 'none' };
    if (!days.has(p.day)) days.set(p.day, []);
    const row = days.get(p.day);
    if (!row.some((c) => c.hour === p.hour)) row.push(cell);
  }
  return [...days].map(([day, cells]) => ({ day, cells }));
}
function minuteOf(ms, tz) {
  return +new Intl.DateTimeFormat('en-GB', { timeZone: tz, minute: 'numeric' }).format(new Date(ms));
}
// The heatmap grid for a chart step: hours by minute, days by hour, or weeks by day.
function heatGrid(a, buckets, step, start, end, tz) {
  const pad = (x) => String(x).padStart(2, '0'), grouped = new Map();
  const put = (key, label, cell) => { if (!grouped.has(key)) grouped.set(key, { label, cells: [] }); grouped.get(key).cells.push(cell); };
  if (step === HOUR) {
    for (const r of heatCells(a, start, end, tz)) grouped.set(r.day, { label: fmtDay(r.day, { weekday: 'short', day: 'numeric' }), cells: r.cells.map((c) => ({ ...c, col: c.hour })) });
    return { rows: [...grouped.values()], cols: 24, colLabels: [0, 3, 6, 9, 12, 15, 18, 21].map((h) => [h, pad(h)]), unit: 'hour', short: 'h' };
  }
  if (step === 60000) {
    const byT = new Map(buckets.map((b) => [b.t, b]));
    for (let t = +start - (+start % 60000); t < +end; t += 60000) {
      const b = byT.get(Math.max(t, +start)) || byT.get(t), p = localParts(t, tz), m = minuteOf(t, tz);
      if (!b && (t < +start || t + 60000 > +end)) continue;
      const cell = { t, col: m, fine: true, when: `${fmtDay(p.day, { weekday: 'short', day: 'numeric', month: 'short' })}, ${pad(p.hour)}:${pad(m)}`, status: b ? 'ok' : 'none', ...(b ? { kwh: b.kwh, mean: b.mean, max: b.max } : {}) };
      put(`${p.day} ${p.hour}`, `${pad(p.hour)}:00`, cell);
    }
    return { rows: [...grouped.values()], cols: 60, colLabels: [0, 10, 20, 30, 40, 50].map((m) => [m, `:${pad(m)}`]), unit: 'minute', short: 'min' };
  }
  const byDay = new Map(buckets.map((b) => [b.day, b])), caught = new Map();
  for (const [t, kwh] of a.caught) { const d = localParts(t, tz).day; caught.set(d, (caught.get(d) || 0) + kwh); }
  const first = localParts(+start, tz).day, last = localParts(+end - 1, tz).day;
  for (let d = first; d <= last;) {
    const noon = new Date(`${d}T12:00:00Z`), col = (noon.getUTCDay() + 6) % 7, b = byDay.get(d), monday = new Date(+noon - col * 24 * HOUR).toISOString().slice(0, 10);
    const partial = (d === first && +start > +zonedTime(...ymd(d), tz)) || (d === last && +end < +zonedTime(...ymd(d, 1), tz));
    if (b || caught.has(d) || !partial) {
      const cell = { t: b?.t, day: d, col, when: fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short' }), status: b ? 'ok' : caught.has(d) ? 'catchup' : 'none', ...(b ? { kwh: b.kwh, eur: b.eur, mean: b.mean, max: b.max } : caught.has(d) ? { kwh: caught.get(d) } : {}) };
      put(monday, `From ${fmtDay(monday, { day: 'numeric', month: 'short' })}`, cell);
    }
    d = new Date(+noon + 24 * HOUR).toISOString().slice(0, 10);
  }
  return { rows: [...grouped.values()], cols: 7, colLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((n, i) => [i, n]), unit: 'day', short: 'days' };
}
function ymd(day, addDays = 0) {
  const [y, m, d] = day.split('-').map(Number);
  return [y, m - 1, d + addDays];
}
// Log scale, so an always-on 50 W stays distinct from 100 W next to a 2 kW peak.
function heatScale(values, floor = 0.005) {
  const v = values.filter((x) => x > 0);
  const lo = v.length ? Math.max(Math.min(...v), floor) : 0.01, hi = v.length ? Math.max(...v) : 1;
  const span = Math.log(hi / lo);
  return { lo, hi, at: (x) => (span > 0 ? Math.min(1, Math.max(0, Math.log(Math.max(x, lo) / lo) / span)) : 0.5) };
}
const HEAT_STOPS = ['#2f5fb3', '#1f9bb0', '#37b77f', '#d9cf45', '#f08a32', '#e5484d'];
function heatColor(f) {
  const n = HEAT_STOPS.length - 1, i = Math.min(n - 1, Math.floor(f * n)), l = f * n - i;
  const p = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  const [x, y] = [p(HEAT_STOPS[i]), p(HEAT_STOPS[i + 1])];
  return `rgb(${x.map((c, k) => Math.round(c + (y[k] - c) * l)).join(',')})`;
}
const n0 = (x) => Math.round(x).toLocaleString('en-US');
const n1 = (x) => x.toFixed(1);
// Power everywhere in a report: watts below 1,000, kW from there up.
const wText = (v) => (Math.abs(v) >= 1000 ? `${n1(v / 1000)} kW` : `${Math.round(v)} W`);
const n2 = (x) => x.toFixed(2);
const eur = (x) => `€ ${x.toFixed(2)}`;
function fmtDay(day, opts) { return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts }); }
function cellTip(c, ctx) {
  const when = c.when || `${fmtDay(c.day, { weekday: 'short', day: 'numeric', month: 'short' })}, ${String(c.hour).padStart(2, '0')}:00 to ${String((c.hour + 1) % 24).padStart(2, '0')}:00`;
  if (c.status === 'none') return { when, status: 'No reading', rows: [] };
  if (c.status === 'catchup') return { when, status: 'Device catching up after an outage', rows: [['Caught up after an outage', `${n2(c.kwh)} kWh`]] };
  const rows = [['Energy', c.fine ? `${c.kwh.toFixed(4)} kWh` : `${n2(c.kwh)} kWh`]];
  if (c.mean != null) rows.push(['Average', `${wText(c.mean)}`]);
  if (c.max != null) rows.push(['Peak', `${wText(c.max)}`]);
  const cost = c.eur ?? c.kwh * ctx.priceAt(c.t);
  rows.push([`Cost, ${ctx.vat}`, c.fine ? `€ ${cost.toFixed(4)}` : eur(cost)]);
  return { when, status: null, rows };
}
function niceMax(v) {
  if (!(v > 0)) return 1;
  const m = 10 ** Math.floor(Math.log10(v)), f = v / m;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * m;
}

const PDF_COLOURS = { '--primary-background-color': '#ffffff', '--card-background-color': '#f6f7f8', '--primary-text-color': '#1c1f23', '--secondary-text-color': '#5f6368', '--disabled-text-color': '#9aa0a6', '--divider-color': '#dfe1e5', '--primary-color': '#0b7ea3', '--error-color': '#c5221f' };
const C = { gold: 'var(--primary-color)', sky: '#6cb4ee', teal: '#4ec9a8', slate: 'var(--disabled-text-color)', slate2: 'var(--secondary-text-color)', fg: 'var(--primary-text-color)', muted: 'var(--secondary-text-color)', line: 'var(--divider-color)', track: 'var(--divider-color)', bad: 'var(--error-color)', page: 'var(--primary-background-color)', panel: 'var(--card-background-color)' };
const AXIS = `fill="${C.muted}" font-size="10.5"`;

// Line chart. Registers what hover needs in ctx.specs. A gap in the data breaks the line.
function lineChart(id, o, ctx) {
  const W = ctx.widthFor(o.span), H = o.h || 130, l = 48, r = 8, t = 8, b = 18;
  const series = o.series.filter((s) => !ctx.hidden.has(`${id}:${s.name}`));
  const all = o.series.flatMap((s) => s.pts);
  if (!all.length) return '<p class="note">No data for this period.</p>';
  const x0 = o.x0 ?? Math.min(...all.map((p) => p.x)), x1 = o.x1 ?? Math.max(...all.map((p) => p.x));
  const vals = series.flatMap((s) => s.pts.flatMap((p) => [p.max ?? p.y, p.min ?? p.y]));
  let y0 = o.y0, y1 = o.y1;
  if (y1 == null) y1 = niceMax(Math.max(0.0001, ...vals));
  if (y0 == null) y0 = 0;
  const px = (v) => l + ((v - x0) / Math.max(1e-9, x1 - x0)) * (W - l - r), py = (v) => t + (1 - (v - y0) / Math.max(1e-9, y1 - y0)) * (H - t - b);
  const grid = [0, 0.5, 1].map((f) => { const v = y0 + f * (y1 - y0); return `<line x1="${l}" x2="${W - r}" y1="${py(v)}" y2="${py(v)}" stroke="${C.line}"/><text x="${l - 5}" y="${py(v) + 3.5}" text-anchor="end" ${AXIS}>${o.fmtY(v)}</text>`; }).join('');
  const nt = Math.max(2, Math.min(o.ticks || 6, Math.floor((W - l - r) / 70)));
  const ticks = Array.from({ length: nt }, (_, i) => x0 + (i / (nt - 1)) * (x1 - x0)).map((v, i) => `<text x="${px(v)}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === nt - 1 ? 'end' : 'middle'}" ${AXIS}>${o.fmtX(v, true)}</text>`).join('');
  const limits = (o.limits || []).filter((v) => v >= y0 && v <= y1).map((v) => `<line x1="${l}" x2="${W - r}" y1="${py(v)}" y2="${py(v)}" stroke="${C.bad}" stroke-dasharray="4 3" opacity=".7"/>`).join('');
  const paths = series.map((s) => {
    const pts = [...s.pts].sort((a, b) => a.x - b.x), segs = [];
    let cur = [];
    pts.forEach((p, i) => { if (i && o.gap && p.x - pts[i - 1].x > o.gap) { segs.push(cur); cur = []; } cur.push(p); });
    if (cur.length) segs.push(cur);
    return segs.map((seg) => {
      const band = s.band && seg.length > 1 ? `<polygon points="${seg.map((p) => `${px(p.x).toFixed(1)},${py(p.max ?? p.y).toFixed(1)}`).join(' ')} ${[...seg].reverse().map((p) => `${px(p.x).toFixed(1)},${py(p.min ?? p.y).toFixed(1)}`).join(' ')}" fill="${s.color}" opacity=".16"/>` : '';
      const line = seg.length > 1 ? `<polyline points="${seg.map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="1.5"${s.dash ? ' stroke-dasharray="4 3"' : ''}/>` : `<circle cx="${px(seg[0].x)}" cy="${py(seg[0].y)}" r="2" fill="${s.color}"/>`;
      return band + line;
    }).join('');
  }).join('');
  ctx.specs[id] = { kind: 'line', px, py, x0, x1, l, r: W - r, series, fmtX: o.fmtX, fmtV: o.fmtV, xs: [...new Set(series.flatMap((s) => s.pts.map((p) => p.x)))].sort((a, b) => a - b), zoom: o.zoom };
  const svgLine = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${grid}${limits}${paths}${ticks}</svg>`;
  if (ctx.svgs) ctx.svgs[id] = { svg: svgLine, h: H, legend: o.series.length > 1 ? series.map((s) => ({ name: s.name, color: s.color })) : [] };
  const legend = o.series.length > 1 ? `<div class="lg">${o.series.map((s) => `<button data-series="${id}:${s.name}" class="${ctx.hidden.has(`${id}:${s.name}`) ? 'off' : ''}" aria-pressed="${!ctx.hidden.has(`${id}:${s.name}`)}"><i style="background:${s.color}"></i>${s.name}</button>`).join('')}</div>` : '';
  return `${legend}<div class="plot" data-chart="${id}"${o.zoom ? ' data-zoom="1"' : ''}><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${o.label}">${grid}${limits}${paths}${ticks}<line class="xh" x1="0" x2="0" y1="${t}" y2="${H - b}" stroke="${C.muted}" stroke-width="1" visibility="hidden"/><g class="dots"></g><rect class="brush" y="${t}" height="${H - t - b}" fill="${C.gold}" opacity=".2" visibility="hidden"/></svg><div class="tip" hidden></div></div>`;
}
// Bars. Each bar carries its own tooltip. A bar with a day can be clicked to zoom in.
function barChart(id, o, ctx) {
  const W = ctx.widthFor(o.span), H = o.h || 130, l = 38, r = 4, t = 8, b = 18, rows = o.rows;
  if (!rows.length) return '<p class="note">No data for this period.</p>';
  const keys = o.stack || [{ key: 'v', color: o.color || C.slate, name: o.name }], shown = keys.filter((k) => !ctx.hidden.has(`${id}:${k.name}`));
  const total = (x) => shown.reduce((s, k) => s + (x[k.key] || 0), 0);
  const y1 = niceMax(Math.max(0.0001, ...rows.map(total))), py = (v) => t + (1 - v / y1) * (H - t - b);
  const step = (W - l - r) / rows.length, bw = Math.max(2, Math.min(step * 0.7, 30)), every = Math.max(1, Math.ceil(rows.length / Math.floor((W - l - r) / 46)));
  const grid = [0, 0.5, 1].map((f) => `<line x1="${l}" x2="${W - r}" y1="${py(f * y1)}" y2="${py(f * y1)}" stroke="${C.line}"/><text x="${l - 5}" y="${py(f * y1) + 3.5}" text-anchor="end" ${AXIS}>${o.fmtY(f * y1)}</text>`).join('');
  const max = Math.max(...rows.map(total));
  ctx.specs[id] = { kind: 'bars', tips: rows.map((x) => x.tip) };
  const bars = rows.map((x, i) => {
    const cx = l + i * step + step / 2; let y = py(0);
    const parts = shown.map((k) => { const v = x[k.key] || 0, h = y - py((py(0) - y + 0) / ((H - t - b) / y1) + v); y -= h; const fill = o.stack ? k.color : (x.v === max && o.hilite ? C.gold : k.color); return `<rect pointer-events="none" x="${cx - bw / 2}" y="${y}" width="${bw}" height="${Math.max(0, h)}" fill="${fill}"/>`; }).join('');
    const label = i % every === 0 ? `<text x="${cx}" y="${H - 5}" text-anchor="middle" ${AXIS}>${x.label}</text>` : '';
    return `<g class="bar"${x.day ? ` data-day="${x.day}"` : ''}><rect class="hit" data-i="${i}" x="${l + i * step}" y="${t}" width="${step}" height="${H - t - b}" fill="transparent"/>${parts}</g>${label}`;
  }).join('');
  if (ctx.svgs) ctx.svgs[id] = { svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${grid}${bars}</svg>`, h: H, legend: o.stack ? shown.map((k) => ({ name: `Phase ${k.name}`, color: k.color })) : [] };
  const legend = o.stack ? `<div class="lg">${keys.map((k) => `<button data-series="${id}:${k.name}" class="${ctx.hidden.has(`${id}:${k.name}`) ? 'off' : ''}" aria-pressed="${!ctx.hidden.has(`${id}:${k.name}`)}"><i style="background:${k.color}"></i>${k.name}</button>`).join('')}</div>` : '';
  return `${legend}<div class="plot" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${o.label}">${grid}${bars}</svg><div class="tip" hidden></div></div>`;
}
function heatmap(a, ctx, buckets) {
  const grid = heatGrid(a, buckets, ctx.trends.step, ctx.start, ctx.end, ctx.tz), rows = grid.rows;
  if (!rows.length) return '';
  const flat = rows.flatMap((r) => r.cells), good = flat.filter((c) => c.status === 'ok').map((c) => c.kwh);
  const scale = heatScale(good, grid.unit === 'minute' ? 0.0005 : 0.005), W = ctx.widthFor(12), l = 62, top = 16, cell = (W - l - 2) / grid.cols;
  const ch = grid.unit === 'day' ? 24 : rows.length > 14 ? Math.max(8, Math.min(12, 300 / rows.length)) : 15, H = top + ch * rows.length + 2;
  const noRead = flat.filter((c) => c.status === 'none').length, catchup = flat.filter((c) => c.status === 'catchup').length;
  ctx.specs.heat = { kind: 'heat', cells: flat };
  const ticks = [0, 0.33, 0.66, 1].map((f) => scale.lo * (scale.hi / scale.lo) ** f), fmtTick = (v) => (v < 0.1 ? v.toFixed(3) : v < 1 ? n2(v) : n1(v));
  let i = 0;
  const rects = rows.map((r, ri) => r.cells.map((c) => { const fill = c.status === 'ok' ? heatColor(scale.at(c.kwh)) : c.status === 'none' ? 'url(#hatchNone)' : 'url(#hatchCatch)', zoom = grid.unit === 'hour' ? ` data-hour="${c.t}"` : grid.unit === 'day' ? ` data-day="${c.day}"` : ''; const out = `<rect class="hc" data-i="${i}"${zoom} x="${l + c.col * cell}" y="${top + ri * ch}" width="${Math.max(1, cell - 1.5)}" height="${Math.max(1, ch - 1.5)}" rx="1.5" fill="${fill}"/>`; i++; return out; }).join('')).join('');
  const every = rows.length > 14 ? Math.ceil(rows.length / 15) : 1;
  const heatBody = `<defs><pattern id="hatchNone" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="${C.panel}"/><rect width="1.6" height="5" fill="${C.bad}"/></pattern><pattern id="hatchCatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="5" height="5" fill="${C.panel}"/><rect width="1.6" height="5" fill="#e9b44c"/></pattern></defs>${rects}${rows.map((r, ri) => (ri % every === 0 ? `<text x="${l - 6}" y="${top + ri * ch + ch / 2 + 3}" text-anchor="end" ${AXIS}>${r.label}</text>` : '')).join('')}${grid.colLabels.map(([col, text]) => `<text x="${l + col * cell + cell / 2}" y="${top - 5}" text-anchor="middle" ${AXIS}>${text}</text>`).join('')}`;
  if (ctx.svgs) ctx.svgs.heat = { svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${heatBody}</svg>`, h: H, legend: [], heat: { ticks: ticks.map(fmtTick), noRead, catchup, unit: grid.unit, short: grid.short } };
  return `<div class="plot" data-chart="heat"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Energy by ${grid.unit}. ${noRead} ${grid.short} have no reading.">${heatBody}</svg><div class="tip" hidden></div></div>
  <div class="hkey"><span class="rampwrap"><span class="ramp"></span><span class="rlabels">${ticks.map((v) => `<span>${fmtTick(v)}</span>`).join('')}</span></span><span>kWh per ${grid.unit}</span><span class="k"><i class="sw none"></i>No reading${noRead ? ` (${noRead} ${grid.short})` : ''}</span>${catchup ? `<span class="k"><i class="sw catch"></i>Catch-up (${catchup} ${grid.short})</span>` : ''}</div>`;
}
function donut(a, ctx) {
  const parts = [['Working hours', a.split.work, C.gold], ['Evenings and nights', a.split.after, C.sky], ['Weekend', a.split.weekend, C.slate2]];
  const total = a.total || 1, R = 56, r = 38, cx = 60;
  let ang = -Math.PI / 2;
  const pt = (rad, x) => `${(cx + rad * Math.cos(x)).toFixed(2)} ${(cx + rad * Math.sin(x)).toFixed(2)}`;
  const tips = [];
  const paths = parts.map(([name, v, col], i) => {
    const f = Math.min(v / total, 0.9999), end = ang + f * 2 * Math.PI, large = f > 0.5 ? 1 : 0;
    const d = `M${pt(R, ang)}A${R} ${R} 0 ${large} 1 ${pt(R, end)}L${pt(r, end)}A${r} ${r} 0 ${large} 0 ${pt(r, ang)}Z`;
    ang = end;
    tips.push({ when: name, rows: [['Energy', `${n1(v)} kWh`], ['Share', `${Math.round(f * 100)}%`], [`Cost, ${ctx.vat}`, eur(a.splitEur[['work', 'after', 'weekend'][i]])]] });
    return v > 0 ? `<path class="slice" data-i="${i}" d="${d}" fill="${col}" stroke="${C.panel}"/>` : '';
  }).join('');
  ctx.specs.split = { kind: 'bars', tips };
  if (ctx.svgs) ctx.svgs.split = { svg: `<svg viewBox="0 0 120 120" width="120" height="120">${paths}<text x="60" y="58" text-anchor="middle" fill="${C.fg}" font-size="14">${n1(a.total)} kWh</text><text x="60" y="72" text-anchor="middle" ${AXIS}>${Math.round((a.split.work / total) * 100)}% working</text></svg>`, h: 120, donut: parts.map(([name, v, color]) => ({ name, color, value: `${n1(v)} kWh` })), legend: [] };
  return `<div class="donut"><div class="plot" data-chart="split"><svg viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="Share of energy by time">${paths}<text x="60" y="58" text-anchor="middle" fill="${C.fg}" font-size="14">${n1(a.total)} kWh</text><text x="60" y="72" text-anchor="middle" ${AXIS}>${Math.round((a.split.work / total) * 100)}% working</text></svg><div class="tip" hidden></div></div><ul>${parts.map(([n, v, c]) => `<li><i style="background:${c}"></i>${n}<span>${n1(v)} kWh</span></li>`).join('')}</ul></div>`;
}
// Rows left after folding: anything deeper than a shut row is hidden until the next row at its level.
function foldedRows(rows, shut) {
  const out = [];
  let skip = null;
  rows.forEach((x, i) => {
    if (skip != null && x.depth > skip) return;
    skip = null;
    const parent = rows[i + 1]?.depth > x.depth, closed = parent && !!shut?.has(x.id);
    if (closed) skip = x.depth;
    out.push({ ...x, parent, shut: closed });
  });
  return out;
}
function renderReport(a, ctx) {
  const on = (b) => ctx.show.has(b) && !(ctx.client && TECH_BLOCKS.has(b)), tz = ctx.tz, span = +ctx.end - +ctx.start;
  const fmtT = (ms, short) => new Date(ms).toLocaleString('en-GB', { timeZone: tz, ...(span <= 2 * 86400000 ? { hour: '2-digit', minute: '2-digit', ...(short ? {} : { weekday: 'short', day: 'numeric', month: 'short' }) } : short ? { day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short', ...(ctx.trends.step > HOUR ? {} : { hour: '2-digit', minute: '2-digit' }) }) });
  const card = (id, span12, title, body, sub) => { if (ctx.blockMeta) ctx.blockMeta.push({ id, span: span12, title }); return cardHtml(id, span12, title, body, sub); };
  const cardHtml = (id, span12, title, body, sub) => `<section class="card s${span12}" id="c-${id}"><header><h3>${title}</h3>${sub ? `<span>${sub}</span>` : ''}</header>${body}</section>`;
  const tr = ctx.trends;
  const validRow = (r) => { const t = +new Date(r.start); return a.valid.has(t - (t % HOUR)); };
  // Minute rows are raw readings and daily rows are already checked, so only statistics rows can repeat a stale value.
  const realRow = (r) => tr.step === 60000 || tr.step > HOUR || validRow(r);
  const rowsT = (rows) => rows.filter(realRow).map((r) => ({ x: Math.max(+ctx.start, +new Date(r.start)), y: r.mean, min: r.min, max: r.max })).filter((p) => p.y != null);
  const gap = tr.step * 1.5, delta = ctx.prevTotal > 0 && !ctx.noCompare ? Math.round(((a.total - ctx.prevTotal) / ctx.prevTotal) * 100) : null;
  const allHours = heatCells(a, ctx.start, ctx.end, tz).reduce((n, r) => n + r.cells.length, 0);
  const cover = allHours ? Math.round((a.covered / allHours) * 100) : 0;
  const kpi = (label, value, sub, attr = '') => `<div class="kpi"><span>${label}</span><b ${attr}>${value}</b>${sub ? `<small>${sub}</small>` : '<small>&nbsp;</small>'}</div>`;
  const peakAt = a.peak && new Date(a.peak.t).toLocaleString('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const days = a.days.map((d) => ({ ...d, label: fmtDay(d.day, { weekday: 'short', day: 'numeric' }) }));
  // One row per minute, hour or day. Every time-based chart reads these, so they all follow the period.
  const powerAt = new Map(tr.power.map((r) => [+new Date(r.start), r]));
  const buckets = tr.step === 60000
    ? (tr.minuteEnergy || []).map((r) => ({ t: Math.max(r.start, +ctx.start), kwh: r.change, mean: powerAt.get(r.start)?.mean, max: powerAt.get(r.start)?.max }))
    : tr.step === HOUR ? a.hours
      : a.days.map((d) => { const t = +zonedTime(...ymd(d.day), tz), r = tr.power.find((x) => +new Date(x.start) === t); return { t, day: d.day, kwh: d.kwh, eur: d.eur, mean: r?.mean, max: r?.max }; });
  const by = tr.step > HOUR ? 'day' : tr.step === HOUR ? 'hour' : 'minute', pad2 = (x) => String(x).padStart(2, '0');
  // Every minute, hour or day of the period keeps its place on the bars, so a missing reading stays visible.
  const slots = [];
  if (tr.step === 60000) {
    const at = new Map(buckets.map((b) => [b.t, b]));
    for (let k = +ctx.start - (+ctx.start % 60000); k < +ctx.end; k += 60000) { const t = Math.max(k, +ctx.start); slots.push({ key: k, x: at.get(t), label: fmtT(t, true), when: fmtT(t) }); }
  } else if (tr.step === HOUR) {
    const at = new Map(a.hours.map((b) => [b.t, b]));
    for (let t = +ctx.start - (+ctx.start % HOUR); t < +ctx.end; t += HOUR) {
      const x = at.get(t), p = localParts(t, tz);
      if (x || (t >= +ctx.start && t + HOUR <= +ctx.end)) slots.push({ key: t, x, label: `${pad2(p.hour)}:00`, when: `${fmtDay(p.day, { weekday: 'short', day: 'numeric', month: 'short' })}, ${pad2(p.hour)}:00 to ${pad2((p.hour + 1) % 24)}:00` });
    }
  } else {
    const at = new Map(days.map((d) => [d.day, d])), first = localParts(+ctx.start, tz).day, last = localParts(+ctx.end - 1, tz).day;
    for (let d = first; d <= last; d = new Date(+new Date(`${d}T12:00:00Z`) + 24 * HOUR).toISOString().slice(0, 10)) {
      const x = at.get(d), partial = (d === first && +ctx.start > +zonedTime(...ymd(d), tz)) || (d === last && +ctx.end < +zonedTime(...ymd(d, 1), tz));
      if (x || !partial) slots.push({ key: d, x, day: d, label: fmtDay(d, { weekday: 'short', day: 'numeric' }), when: fmtDay(d, { weekday: 'long', day: 'numeric', month: 'long' }) });
    }
  }
  // Part-hours and part-days read low, so the averages only use whole ones.
  const wholeHours = a.hours.filter((h) => h.t >= +ctx.start && h.t + HOUR <= +ctx.end), fullHours = wholeHours.length ? wholeHours : a.hours;
  const inDay = new Map();
  for (const h of wholeHours) inDay.set(h.day, (inDay.get(h.day) || 0) + 1);
  const wholeDays = a.days.filter((d) => (inDay.get(d.day) || 0) >= 20), fullDays = wholeDays.length ? wholeDays : a.days;
  const smallY = (v) => (v === 0 ? '0' : v < 0.1 ? v.toFixed(3) : v < 10 ? n1(v) : n0(v));
  const metric = ctx.metric === 'eur' ? 'eur' : 'kwh';
  const blocks = [];
  if (on('power')) blocks.push(card('power', 8, 'Power over time', lineChart('power', { span: 8, h: ctx.pdf ? 225 : 150, label: 'Power over time', zoom: true, gap, x0: +ctx.start, x1: +ctx.end, fmtX: fmtT, fmtY: wText, fmtV: (v) => `${wText(v)}`, series: [{ name: 'Average', color: C.gold, band: true, pts: rowsT(tr.power) }] }, ctx), `${ctx.meterCount > 1 ? `Sum of ${ctx.meterCount} devices. ` : ''}Drag to zoom. The band shows low and high.`));
  if (on('split')) blocks.push(card('split', 4, 'When energy is used', donut(a, ctx), '08:00 to 19:00, Mon to Fri'));
  if (on('energy')) {
    const unit = metric === 'eur' ? '€' : 'kWh';
    const val = (x) => (metric === 'eur' ? x.eur ?? x.kwh * ctx.priceAt(x.t) : x.kwh), fineBars = tr.step === 60000;
    const rows = slots.map((sl) => (!sl.x ? { v: 0, label: sl.label, tip: { when: sl.when, note: 'No reading', rows: [] } } : { v: val(sl.x), label: sl.label, ...(sl.day ? { day: sl.day } : {}), tip: { when: sl.when, ...(sl.day ? { note: 'Click to zoom in' } : {}), rows: [['Energy', fineBars ? `${sl.x.kwh.toFixed(4)} kWh` : `${n2(sl.x.kwh)} kWh`], [`Cost, ${ctx.vat}`, fineBars ? `€ ${(sl.x.eur ?? sl.x.kwh * ctx.priceAt(sl.x.t)).toFixed(4)}` : eur(sl.x.eur ?? sl.x.kwh * ctx.priceAt(sl.x.t))]] } }));
    blocks.push(card('energy', 4, `Energy and cost by ${by}`, `<div class="lg"><button data-metric="kwh" class="${metric === 'kwh' ? '' : 'off'}">kWh</button><button data-metric="eur" class="${metric === 'eur' ? '' : 'off'}">€</button></div>${barChart('energy', { span: 4, label: `Energy by ${by}`, rows, color: C.slate, hilite: true, name: unit, fmtY: smallY }, ctx)}`, metric === 'eur' ? `€ ${ctx.vat}` : undefined));
  }
  if (on('cumulative')) {
    const fromStart = (t) => Math.max(0, t - +ctx.start) / HOUR, prevStart = ctx.prevStart || +ctx.start - span;
    const fromMeter = (pts, from) => pts.map((p) => ({ x: Math.max(0, p.t - from) / HOUR, y: p.v - pts[0].v }));
    const cur = tr.energyPts?.length ? fromMeter(tr.energyPts, +ctx.start) : cumulativeSeries(buckets).map((p) => ({ x: fromStart(p.t), y: p.v }));
    const okPrev = (ctx.prevRows || []).map((r) => ({ start: r.start, change: r.change > 0 && r.change < 20 ? r.change : 0 }));
    const prevRows = tr.step > HOUR ? toDaily(okPrev, tz) : okPrev;
    let sum = 0; const prev = tr.prevEnergyPts?.length ? fromMeter(tr.prevEnergyPts, prevStart) : prevRows.map((r) => { sum += r.change; return { x: Math.max(0, +new Date(r.start) - prevStart) / HOUR, y: sum }; });
    const fmtX = (h, short) => (tr.step === 60000 ? `${Math.round(h * 60)} min${short ? '' : ' into the period'}` : tr.step > HOUR ? `Day ${Math.floor(h / 24) + 1}` : `${Math.round(h)} h${short ? '' : ' into the period'}`);
    blocks.push(card('cumulative', 4, 'Usage so far vs last period', lineChart('cumulative', { span: 4, label: 'Usage so far vs last period', x0: 0, x1: span / HOUR, ticks: 4, fmtX, fmtY: (v) => (v < 10 ? n1(v) : n0(v)), fmtV: (v) => `${n2(v)} kWh`, series: [{ name: 'This period', color: C.gold, pts: cur }, { name: ctx.prevStart ? 'Yesterday' : 'Previous', color: C.slate2, dash: true, pts: prev }] }, ctx)));
  }
  if (on('profile')) {
    const fmtW = wText;
    if (tr.step === HOUR) {
      const p = dailyProfile(fullHours), pts = (arr) => arr.map((y, x) => (y == null ? null : { x, y })).filter(Boolean);
      blocks.push(card('profile', 4, 'Average daily profile', lineChart('profile', { span: 4, label: 'Average daily profile', x0: 0, x1: 23, ticks: 5, fmtX: (h) => `${pad2(Math.round(h))}:00`, fmtY: fmtW, fmtV: (v) => `${wText(v)}`, series: [{ name: 'Weekdays', color: C.gold, pts: pts(p.weekday) }, { name: 'Weekend', color: C.sky, pts: pts(p.weekend) }] }, ctx)));
    } else {
      const rows = rowsT(tr.power).map(({ x, y }) => ({ x, y })), isEnd = (x) => localParts(x, tz).weekend, title = tr.step === 60000 ? 'Average power by minute' : 'Average power by day';
      blocks.push(card('profile', 4, title, lineChart('profile', { span: 4, label: title, gap, x0: +ctx.start, x1: +ctx.end, ticks: 4, fmtX: fmtT, fmtY: fmtW, fmtV: (v) => `${wText(v)}`, series: [{ name: 'Weekdays', color: C.gold, pts: rows.filter((p) => !isEnd(p.x)) }, { name: 'Weekend', color: C.sky, pts: rows.filter((p) => isEnd(p.x)) }] }, ctx)));
    }
  }
  if (on('heat')) blocks.push(card('heat', 12, `Energy by ${by}`, heatmap(a, ctx, buckets), tr.step === 60000 ? 'A gap means the device reported no new energy that minute' : tr.step === HOUR ? 'Click a square to see that hour by minute' : 'Click a square to zoom into that day'));
  if (on('weekday')) {
    if (tr.step > HOUR) {
      const w = weekdayAverages(fullDays).filter((d) => d.days);
      blocks.push(card('weekday', 4, 'By day of week', barChart('weekday', { span: 4, label: 'Average energy by day of week', color: C.sky, fmtY: smallY, rows: w.map((d) => ({ v: d.kwh, label: d.name, tip: { when: d.name, rows: [['Average', `${n2(d.kwh)} kWh`], ['Average cost', eur(d.kwh * ctx.tariff)], ['Days counted', String(d.days)]] } })) }, ctx)));
    } else {
      const minutes = tr.step === 60000, groups = new Map();
      for (const b of minutes ? buckets : fullHours) { const k = minutes ? minuteOf(b.t, tz) : b.hour, g = groups.get(k) || { sum: 0, n: 0 }; g.sum += b.kwh; g.n++; groups.set(k, g); }
      const fine = (v) => (minutes ? v.toFixed(4) : n2(v)), title = minutes ? 'By minute of the hour' : 'By hour of the day';
      blocks.push(card('weekday', 4, title, barChart('weekday', { span: 4, label: `Average energy ${title.toLowerCase()}`, color: C.sky, fmtY: smallY, rows: [...groups].sort(([x], [y]) => x - y).map(([k, g]) => ({ v: g.sum / g.n, label: minutes ? `:${pad2(k)}` : pad2(k), tip: { when: minutes ? `Minute :${pad2(k)}` : `${pad2(k)}:00 to ${pad2((k + 1) % 24)}:00`, rows: [['Average', `${fine(g.sum / g.n)} kWh`], ['Average cost', minutes ? `€ ${((g.sum / g.n) * ctx.tariff).toFixed(4)}` : eur((g.sum / g.n) * ctx.tariff)], [minutes ? 'Minutes counted' : 'Hours counted', String(g.n)]] } })) }, ctx)));
    }
  }
  if (on('phases')) {
    const merged = new Map(), minutes = tr.step === 60000;
    if (tr.step <= HOUR) for (const [k, rows] of Object.entries(tr.phases || {})) for (const r of rows) {
      const t = +new Date(r.start);
      if (!realRow(r)) continue;
      const row = merged.get(t) || { t };
      row[k] = (row[k] || 0) + (r.change || 0);
      merged.set(t, row);
    }
    const fine = (v) => (minutes ? `${v.toFixed(4)} kWh` : `${n2(v)} kWh`), byDay = new Map(a.phaseDays.map((d) => [d.day, d]));
    const any = tr.step > HOUR ? a.phaseDays.length : merged.size;
    const rows = !any ? [] : slots.map((sl) => { const d = tr.step > HOUR ? byDay.get(sl.key) : merged.get(sl.key); return d ? { ...d, label: sl.label, tip: { when: sl.when, rows: ['A', 'B', 'C'].map((k) => [`Phase ${k}`, fine(d[k] || 0)]) } } : { label: sl.label, tip: { when: sl.when, note: 'No reading', rows: [] } }; });
    if (rows.length) blocks.push(card('phases', 4, `Phases by ${by}`, barChart('phases', { span: 4, label: `Energy per phase by ${by}`, fmtY: smallY, stack: [{ key: 'A', name: 'A', color: C.sky }, { key: 'B', name: 'B', color: C.gold }, { key: 'C', name: 'C', color: C.teal }], rows }, ctx)));
  }
  if (on('duration')) {
    const pts = durationCurve(tr.power.filter(realRow)).map((p) => ({ x: p.pct, y: p.w }));
    blocks.push(card('duration', 4, 'Load duration', lineChart('duration', { span: 4, label: 'Load duration curve', x0: 0, x1: 100, ticks: 5, fmtX: (v, short) => (short ? `${Math.round(v)}%` : `Above this for ${Math.round(v)}% of the time`), fmtY: wText, fmtV: (v) => `${wText(v)}`, series: [{ name: 'Power', color: C.gold, pts }] }, ctx)));
  }
  if (on('voltage')) {
    const colors = [C.sky, C.gold, C.teal], names = tr.voltages.length > 1 ? ['Phase A', 'Phase B', 'Phase C'] : ['Voltage'];
    const series = tr.voltages.map((rows, i) => ({ name: names[i], color: colors[i], pts: rowsT(rows) })).filter((s) => s.pts.length);
    blocks.push(card('voltage', 6, 'Voltage', lineChart('voltage', { span: 6, label: 'Voltage over time', gap, x0: +ctx.start, x1: +ctx.end, y0: 200, y1: 260, limits: [207, 253], fmtX: fmtT, fmtY: (v) => `${Math.round(v)} V`, fmtV: (v) => `${n1(v)} V`, series }, ctx), `${ctx.meterCount > 1 ? `Average of ${ctx.meterCount} devices. ` : ''}Dashed lines: normal range`));
  }
  if (on('frequency')) blocks.push(card('frequency', 6, 'Frequency', lineChart('frequency', { span: 6, label: 'Frequency over time', gap, x0: +ctx.start, x1: +ctx.end, y0: 49.5, y1: 50.5, limits: [49.8, 50.2], fmtX: fmtT, fmtY: (v) => `${n1(v)} Hz`, fmtV: (v) => `${n2(v)} Hz`, series: [{ name: 'Frequency', color: C.sky, pts: rowsT(tr.frequency) }] }, ctx), `${ctx.meterCount > 1 ? `Average of ${ctx.meterCount} devices. ` : ''}Dashed lines: normal range`));
  for (const [id, title, unit, range] of EXTRA_CHARTS) {
    if (!on(id) || !tr[id]) continue;
    const names = ctx.extraMeters?.[id] || [], n = names.length;
    blocks.push(card(id, 4, title, lineChart(id, { span: 4, label: `${title} over time`, gap, x0: +ctx.start, x1: +ctx.end, ...range, fmtX: fmtT, fmtY: (v) => `${Math.round(v)} ${unit}`, fmtV: (v) => `${n1(v)} ${unit}`, series: [{ name: title, color: C.sky, pts: rowsT(tr[id]) }] }, ctx), n > 1 ? `Average of ${n} devices` : n === 1 ? `From ${names[0]}` : ''));
  }
  const bd = ctx.breakdown;
  if (on('breakdown') && bd?.applies) blocks.push(card('breakdown', 12, 'Usage by device', `${bd.rows.some((x, i) => bd.rows[i + 1]?.depth > x.depth) ? '<div class="foldall"><button data-fold-all="open">Expand all</button><button data-fold-all="shut">Collapse all</button></div>' : ''}<table><thead><tr><th>Device</th><th>Energy</th><th>Share</th><th>Cost, ${ctx.vat}</th></tr></thead><tbody>${foldedRows(bd.rows, ctx.shut).map((x) => `<tr${x.kind === 'unmeasured' ? ' class="um"' : ''}><td style="padding-left:${8 + x.depth * 16}px">${x.parent ? `<button class="fold" data-fold="${x.id}" aria-expanded="${!x.shut}" aria-label="${x.shut ? 'Show' : 'Hide'} devices under ${x.name}">${x.shut ? '▸' : '▾'}</button>` : '<span class="nofold"></span>'}${x.name}${x.over ? ' (check wiring)' : ''}${x.partial ? ' (partial)' : ''}</td><td>${x.kwh == null ? (x.kind === 'unmeasured' ? 'Partial' : 'No reading') : `${n2(x.kwh)} kWh`}</td><td>${x.share == null ? '—' : `${Math.round(x.share * 100)}%`}</td><td>${x.kwh == null ? '—' : eur(x.kwh * ctx.tariff)}</td></tr>`).join('')}</tbody></table>`, 'Devices under another device are not added to the total'));
  if (on('savings')) blocks.push(card('savings', 12, 'Potential savings (estimate)', `<p class="note">Assumes half the always-on load can be cut, plus all weekday after-hours use above it, and projects this period to a full year. € ${ctx.vat}, at this period's average price.</p><table><thead><tr><th>Action</th><th>kWh a year</th><th>€ a year</th></tr></thead><tbody>${a.savings.map((s) => `<tr><td>${s.action}</td><td>${n0(s.kwh)}</td><td>${n0(s.eur)}</td></tr>`).join('')}</tbody></table>`));
  return `${on('kpis') ? `<div class="kpis">${kpi('Usage now', ctx.liveW == null ? 'No reading' : `${wText(ctx.liveW)}`, ctx.liveW == null ? ctx.liveLast : null, 'id="nowW"')}${kpi(`Usage ${ctx.period}`, `${n1(a.total)} kWh`, delta == null ? (ctx.noCompare ? 'Not compared: gaps in the data' : null) : `${delta > 0 ? '+' : ''}${delta}% ${ctx.prevLabel || 'vs previous period'}`)}${kpi('Cost', eur(a.cost), `${ctx.vat} · at € ${(+ctx.tariff).toFixed(3)}/kWh${ctx.varies ? ' on average' : ''}`)}${kpi('Average power', a.meanW == null ? '—' : `${wText(a.meanW)}`)}${kpi('Peak power', a.peak ? `${wText(a.peak.w)}` : '—', a.peak?.average ? `${peakAt}, average` : peakAt)}${kpi('Constant use', a.baseW == null ? '—' : `${wText(a.baseW)}`)}${kpi('Readings received', `${cover}%`, `Energy: ${a.covered} of ${allHours} hours`)}${bd?.applies ? kpi('Unmeasured', bd.gap ? 'Partial' : `${n1(bd.unmeasured)} kWh`, bd.gap ? 'A device has no reading' : bd.over ? 'Check wiring' : `${a.total > 0 ? Math.round((bd.unmeasured / a.total) * 100) : 0}% of energy`) : ''}</div>` : ''}<div class="grid">${blocks.join('')}</div>`;
}

// A4 at CSS pixels. Each page is one SVG, so it can be drawn to an image in the browser.
const PDF_W = 794, PDF_H = 1123, PDF_M = 32;
const pdfSvg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PDF_W} ${PDF_H}" width="${PDF_W}" height="${PDF_H}" font-family="Helvetica, Arial, sans-serif"><defs><linearGradient id="heatRamp">${HEAT_STOPS.map((c, i) => `<stop offset="${(i / (HEAT_STOPS.length - 1)) * 100}%" stop-color="${c}"/>`).join('')}</linearGradient></defs><rect width="${PDF_W}" height="${PDF_H}" fill="${C.page}"/>${body}</svg>`;
function pdfSummary(a, ctx) {
  const delta = ctx.prevTotal > 0 && !ctx.noCompare ? Math.round(((a.total - ctx.prevTotal) / ctx.prevTotal) * 100) : null;
  const allHours = heatCells(a, ctx.start, ctx.end, ctx.tz).reduce((n, r) => n + r.cells.length, 0);
  const peakAt = a.peak ? new Date(a.peak.t).toLocaleString('en-GB', { timeZone: ctx.tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return [
    [`Usage ${ctx.period}`, `${n1(a.total)} kWh`, delta == null ? (ctx.noCompare ? 'Not compared: gaps in the data' : 'No earlier data') : `${delta > 0 ? '+' : ''}${delta}% ${ctx.prevLabel || 'vs previous period'}`],
    ['Cost', eur(a.cost), `${ctx.vat} · at € ${(+ctx.tariff).toFixed(3)}/kWh${ctx.varies ? ' on average' : ''} (estimate)`],
    ['Average power', a.meanW == null ? '—' : `${wText(a.meanW)}`, 'Day and night'],
    ['Peak power', a.peak ? `${wText(a.peak.w)}` : '—', a.peak?.average ? `${peakAt}, average` : peakAt],
    ['Constant use', a.baseW == null ? '—' : `${wText(a.baseW)}`, 'When the office is empty'],
    ['Readings received', `${allHours ? Math.round((a.covered / allHours) * 100) : 0}%`, `Energy: ${a.covered} of ${allHours} hours`],
  ];
}
function pdfPages(a, ctx) {
  const c = ctx.svgs, tz = ctx.tz, CW = PDF_W - 2 * PDF_M, HALF = (CW - 12) / 2;
  const fmt = (t) => new Date(t).toLocaleString('en-GB', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const blocks = ctx.blockMeta.map((b) => {
    const s = c[b.id];
    // ponytail: a very long tree is cut to 40 rows in the PDF; split it across pages if a client needs more.
    if (b.id === 'breakdown') {
      const list = ctx.breakdown.rows.slice(0, 40);
      return { ...b, full: true, h: 56 + 16 * list.length, draw: (x, y) => `<text x="${x + 13}" y="${y + 40}" fill="${C.muted}" font-size="10">Device</text><text x="${x + CW - 110}" y="${y + 40}" text-anchor="end" fill="${C.muted}" font-size="10">Energy</text><text x="${x + CW - 13}" y="${y + 40}" text-anchor="end" fill="${C.muted}" font-size="10">Share</text>${list.map((r, i) => `<text x="${x + 13 + r.depth * 12}" y="${y + 58 + i * 16}" fill="${r.kind === 'unmeasured' ? C.muted : C.fg}" font-size="11">${r.name}${r.over ? ' (check wiring)' : ''}</text><text x="${x + CW - 110}" y="${y + 58 + i * 16}" text-anchor="end" fill="${C.fg}" font-size="11">${r.kwh == null ? '—' : `${n2(r.kwh)} kWh`}</text><text x="${x + CW - 13}" y="${y + 58 + i * 16}" text-anchor="end" fill="${C.muted}" font-size="11">${r.share == null ? '—' : `${Math.round(r.share * 100)}%`}</text>`).join('')}` };
    }
    if (b.id === 'savings') return { ...b, full: true, h: 42 + 18 * (a.savings.length + 2), draw: (x, y) => `<text x="${x + 13}" y="${y + 40}" fill="${C.muted}" font-size="10.5">Assumes half the always-on load can be cut, plus all weekday after-hours use above it, projected to a year.</text>${a.savings.map((r, i) => `<text x="${x + 13}" y="${y + 62 + i * 18}" fill="${C.fg}" font-size="12">${r.action}</text><text x="${x + CW - 13}" y="${y + 62 + i * 18}" text-anchor="end" fill="${C.fg}" font-size="12">${n0(r.kwh)} kWh · € ${n0(r.eur)}</text>`).join('')}<text x="${x + CW - 13}" y="${y + 62 + a.savings.length * 18}" text-anchor="end" fill="${C.gold}" font-size="13">Total € ${n0(a.saveEur)} a year</text>` };
    if (!s) return null;
    const full = b.span >= 8, w = full ? CW : HALF;
    const legendH = s.legend.length ? 16 : 0, keyH = s.heat ? 24 : 0, bodyH = s.h;
    return { ...b, full, h: 34 + legendH + bodyH + keyH + 10, draw: (x, y) => {
      let leg = '', lx = x + 13;
      for (const l of s.legend) { leg += `<circle cx="${lx + 4}" cy="${y + 39}" r="3.5" fill="${l.color}"/><text x="${lx + 12}" y="${y + 43}" fill="${C.muted}" font-size="10.5">${l.name}</text>`; lx += 24 + l.name.length * 5.6; }
      const top = y + 30 + legendH;
      if (s.donut) return `<g transform="translate(${x + 13},${top})">${s.svg}</g>${s.donut.map((d, i) => `<rect x="${x + 146}" y="${top + 28 + i * 24}" width="10" height="10" rx="2" fill="${d.color}"/><text x="${x + 162}" y="${top + 37 + i * 24}" fill="${C.fg}" font-size="11">${d.name}</text><text x="${x + w - 13}" y="${top + 37 + i * 24}" text-anchor="end" fill="${C.muted}" font-size="11">${d.value}</text>`).join('')}`;
      const key = s.heat ? `<rect x="${x + 13}" y="${top + bodyH + 5}" width="170" height="7" rx="2" fill="url(#heatRamp)"/>${s.heat.ticks.map((t, i) => `<text x="${x + 13 + (i / (s.heat.ticks.length - 1)) * 170}" y="${top + bodyH + 22}" text-anchor="${i === 0 ? 'start' : i === s.heat.ticks.length - 1 ? 'end' : 'middle'}" fill="${C.muted}" font-size="9.5">${t}</text>`).join('')}<text x="${x + 192}" y="${top + bodyH + 12}" fill="${C.muted}" font-size="10">kWh per ${s.heat.unit}</text>${s.heat.noRead ? `<rect x="${x + 270}" y="${top + bodyH + 4}" width="14" height="9" fill="url(#hatchNone)"/><text x="${x + 289}" y="${top + bodyH + 12}" fill="${C.muted}" font-size="10">No reading (${s.heat.noRead} ${s.heat.short})</text>` : ''}${s.heat.catchup ? `<rect x="${x + 388}" y="${top + bodyH + 4}" width="14" height="9" fill="url(#hatchCatch)"/><text x="${x + 407}" y="${top + bodyH + 12}" fill="${C.muted}" font-size="10">Catch-up (${s.heat.catchup} ${s.heat.short})</text>` : ''}` : '';
      return `${leg}<g transform="translate(${x + 13},${top})">${s.svg}</g>${key}`;
    } };
  }).filter(Boolean);
  if (a.days.length > 1 && a.days.length <= 31) {
    const max = Math.max(...a.days.map((d) => d.kwh), 0.01), rh = 15;
    blocks.push({ id: 'daily', title: 'Daily summary', full: true, h: 56 + a.days.length * rh, draw: (x, y) => `<text x="${x + 13}" y="${y + 44}" fill="${C.muted}" font-size="10">Day</text><text x="${x + 470}" y="${y + 44}" text-anchor="end" fill="${C.muted}" font-size="10">Energy</text><text x="${x + CW - 13}" y="${y + 44}" text-anchor="end" fill="${C.muted}" font-size="10">Cost, ${ctx.vat}</text>${a.days.map((d, i) => { const ty = y + 60 + i * rh; return `<text x="${x + 13}" y="${ty}" fill="${C.fg}" font-size="11">${fmtDay(d.day, { weekday: 'short', day: 'numeric', month: 'short' })}</text><rect x="${x + 110}" y="${ty - 8}" width="${(d.kwh / max) * 300}" height="9" rx="1.5" fill="${d.kwh === max ? C.gold : C.slate}"/><text x="${x + 470}" y="${ty}" text-anchor="end" fill="${C.fg}" font-size="11">${n2(d.kwh)} kWh</text><text x="${x + CW - 13}" y="${ty}" text-anchor="end" fill="${C.fg}" font-size="11">${eur(d.eur)}</text>`; }).join('')}` });
  }
  // Lay out in rows: a full-width block alone, half-width blocks in pairs. A half-width block left alone gets Key figures beside it.
  const keyFigures = () => {
    const sorted = [...a.days].sort((x, y) => y.kwh - x.kwh), hi = sorted[0], lo = sorted[sorted.length - 1];
    const top = [...a.hours].sort((x, y) => y.kwh - x.kwh)[0], main = [...a.phases].sort((x, y) => y.share - x.share)[0];
    const items = [
      hi && ['Highest usage day', `${fmtDay(hi.day, { weekday: 'short', day: 'numeric', month: 'short' })}, ${n1(hi.kwh)} kWh`],
      lo && a.days.length > 1 && ['Lowest usage day', `${fmtDay(lo.day, { weekday: 'short', day: 'numeric', month: 'short' })}, ${n1(lo.kwh)} kWh`],
      top && ['Busiest hour', `${fmtDay(top.day, { day: 'numeric', month: 'short' })}, ${String(top.hour).padStart(2, '0')}:00, ${n2(top.kwh)} kWh`],
      main && main.share > 0 && ['Largest phase', `Phase ${main.name}, ${main.share}%`],
      a.voltage && ['Voltage range', `${n1(a.voltage.min)} to ${n1(a.voltage.max)} V`],
      a.frequency && ['Frequency range', `${n1(a.frequency.min)} to ${n1(a.frequency.max)} Hz`],
    ].filter(Boolean);
    return { id: 'keyfigures', title: 'Key figures', full: false, h: 0, draw: (x, y) => items.map(([k, v], i) => `<text x="${x + 13}" y="${y + 46 + i * 22}" fill="${C.muted}" font-size="11">${k}</text><text x="${x + HALF - 13}" y="${y + 46 + i * 22}" text-anchor="end" fill="${C.fg}" font-size="11">${v}</text>`).join('') };
  };
  const rows = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.full) rows.push([b]); else { const n = blocks[i + 1]; if (n && !n.full) { rows.push([b, n]); i++; } else rows.push([b, keyFigures()]); }
  }
  const FIRST_TOP = 332, NEXT_TOP = 62, BOTTOM = PDF_H - 46, GAP = 10;
  const pages = [[]];
  let y = FIRST_TOP;
  for (const row of rows) {
    const h = Math.max(...row.map((b) => b.h));
    if (y + h > BOTTOM && pages[pages.length - 1].length) { pages.push([]); y = NEXT_TOP; }
    pages[pages.length - 1].push({ row, y, h });
    y += h + GAP;
  }
  const n = pages.length;
  const generated = fmt(ctx.generatedAt || Date.now());
  return pages.map((placed, pi) => {
    const footer = `<line x1="${PDF_M}" x2="${PDF_W - PDF_M}" y1="${PDF_H - 34}" y2="${PDF_H - 34}" stroke="${C.line}"/><text x="${PDF_M}" y="${PDF_H - 19}" fill="${C.muted}" font-size="9.5">Generated ${generated}${pi === n - 1 ? ' · Costs are estimates. A contract price may differ.' : ''}</text><text x="${PDF_W - PDF_M}" y="${PDF_H - 19}" text-anchor="end" fill="${C.muted}" font-size="9.5">Page ${pi + 1} of ${n}</text>`;
    let head;
    if (pi === 0) {
      const kpis = pdfSummary(a, ctx), tw = (CW - 2 * 10) / 3;
      head = `<rect width="${PDF_W}" height="6" fill="${C.gold}"/><text x="${PDF_M}" y="52" fill="${C.gold}" font-size="11" letter-spacing="1.4">ENERGY PERFORMANCE REPORT</text><text x="${PDF_M}" y="92" fill="${C.fg}" font-size="33" font-weight="600">${ctx.title}</text><text x="${PDF_M}" y="118" fill="${C.muted}" font-size="13">${ctx.location && ctx.location !== ctx.title ? `${ctx.location.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))} · ` : ''}${fmt(+ctx.start)} to ${fmt(+ctx.end)}</text><line x1="${PDF_M}" x2="${PDF_W - PDF_M}" y1="136" y2="136" stroke="${C.gold}"/>${kpis.map(([k, v, sub], i) => { const x = PDF_M + (i % 3) * (tw + 10), ty = 150 + Math.floor(i / 3) * 84; return `<rect x="${x}" y="${ty}" width="${tw}" height="74" rx="6" fill="${C.panel}" stroke="${C.line}"/><text x="${x + 13}" y="${ty + 21}" fill="${C.muted}" font-size="11">${k}</text><text x="${x + 13}" y="${ty + 46}" fill="${i === 1 ? C.gold : C.fg}" font-size="21" font-weight="600">${v}</text><text x="${x + 13}" y="${ty + 63}" fill="${C.muted}" font-size="10">${sub}</text>`; }).join('')}`;
    } else {
      head = `<rect width="${PDF_W}" height="6" fill="${C.gold}"/><text x="${PDF_M}" y="38" fill="${C.fg}" font-size="15" font-weight="600">${ctx.title}</text><text x="${PDF_W - PDF_M}" y="38" text-anchor="end" fill="${C.muted}" font-size="11">${fmt(+ctx.start)} to ${fmt(+ctx.end)}</text><line x1="${PDF_M}" x2="${PDF_W - PDF_M}" y1="48" y2="48" stroke="${C.line}"/>`;
    }
    const body = placed.map(({ row, y: ry, h }) => row.map((b, bi) => {
      const x = PDF_M + bi * (HALF + 12), w = b.full ? CW : HALF;
      return `<rect x="${x}" y="${ry}" width="${w}" height="${h}" rx="6" fill="${C.panel}" stroke="${C.line}"/><text x="${x + 13}" y="${ry + 21}" fill="${C.fg}" font-size="12.5" font-weight="600">${b.title}</text>${b.draw(x, ry)}`;
    }).join('')).join('');
    return pdfSvg(head + body + footer);
  });
}
// A PDF of full-page JPEG images, with no dependencies. pages: [{ jpeg: Uint8Array, w, h }] in pixels.
function buildPdf(pages, title) {
  const enc = (t) => { const b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i) & 255; return b; };
  const safe = String(title).replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '');
  const parts = [], offsets = [];
  let pos = 0;
  const push = (b) => { parts.push(b); pos += b.length; };
  push(enc('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
  const obj = (n, body, stream) => {
    offsets[n] = pos;
    if (stream) { push(enc(`${n} 0 obj\n<<${body} /Length ${stream.length}>>\nstream\n`)); push(stream); push(enc('\nendstream\nendobj\n')); } else push(enc(`${n} 0 obj\n${body}\nendobj\n`));
  };
  const first = 4, A4W = 595.28, A4H = 841.89;
  const kids = pages.map((_, i) => `${first + i * 3} 0 R`).join(' ');
  obj(1, '<</Type /Catalog /Pages 2 0 R>>');
  obj(2, `<</Type /Pages /Count ${pages.length} /Kids [${kids}]>>`);
  obj(3, `<</Title (${safe}) /Producer (Energy Portal)>>`);
  pages.forEach((p, i) => {
    const pg = first + i * 3, ct = pg + 1, im = pg + 2;
    obj(pg, `<</Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4W} ${A4H}] /Resources <</XObject <</Im0 ${im} 0 R>>>> /Contents ${ct} 0 R>>`);
    obj(ct, '', enc(`q ${A4W} 0 0 ${A4H} 0 0 cm /Im0 Do Q`));
    obj(im, ` /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, p.jpeg);
  });
  const total = first + pages.length * 3, xref = pos;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(enc(`${table}trailer\n<</Size ${total} /Root 1 0 R /Info 3 0 R>>\nstartxref\n${xref}\n%%EOF\n`));
  const out = new Uint8Array(pos);
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}

const STYLE = `
.locline{display:flex;margin:-6px 0 0}.rp{margin-top:-10px}@media(max-width:870px){.rp{margin-top:-16px;padding:0 4px 12px!important}.locline{margin:-10px 0 -10px}}.locline button{all:unset;cursor:pointer;display:inline-flex;align-items:center;max-width:100%}.locline button:hover .lp{background:color-mix(in srgb,var(--primary-text-color) 12%,transparent)}.locline button:focus-visible .lp{outline:2px solid var(--primary-color)}@media(pointer:coarse),(max-width:870px){.locline button{min-height:44px}}.lp{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px 0 7px;border-radius:14px;font-size:12.5px;font-weight:600;color:var(--primary-text-color);background:color-mix(in srgb,var(--primary-text-color) 7%,transparent);transition:background .15s}.lp ha-icon{--mdc-icon-size:15px;display:flex;color:var(--primary-color)}.lp ha-icon:last-child{color:var(--secondary-text-color)}
:host{display:block}
.rp{--page:var(--primary-background-color);--panel:var(--card-background-color);--line:var(--divider-color);--fg:var(--primary-text-color);--muted:var(--secondary-text-color);--accent:color-mix(in srgb,var(--primary-color) 82%,var(--primary-text-color));background:var(--page);color:var(--fg);padding:12px 16px;display:grid;gap:10px;font-family:var(--ha-font-family-body,Roboto,sans-serif);font-variant-numeric:tabular-nums;line-height:1.4;font-size:13px}
.controls{display:flex;gap:8px 10px;flex-wrap:wrap;align-items:center;position:relative}
.controls label{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted)}
.controls [hidden]{display:none}
select,input,button{font:inherit;font-size:12.5px;color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:5px 8px}
input[type=number]{width:58px}
button{cursor:pointer}button:hover,select:hover{border-color:var(--muted)}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.export{border-color:var(--accent);color:var(--accent)}
.spacer{flex:1}
.live{display:inline-flex;gap:6px;align-items:center;color:var(--muted);font-size:12px;white-space:nowrap}
.live i{width:8px;height:8px;border-radius:50%;background:var(--disabled-text-color)}.live.on i{background:var(--success-color)}
details{position:relative}summary{cursor:pointer;color:var(--accent);font-size:12.5px;padding:4px 2px}
@media(max-width:870px){.blocks{position:static!important;width:100%;box-sizing:border-box}.controls button,.controls select,.controls summary{min-height:44px;box-sizing:border-box}}
.blocks{position:absolute;right:0;z-index:6;margin-top:4px;background:var(--panel);border:1px solid var(--accent);border-radius:6px;padding:10px 12px;display:grid;gap:6px;min-width:220px}
.blocks label{color:var(--fg);cursor:pointer}.blocks input{accent-color:var(--accent)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:8px}
.kpi{background:var(--panel);border:1px solid color-mix(in srgb,var(--line) 60%,transparent);border-radius:14px;padding:10px 14px;display:grid;gap:1px;min-width:0;box-shadow:0 1px 2px rgba(0,0,0,.10),0 6px 20px rgba(0,0,0,.07)}
.kpi span{font-size:11.5px;color:var(--muted)}.kpi b{font-weight:650;letter-spacing:-.02em;font-size:21px;line-height:1.25;white-space:nowrap}.kpi small{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px 10px;display:grid;gap:4px;min-width:0;align-content:start}
.s4{grid-column:span 4}.s6{grid-column:span 6}.s8{grid-column:span 8}.s12{grid-column:span 12}
.rp,.out{grid-template-columns:minmax(0,1fr)}select{max-width:100%}
@media(max-width:760px){.s4,.s6,.s8,.s12{grid-column:span 12}}
.card header{display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
h3{margin:0;font-size:12.5px;font-weight:500}.card header span{font-size:11px;color:var(--muted)}
.note{margin:0;color:var(--muted);font-size:12px}
.plot{position:relative;touch-action:pan-y}.plot svg{display:block;max-width:100%;height:auto}
.plot[data-zoom] svg{cursor:crosshair}
svg text{font-family:inherit;user-select:none}
g.bar{cursor:default}g.bar[data-day]{cursor:zoom-in}g.bar.on rect:not(.hit){filter:brightness(1.35)}
rect.hc[data-day],rect.hc[data-hour]{cursor:zoom-in}rect.hc.on{stroke:var(--fg);stroke-width:1.5}
path.slice{cursor:pointer}path.slice.on{filter:brightness(1.25)}
.tip{position:absolute;z-index:5;background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:7px 10px;font-size:12px;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.45);min-width:150px;display:grid;gap:2px;white-space:nowrap}
.tip[hidden]{display:none}.tip b{font-weight:600}.tip em{font-style:normal;color:var(--accent)}.tip div{display:flex;justify-content:space-between;gap:16px}.tip div span:first-child{color:var(--muted)}.tip i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
.lg{display:flex;gap:4px;flex-wrap:wrap}.lg button{padding:1px 7px;font-size:11px;display:inline-flex;gap:4px;align-items:center;border-radius:10px}.lg button i{width:8px;height:8px;border-radius:50%}.lg button.off{opacity:.45;text-decoration:line-through}
.donut{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.donut .plot{flex:none}
ul{display:grid;gap:3px;margin:0;padding:0;list-style:none;flex:1;min-width:150px;font-size:12px}li{display:grid;grid-template-columns:9px 1fr auto;gap:7px;align-items:center}li i{width:9px;height:9px;border-radius:2px}
.fold{all:unset;cursor:pointer;display:inline-block;width:16px;text-align:center;color:var(--muted)}.fold:hover{color:var(--fg)}.fold:focus-visible{outline:2px solid var(--accent)}.nofold{display:inline-block;width:16px}.foldall{display:flex;gap:6px;justify-content:flex-end;padding-bottom:6px}.foldall button{font-size:12px;padding:3px 8px}tr.um td{color:var(--muted);font-style:italic}table{width:100%;border-collapse:collapse;font-size:12.5px}th{text-align:left;font-weight:400;color:var(--muted);font-size:11.5px;padding:0 0 4px;border-bottom:1px solid var(--line)}td{padding:4px 0;border-bottom:1px solid var(--line)}td+td,th+th{text-align:right;padding-left:14px}
.hkey{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:11px;color:var(--muted)}
.rampwrap{display:grid;gap:2px;width:170px}.ramp{display:block;height:7px;border-radius:2px;background:linear-gradient(90deg,#2f5fb3,#1f9bb0,#37b77f,#d9cf45,#f08a32,#e5484d)}.rlabels{display:flex;justify-content:space-between}
.k{display:inline-flex;gap:5px;align-items:center}.sw{width:15px;height:10px;border-radius:2px;display:inline-block}.sw.none{background:repeating-linear-gradient(45deg,var(--error-color) 0 2px,var(--panel) 2px 5px)}.sw.catch{background:repeating-linear-gradient(-45deg,var(--warning-color) 0 2px,var(--panel) 2px 5px)}
.state{padding:40px;text-align:center;color:var(--muted)}
.out{display:grid;gap:8px}
`;

if (typeof HTMLElement !== 'undefined') {
  const store = { get: () => { try { return JSON.parse(localStorage.getItem('energyReportCard')) || {}; } catch (e) { return {}; } }, set: (v) => { try { localStorage.setItem('energyReportCard', JSON.stringify(v)); } catch (e) { /* private window */ } } };
  class EnergyReportCard extends HTMLElement {
    setConfig(config) {
      this._cfg = { ...DEFAULTS, ...config };
      const saved = store.get();
      this._items = [];
      const v3 = saved.v >= 3;
      // Always opens on today, the same span as Overview's Today, so the two can be read side by side.
      this._p = { key: 'today', n: v3 && saved.p?.n ? saved.p.n : 12, unit: v3 && saved.p?.unit ? saved.p.unit : 'hours', from: '', to: '' };
      this._show = new Set(v3 && saved.show ? [...saved.show, ...(saved.v === 3 ? EXTRA_CHARTS.map(([b]) => b) : []), ...(saved.v < 5 ? ['breakdown'] : [])] : BLOCKS.map(([b]) => b).filter((b) => b !== 'savings'));
      this._hidden = new Set(); this._metric = 'kwh'; this._specs = {};
    }
    getCardSize() { return 20; }
    getGridOptions() { return { columns: 'full' }; }
    set hass(h) {
      this.style.colorScheme = h.themes?.darkMode ? 'dark' : 'light';
      this._hass = h;
      if (!this._built) { this._built = true; this._start(); return; }
      if (!this._ready) return;
      const el = this._out.querySelector('#nowW'), w = this._liveWatts();
      if (el) el.textContent = w == null ? 'No reading' : `${wText(w)}`;
    }
    _powerStates() { const item = this._items.find((i) => i.id === this._view); return (item?.meters || []).map((m) => this._hass.states[this._cfg.meters[m]?.power]); }
    // A value older than 15 minutes is not "now". Several meters add up, over those with a reading.
    _liveWatts() { const fresh = this._powerStates().filter((s) => Number.isFinite(parseFloat(s?.state)) && Date.now() - +new Date(s.last_updated) <= 15 * 60000); return fresh.length ? fresh.reduce((t, s) => t + parseFloat(s.state), 0) : null; }
    _liveLast() { const list = this._powerStates(), s = list[0], v = parseFloat(s?.state); return list.length === 1 && Number.isFinite(v) ? `Last ${wText(v)} at ${new Date(s.last_updated).toLocaleTimeString('en-GB', { timeZone: this._hass.config.time_zone, hour: '2-digit', minute: '2-digit' })}` : null; }
    disconnectedCallback() { clearInterval(this._timer); this._timer = null; this._ro?.disconnect(); }
    connectedCallback() { if (this._built) { if (!this._timer) this._startTimer(); this._ro?.observe(this._out); } }
    _startTimer() { this._timer = setInterval(() => { if (this._isLive && !this._busy()) this._load(); }, 60000); }
    _busy() { return this._hover || this._drag; }
    _save() { store.set({ v: 5, view: this._view, p: this._p, show: [...this._show] }); }
    // The list of meters lives in building-cards.js, which may load after this file.
    async _start() {
      await customElements.whenDefined('building-home-card');
      await window.portalTree.ensure(this._hass);
      this._cfg = { ...this._cfg, ...window.portalModel(this._hass) };
      this._items = this._cfg.views.flatMap((g) => g.items);
      const saved = store.get();
      this._view = this._items.some((i) => i.id === saved.view) ? saved.view : this._items[0]?.id;
      this._build();
      this._ready = true;
      if (this._items.length) this._load();
      else this._out.innerHTML = '<p class="state">No devices yet. In Home Assistant, give a device the energy-meter label.</p>';
    }
    _build() {
      const root = this.attachShadow({ mode: 'open' });
      const views = this._cfg.views.map((g) => `<optgroup label="${g.group}">${g.items.map((i) => `<option value="${i.id}"${i.meters.length ? '' : ' disabled'}>${i.name}</option>`).join('')}</optgroup>`).join('');
      const place = window.portalTree.location();
      root.innerHTML = `<style>${STYLE}</style><div class="rp">${place ? `<div class="locline"><button id="changeLocation" aria-label="Change location"><span class="lp"><ha-icon icon="mdi:map-marker-outline"></ha-icon>${place.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}<ha-icon icon="mdi:chevron-down"></ha-icon></span></button></div>` : ''}<div class="controls">
        <select id="view" aria-label="View">${views}</select>
        <select id="period" aria-label="Period"><option value="today">Today</option>${PERIODS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}<option value="month">This month</option><option value="lastmonth">Last month</option><option value="last">Custom, up to now</option><option value="range">Date range</option></select>
        <label class="c-last">Last<input id="n" type="number" min="1" step="1" aria-label="Amount"><select id="unit" aria-label="Unit"><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select></label>
        <label class="c-range">From<input id="from" type="datetime-local"></label><label class="c-range">To<input id="to" type="datetime-local"></label>
        <button id="back" hidden>Reset zoom</button><span class="spacer"></span><span class="live" id="live"><i></i><span></span></span>
        <button class="export" id="pdf">Export PDF</button>
        <details><summary>Customise</summary><div class="blocks">${BLOCKS.filter(([b]) => this._hass?.user?.is_admin || !TECH_BLOCKS.has(b)).map(([b, n]) => `<label><input type="checkbox" data-block="${b}">${n}</label>`).join('')}</div></details>
      </div><div id="out" class="out"><p class="state">Loading…</p></div></div>`;
      const $ = (id) => root.getElementById(id);
      this._out = $('out'); this._root = root;
      $('view').value = this._view;
      const sync = () => {
        const p = this._p; $('period').value = p.key; $('n').value = p.n; $('unit').value = p.unit; $('from').value = p.from; $('to').value = p.to;
        root.querySelectorAll('.c-last').forEach((e) => { e.hidden = p.key !== 'last'; });
        root.querySelectorAll('.c-range').forEach((e) => { e.hidden = p.key !== 'range'; });
        $('back').hidden = !this._before;
      };
      this._sync = sync; sync();
      const changed = () => { this._before = null; sync(); this._save(); this._load(); };
      $('view').addEventListener('change', (e) => { this._view = e.target.value; this._save(); this._load(); });
      $('period').addEventListener('change', (e) => {
        this._p.key = e.target.value;
        if (e.target.value === 'range' && !this._p.from) { const now = Date.now(), tz = this._hass.config.time_zone; this._p.from = localInput(now - 86400000, tz); this._p.to = localInput(now, tz); }
        changed();
      });
      $('n').addEventListener('change', (e) => { this._p.n = Number(e.target.value); changed(); });
      $('unit').addEventListener('change', (e) => { this._p.unit = e.target.value; changed(); });
      $('from').addEventListener('change', (e) => { this._p.from = e.target.value; changed(); });
      $('to').addEventListener('change', (e) => { this._p.to = e.target.value; changed(); });
      $('back').addEventListener('click', () => { this._p = this._before; this._before = null; sync(); this._save(); this._load(); });
      $('pdf').addEventListener('click', () => this._exportPdf());
      root.querySelectorAll('[data-block]').forEach((c) => {
        c.checked = this._show.has(c.dataset.block);
        c.addEventListener('change', () => { if (c.checked) this._show.add(c.dataset.block); else this._show.delete(c.dataset.block); this._save(); this._paint(); });
      });
      const o = this._out;
      o.addEventListener('pointermove', (e) => this._move(e));
      o.addEventListener('pointerleave', () => this._leave());
      o.addEventListener('pointerdown', (e) => this._down(e));
      window.addEventListener('pointerup', (e) => this._up(e));
      o.addEventListener('click', (e) => this._click(e));
      this._ro = new ResizeObserver(() => { const w = o.clientWidth; if (w && w !== this._w) { this._w = w; if (this._last && !this._busy()) this._paint(); } });
      this._ro.observe(o);
      this._startTimer();
    }
    _zoom(start, end) {
      const tz = this._hass.config.time_zone;
      if (!this._before) this._before = { ...this._p };
      this._p = { ...this._p, key: 'range', from: localInput(start, tz), to: localInput(end, tz) };
      this._sync(); this._load();
    }
    _click(e) {
      const q = (s) => e.target.closest(s);
      let b;
      if ((b = q('[data-series]'))) { const k = b.dataset.series; if (this._hidden.has(k)) this._hidden.delete(k); else this._hidden.add(k); this._paint(); return; }
      if ((b = q('[data-metric]'))) { this._metric = b.dataset.metric; this._paint(); return; }
      if ((b = q('[data-fold]'))) { const id = b.dataset.fold; if (this._shut.has(id)) this._shut.delete(id); else this._shut.add(id); this._paint(); return; }
      if ((b = q('[data-fold-all]'))) { const rows = this._last?.ctx.breakdown?.rows || []; this._shut = new Set(b.dataset.foldAll === 'shut' ? rows.filter((x, i) => rows[i + 1]?.depth > x.depth).map((x) => x.id) : []); this._paint(); return; }
      const hourCell = q('[data-hour]');
      if (hourCell) { const t = +hourCell.dataset.hour; this._hover = false; this._zoom(t, Math.min(t + HOUR, Date.now())); return; }
      const day = q('[data-day]');
      if (day) {
        const [y, m, d] = day.dataset.day.split('-').map(Number), tz = this._hass.config.time_zone;
        this._hover = false;
        this._zoom(+zonedTime(y, m - 1, d, tz), Math.min(+zonedTime(y, m - 1, d + 1, tz), Date.now()));
      }
    }
    _tip(box, html, cx, cy) {
      const t = box.querySelector('.tip'); if (!t) return;
      t.innerHTML = html; t.hidden = false;
      const b = box.getBoundingClientRect();
      t.style.left = `${Math.max(0, Math.min(b.width - t.offsetWidth, cx - b.left - t.offsetWidth / 2))}px`;
      const above = cy - b.top - t.offsetHeight - 10;
      t.style.top = `${above >= 0 ? above : cy - b.top + 14}px`;
    }
    _move(e) {
      const box = e.target.closest && e.target.closest('.plot');
      if (!box) { this._leave(); return; }
      const id = box.dataset.chart, spec = this._specs[id];
      if (!spec) return;
      this._hover = true;
      const html = (t) => `<b>${t.when}</b>${t.note ? `<em>${t.note}</em>` : ''}${t.status ? `<em>${t.status}</em>` : ''}${t.rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('')}`;
      if (spec.kind === 'line') {
        const svg = box.querySelector('svg'), r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, x = ((e.clientX - r.left) / r.width) * vb.width;
        const inv = spec.x0 + ((x - spec.l) / (spec.r - spec.l)) * (spec.x1 - spec.x0);
        if (this._drag && this._drag.id === id) { const a = Math.min(this._drag.x, x), w = Math.abs(x - this._drag.x), br = svg.querySelector('.brush'); br.setAttribute('x', a); br.setAttribute('width', w); br.setAttribute('visibility', 'visible'); this._drag.cur = x; return; }
        if (!spec.xs.length) return;
        let lo = 0, hi = spec.xs.length - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (spec.xs[m] < inv) lo = m; else hi = m; }
        const xv = Math.abs(spec.xs[lo] - inv) < Math.abs(spec.xs[hi] - inv) ? spec.xs[lo] : spec.xs[hi];
        const xh = svg.querySelector('.xh'); xh.setAttribute('x1', spec.px(xv)); xh.setAttribute('x2', spec.px(xv)); xh.setAttribute('visibility', 'visible');
        const rows = [], dots = [];
        for (const s of spec.series) {
          const p = s.pts.find((q) => q.x === xv); if (!p) continue;
          rows.push(`<div><span><i style="background:${s.color}"></i>${s.name}</span><span>${spec.fmtV(p.y)}</span></div>`);
          if (p.max != null && s.band) rows.push(`<div><span>High</span><span>${spec.fmtV(p.max)}</span></div><div><span>Low</span><span>${spec.fmtV(p.min)}</span></div>`);
          dots.push(`<circle cx="${spec.px(xv)}" cy="${spec.py(p.y)}" r="3" fill="${s.color}" stroke="${C.fg}"/>`);
        }
        svg.querySelector('.dots').innerHTML = dots.join('');
        this._tip(box, `<b>${spec.fmtX(xv)}</b>${rows.join('')}`, r.left + (spec.px(xv) / vb.width) * r.width, e.clientY);
        return;
      }
      box.querySelectorAll('.on').forEach((x) => x.classList.remove('on'));
      if (spec.kind === 'heat') {
        const c = e.target.closest('rect.hc');
        if (!c) { box.querySelector('.tip').hidden = true; return; }
        c.classList.add('on');
        const cell = spec.cells[+c.dataset.i], a = c.getBoundingClientRect();
        this._tip(box, html(cellTip(cell, this._last.ctx)), a.left + a.width / 2, a.top);
        return;
      }
      const hit = e.target.closest('rect.hit, path.slice');
      if (!hit) { box.querySelector('.tip').hidden = true; return; }
      (hit.closest('g.bar') || hit).classList.add('on');
      this._tip(box, html(spec.tips[+hit.dataset.i]), e.clientX, e.clientY);
    }
    _leave() {
      this._hover = false;
      this._out.querySelectorAll('.tip').forEach((t) => { t.hidden = true; });
      this._out.querySelectorAll('.xh').forEach((x) => x.setAttribute('visibility', 'hidden'));
      this._out.querySelectorAll('.dots').forEach((d) => { d.innerHTML = ''; });
      this._out.querySelectorAll('.on').forEach((x) => x.classList.remove('on'));
    }
    _down(e) {
      const box = e.target.closest('.plot[data-zoom]'); if (!box) return;
      const svg = box.querySelector('svg'), r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
      this._drag = { id: box.dataset.chart, x: ((e.clientX - r.left) / r.width) * vb.width, svg };
      e.preventDefault();
    }
    _up() {
      const d = this._drag; if (!d) return;
      this._drag = null;
      d.svg.querySelector('.brush')?.setAttribute('visibility', 'hidden');
      if (d.cur == null || Math.abs(d.cur - d.x) < 8) return;
      const s = this._specs[d.id], inv = (x) => s.x0 + ((x - s.l) / (s.r - s.l)) * (s.x1 - s.x0);
      const a = inv(Math.min(d.x, d.cur)), b = inv(Math.max(d.x, d.cur));
      if (b - a >= 5 * 60000) this._zoom(a, b);
    }
    _download(blob, name) {
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name;
      this._root.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    async _pdfBytes() {
      const widthFor = (span) => (span >= 8 ? 704 : 333);
      const ctx = { ...this._last.ctx, show: this._show, hidden: this._hidden, metric: this._metric, specs: {}, widthFor, liveW: null, svgs: {}, blockMeta: [], generatedAt: Date.now(), pdf: true };
      renderReport(this._last.a, ctx);
      const pagesSvg = pdfPages(this._last.a, ctx), scale = 2, pages = [], themed = getComputedStyle(this);
      for (const svg of pagesSvg) {
        // An image can't see the page's theme, so its colours are filled in here.
        const src = svg.replace(`width="${PDF_W}" height="${PDF_H}"`, `width="${PDF_W * scale}" height="${PDF_H * scale}"`).replace(/var\((--[\w-]+)\)/g, (_, v) => PDF_COLOURS[v] || themed.getPropertyValue(v).trim()).replace(/&(?!(?:[a-z]+|#\d+|#x[\da-f]+);)/gi, '&amp;');
        const img = new Image();
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`;
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = PDF_W * scale; cv.height = PDF_H * scale;
        const g = cv.getContext('2d');
        g.fillStyle = PDF_COLOURS['--primary-background-color']; g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0, cv.width, cv.height);
        const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.93));
        pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height });
      }
      return { bytes: buildPdf(pages, `Energy report - ${ctx.title}`), pagesSvg, ctx };
    }
    async _exportPdf() {
      if (!this._last) return;
      const btn = this._root.getElementById('pdf');
      btn.disabled = true; btn.textContent = 'Creating PDF…';
      try {
        const { bytes, ctx } = await this._pdfBytes();
        const stamp = (t) => localInput(+t, ctx.tz).slice(0, 10);
        this._download(new Blob([bytes], { type: 'application/pdf' }), `energy-report-${this._view}-${stamp(ctx.start)}-to-${stamp(ctx.end)}.pdf`);
        btn.textContent = 'Export PDF';
      } catch (e) {
        btn.textContent = 'PDF failed, try again';
      }
      btn.disabled = false;
    }
    _paint() {
      if (!this._last) return;
      const w = this._out.clientWidth || 1000, gap = 8, pad = 22, unit = (w - 11 * gap) / 12, phone = w < 700;
      const widthFor = (span) => Math.round(phone ? w - pad : span * unit + (span - 1) * gap - pad);
      // A long tree opens three levels deep; after that it stays as it was left, through each live refresh.
      if (this._shutFor !== this._view) { const rows = this._last.ctx.breakdown?.rows; if (rows) { this._shutFor = this._view; this._shut = new Set(rows.filter((x, i) => x.depth >= 2 && rows[i + 1]?.depth > x.depth).map((x) => x.id)); } }
      const ctx = { ...this._last.ctx, show: this._show, hidden: this._hidden, metric: this._metric, specs: {}, widthFor, liveW: this._liveWatts(), liveLast: this._liveLast(), shut: this._shut };
      this._out.innerHTML = this._last.a.hours.length ? renderReport(this._last.a, ctx) : '<p class="state">No device data for this selection.</p>';
      this._specs = ctx.specs;
      const el = this._root.getElementById('live'), tz = ctx.tz;
      el.className = `live${this._isLive ? ' on' : ''}`;
      el.querySelector('span').textContent = `${this._isLive ? 'Live, updated' : 'Fixed period, loaded'} ${new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' })}`;
    }
    async _load() {
      if (!this._items.length) return;
      const h = this._hass, c = this._cfg, tz = h.config.time_zone, seq = (this._seq = (this._seq || 0) + 1), now = Date.now();
      const item = this._items.find((i) => i.id === this._view), meters = item.meters.map((m) => c.meters[m]);
      // Devices further down the tree are read too, only to show how much of the energy they account for.
      const roots = item.roots || [], below = window.portalTree.subtree(roots).filter((id) => !item.meters.includes(id)).map((id) => c.meters[id]).filter(Boolean);
      const { start, end, live } = periodRange(this._p, now, tz);
      this._isLive = live;
      if (!(+end > +start)) { this._last = null; this._out.innerHTML = '<p class="state">Choose a valid period. The start must be before the end.</p>'; return; }
      const span = +end - +start, fine = span <= 48 * HOUR, step = fine ? 5 * 60000 : HOUR, today = this._p.key === 'today', shown = today ? HOUR : chartStep(span);
      // Today compares with yesterday up to the same time, not with the hours just before midnight.
      const prevFrom = today ? +start - 24 * HOUR : +start - span;
      const extraIds = (m) => EXTRA_CHARTS.map(([k]) => m[k]).filter(Boolean);
      // Not every device has every reading, and Home Assistant rejects the whole request over one empty id.
      const ids = [...new Set([...meters.flatMap((m) => [m.energy, m.power, m.frequency, ...m.voltages, ...Object.values(m.phases || {}), ...extraIds(m)]), ...below.flatMap((m) => [m.energy, m.power])])].filter(Boolean);
      const phaseIds = meters.length === 1 ? Object.entries(meters[0].phases || {}) : [];
      const liveIds = [...new Set(meters.flatMap((m) => [m.power, m.frequency, ...m.voltages, ...extraIds(m)]))].filter(Boolean), tempIds = new Set(meters.map((m) => m.temperature));
      const powerIds = new Set(meters.map((m) => m.power));
      try {
        const hourStart = now - (now % HOUR), liveHour = live && +start <= hourStart;
        const [s, prev, raw, rawPrev, rawHour] = await Promise.all([
          h.callWS({ type: 'recorder/statistics_during_period', start_time: start.toISOString(), end_time: end.toISOString(), statistic_ids: ids, period: fine ? '5minute' : 'hour', types: ['change', 'mean', 'min', 'max', 'state'] }),
          h.callWS({ type: 'recorder/statistics_during_period', start_time: new Date(prevFrom).toISOString(), end_time: new Date(prevFrom + span).toISOString(), statistic_ids: meters.flatMap((m) => [m.energy, m.power]), period: fine ? '5minute' : 'hour', types: ['change', 'min', 'max'] }),
          shown === 60000 ? h.callWS({ type: 'history/history_during_period', start_time: start.toISOString(), end_time: end.toISOString(), entity_ids: [...liveIds, ...meters.map((m) => m.energy), ...phaseIds.map(([, id]) => id)], minimal_response: true, no_attributes: true, significant_changes_only: false }) : null,
          shown === 60000 ? h.callWS({ type: 'history/history_during_period', start_time: new Date(+start - span).toISOString(), end_time: start.toISOString(), entity_ids: meters.map((m) => m.energy), minimal_response: true, no_attributes: true, significant_changes_only: false }) : null,
          liveHour ? h.callWS({ type: 'history/history_during_period', start_time: new Date(hourStart).toISOString(), end_time: new Date(now).toISOString(), entity_ids: [...meters, ...below].map((m) => m.energy), minimal_response: true, no_attributes: true, significant_changes_only: false }) : null,
        ]);
        if (seq !== this._seq) return;
        const info = window.portalPriceInfo ? window.portalPriceInfo(h) : { now: parseFloat(h.states[c.tariff]?.state) || 0, vat: 'VAT not stated' };
        const priceAt = window.portalPriceSeries ? await window.portalPriceSeries(h, prevFrom, +end) : null, tariff = priceAt || info.now;
        const one = meters.length === 1;
        // Each meter gets its own checks first, because catch-ups and stuck power belong to a meter, not to a total.
        const spread = window.spreadCatchUp || ((e) => e);
        const measure = (m) => {
          const st = statsFor([m], { ...s, [m.energy]: spread(s[m.energy] || [], s[m.power] || [], step) });
          // Statistics lag behind. Add what the meter has counted since the last finished row.
          if (live && st.energy.length) {
            const last = st.energy[st.energy.length - 1], reading = parseFloat(h.states[m.energy]?.state), v = reading - last.state;
            if (Number.isFinite(v) && v > 0 && v < 20) {
              const t = +new Date(last.start) + step, w = parseFloat(h.states[m.power]?.state);
              st.energy = [...st.energy, { start: t, change: v, state: reading }];
              if (Number.isFinite(w)) st.power = [...st.power, { start: t, mean: w, min: w, max: w }];
            }
          }
          const rows = fine ? { energy: toHourly(st.energy), power: toHourly(st.power), frequency: toHourly(st.frequency), ...Object.fromEntries(EXTRA_CHARTS.map(([k]) => [k, toHourly(st[k])])), voltages: st.voltages.map(toHourly), phases: Object.fromEntries(Object.entries(st.phases).map(([k, v]) => [k, toHourly(v)])) } : st;
          if (rawHour) rows.energy = [...rows.energy.filter((r) => +new Date(r.start) < hourStart), { start: hourStart, change: hourSoFar(readingPts(rawHour[m.energy])) }];
          const stuckSet = stuckHours(rows.power, +new Date(h.states[m.power]?.last_updated), now);
          return { m, rows, stuck: stuckSet, a: analyse(rows, tariff, tz, { stuck: stuckSet, start: +start, end: +end }) };
        };
        const perMeter = meters.map(measure), everyDevice = [...perMeter, ...below.map(measure)];
        // A Shelly with statistics but no change really used nothing, such as a light that stayed off. Other devices stay unknown without a reading.
        const kwhOf = (id) => { const p = everyDevice.find((x) => x.m.id === id); if (!p) return null; return p.a.hours.length ? p.a.total : p.m.shelly && s[p.m.energy]?.length ? 0 : null; };
        const breakdown = window.portalTree.breakdown(roots, kwhOf, live ? (id) => window.portalTree.silent(id, h.states, now) : () => false);
        const sumHours = (list) => { const at = new Map(); for (const x of list) for (const hr of x.hours) at.set(hr.t, (at.get(hr.t) || 0) + hr.kwh); return [...at].sort(([u], [w]) => u - w).map(([t, change]) => ({ start: t, change })); };
        const keep = (p, rows) => rows.filter((r) => !p.stuck.has(+new Date(r.start)));
        const hourly = one ? perMeter[0].rows : {
          energy: sumHours(perMeter.map((p) => p.a)),
          power: combine(perMeter.map((p) => keep(p, p.rows.power))),
          frequency: averageRows(perMeter.map((p) => keep(p, p.rows.frequency))),
          ...Object.fromEntries(EXTRA_CHARTS.map(([k]) => [k, averageRows(perMeter.filter((p) => p.m[k]).map((p) => keep(p, p.rows[k])))])),
          voltages: [averageRows(perMeter.map((p) => averageRows(p.rows.voltages.map((v) => keep(p, v)))))],
          phases: {},
        };
        const stuck = one ? perMeter[0].stuck : new Set();
        const real = (rows) => rows.filter((r) => !stuck.has(+new Date(r.start)));
        const a = one ? perMeter[0].a : analyse(hourly, tariff, tz, { trusted: true, start: +start, end: +end });
        if (!one) for (const p of perMeter) for (const [t, kwh] of p.a.caught) if (!a.hours.some((x) => x.t === t)) a.caught.set(t, (a.caught.get(t) || 0) + kwh);

        const prevEach = meters.map((m) => {
          const st = statsFor([m], prev), energy = fine ? toHourly(st.energy) : st.energy, power = fine ? toHourly(st.power) : st.power;
          return analyse({ energy, power, phases: {}, voltages: [], frequency: [] }, tariff, tz, { stuck: stuckHours(power, Infinity, now), start: prevFrom, end: prevFrom + span });
        });
        const prevRows = sumHours(prevEach), prevTotal = prevEach.reduce((t, x) => t + x.total, 0);
        // Totals with different amounts of missing data can't be compared fairly.
        const hoursInSpan = Math.max(1, Math.ceil(span / HOUR)), noCompare = a.hours.length / hoursInSpan < 0.9 || prevRows.length / hoursInSpan < 0.9;
        const bucket = (rows) => (shown === HOUR ? real(rows) : toDaily(real(rows).filter((r) => { const t = +new Date(r.start); return a.valid.has(t - (t % HOUR)); }), tz));
        // Temperature rarely changes, so its last value holds for longer.
        const minuteOfId = (id) => minuteRows(raw[id], +start, +end, powerIds.has(id) ? 0 : tempIds.has(id) ? HOUR : 10 * 60000);
        const meterPts = (hist) => (hist ? sumMeterPts(meters.map((m) => readingPts(hist[m.energy]).filter((p) => Number.isFinite(p.v)))) : []);
        const minutes = raw ? Object.fromEntries(liveIds.map((id) => [id, minuteOfId(id)])) : null;
        const lines = !raw ? { power: bucket(hourly.power), voltages: hourly.voltages.map(bucket), frequency: bucket(hourly.frequency), ...Object.fromEntries(EXTRA_CHARTS.map(([k]) => [k, bucket(hourly[k])])) }
          : one ? statsFor(meters, minutes)
            : { power: combine(meters.map((m) => minutes[m.power])), frequency: averageRows(meters.map((m) => minutes[m.frequency])), ...Object.fromEntries(EXTRA_CHARTS.map(([k]) => [k, averageRows(meters.filter((m) => m[k]).map((m) => minutes[m[k]]))])), voltages: [averageRows(meters.map((m) => averageRows(m.voltages.map((id) => minutes[id]))))] };
        if (raw) {
          const rows = lines.power.filter((r) => r.mean != null), top = rows.reduce((b, r) => (b && peakOf(b) >= peakOf(r) ? b : r), null);
          a.meanW = rows.length ? Math.round(rows.reduce((t, r) => t + r.mean, 0) / rows.length) : null;
          a.peak = top && { w: Math.round(peakOf(top)), t: top.start, average: !!top.combined };
        }
        const phases = raw ? Object.fromEntries(phaseIds.map(([k, id]) => [k, minuteEnergy(raw[id], +start, +end)])) : hourly.phases;
        const counted = new Map();
        if (raw) for (const m of meters) for (const r of minuteEnergy(raw[m.energy], +start, +end)) counted.set(r.start, (counted.get(r.start) || 0) + r.change);
        this._last = { a, ctx: { tz, start, end, client: !h.user?.is_admin, tariff: a.price, priceAt: priceAt || (() => info.now), vat: info.vat, varies: !!priceAt?.varies, period: periodName(this._p), title: item.name, location: window.portalTree.location(), meterCount: meters.length, prevRows, prevTotal, noCompare, breakdown, extraMeters: Object.fromEntries(EXTRA_CHARTS.map(([k]) => [k, meters.filter((m) => m[k]).map((m) => m.name)])), ...(today ? { prevStart: prevFrom, prevLabel: 'vs this time yesterday' } : {}), trends: { step: shown, power: lines.power, voltages: lines.voltages, frequency: lines.frequency, ...Object.fromEntries(EXTRA_CHARTS.map(([k]) => [k, meters.some((m) => m[k]) && (k !== 'linkQuality' || one) ? lines[k] : null])), phases, minuteEnergy: [...counted].sort(([u], [w]) => u - w).map(([start, change]) => ({ start, change })), energyPts: meterPts(raw), prevEnergyPts: meterPts(rawPrev) } } };
        this._paint();
      } catch (e) {
        console.error('Energy report', e);
        if (seq === this._seq) this._out.innerHTML = '<p class="state">Could not load the data. Refresh the page to try again.</p>';
      }
    }
  }
  if (!customElements.get('energy-report-card')) customElements.define('energy-report-card', EnergyReportCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'energy-report-card', name: 'Energy report', description: 'Live energy, cost and power report.' });
}

if (typeof module !== 'undefined') module.exports = { periodName, minuteEnergy, hourSoFar, averageRows, sumMeterPts, stuckHours, heatGrid, chartStep, minuteRows, readingPts, toDaily, pdfPages, pdfSummary, buildPdf, analyse, periodRange, renderReport, statsFor, combine, heatCells, heatScale, cellTip, toHourly, dailyProfile, weekdayAverages, durationCurve, cumulativeSeries, niceMax, localInput, parseInput, DEFAULTS, BLOCKS };
