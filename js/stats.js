/* Aggregations and SVG charts for the Stats view. */
(function () {
  'use strict';

  const DAY_MS = 86400000;

  function pad(n) { return String(n).padStart(2, '0'); }

  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function shiftDay(ts, n) {
    const d = new Date(ts);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h) return h + 'h ' + pad(m) + 'm';
    if (m) return m + 'm';
    return sec + 's';
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return (h ? h + ':' + pad(m) : m) + ':' + pad(sec % 60);
  }

  /* Locale-independent "10/3 13:32" so the English UI stays English. */
  function fmtWhen(ts) {
    const d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  const byStart = (a, b) => a.startAt - b.startAt;

  const Stats = {
    dayKey, fmtDur, fmtClock, fmtWhen, fmtDate, startOfDay,

    sessionStreak(sessions) {
      const list = sessions.slice().sort(byStart);
      let best = 0, run = 0;
      list.forEach(s => {
        run = s.aborted ? 0 : run + 1;
        best = Math.max(best, run);
      });
      return { current: run, best };
    },

    dailyStreak(sessions, goal) {
      goal = Math.max(1, goal || 1);
      const counts = {};
      sessions.forEach(s => { if (!s.aborted) counts[dayKey(s.startAt)] = (counts[dayKey(s.startAt)] || 0) + 1; });
      const hit = ts => (counts[dayKey(ts)] || 0) >= goal;

      let cur = 0;
      let d = Date.now();
      if (!hit(d)) d = shiftDay(d, -1);
      while (hit(d)) { cur++; d = shiftDay(d, -1); }

      const days = Object.keys(counts).filter(k => counts[k] >= goal).sort();
      let best = 0, run = 0, prev = null;
      days.forEach(k => {
        const ts = new Date(k + 'T00:00:00').getTime();
        run = prev !== null && dayKey(shiftDay(prev, 1)) === k ? run + 1 : 1;
        best = Math.max(best, run);
        prev = ts;
      });
      return { current: cur, best: Math.max(best, cur) };
    },

    onTimeStreak(breaks) {
      const list = breaks.slice().sort(byStart);
      let best = 0, run = 0;
      list.forEach(b => {
        run = b.overtimeSec === 0 && b.endedBy !== 'abandoned' ? run + 1 : 0;
        best = Math.max(best, run);
      });
      return { current: run, best };
    },

    reviewCounts(sessions) {
      const c = { yes: 0, partial: 0, no: 0, reviewed: 0 };
      sessions.forEach(s => {
        if (s.aborted || !s.result) return;
        c[s.result]++;
        c.reviewed++;
      });
      c.rate = c.reviewed ? c.yes / c.reviewed : null;
      return c;
    },

    perTask(data) {
      return data.tasks.map(t => {
        const ss = data.sessions.filter(s => s.taskId === t.id);
        const done = ss.filter(s => !s.aborted);
        const focusSec = ss.reduce((a, s) => a + (s.actualSec || 0), 0);
        let withinEstimate = null;
        if (t.status === 'done') withinEstimate = done.length <= t.estSessions;
        return {
          task: t,
          sessionsDone: done.length,
          aborted: ss.length - done.length,
          focusSec,
          review: Stats.reviewCounts(ss),
          withinEstimate
        };
      });
    },

    inRange(list, days) {
      if (!days) return list;
      const from = startOfDay(shiftDay(Date.now(), -(days - 1)));
      return list.filter(x => x.startAt >= from);
    },

    daySeries(data, days) {
      if (!days) {
        const first = Math.min(
          ...data.sessions.map(s => s.startAt),
          ...data.breaks.map(b => b.startAt),
          Date.now()
        );
        days = Math.min(90, Math.max(7, Math.round((startOfDay(Date.now()) - startOfDay(first)) / DAY_MS) + 1));
      }
      const out = [];
      const index = {};
      for (let i = days - 1; i >= 0; i--) {
        const ts = shiftDay(startOfDay(Date.now()), -i);
        const row = { key: dayKey(ts), ts, focusSec: 0, overSec: 0, sessions: 0 };
        index[row.key] = row;
        out.push(row);
      }
      data.sessions.forEach(s => {
        const row = index[dayKey(s.startAt)];
        if (!row) return;
        row.focusSec += s.actualSec || 0;
        if (!s.aborted) row.sessions++;
      });
      data.breaks.forEach(b => {
        const row = index[dayKey(b.startAt)];
        if (row) row.overSec += b.overtimeSec || 0;
      });
      return out;
    },

    today(data) {
      const from = startOfDay(Date.now());
      const ss = data.sessions.filter(s => s.startAt >= from);
      const bs = data.breaks.filter(b => b.startAt >= from);
      return {
        sessions: ss.filter(s => !s.aborted).length,
        focusSec: ss.reduce((a, s) => a + (s.actualSec || 0), 0),
        overSec: bs.reduce((a, b) => a + (b.overtimeSec || 0), 0)
      };
    },

    doomscroll(breaks) {
      const total = breaks.reduce((a, b) => a + (b.overtimeSec || 0), 0);
      const over = breaks.filter(b => b.overtimeSec > 0);
      return {
        breaks: breaks.length,
        totalSec: total,
        avgSec: breaks.length ? total / breaks.length : 0,
        overCount: over.length,
        locks: breaks.filter(b => b.locked).length,
        ringsIgnored: breaks.reduce((a, b) => a + (b.ringsIgnored || 0), 0),
        longestSec: breaks.reduce((a, b) => Math.max(a, b.overtimeSec || 0), 0),
        abandoned: breaks.filter(b => b.endedBy === 'abandoned').length
      };
    },

    /* Single-series bar chart. values: [{label, value, tip}] */
    barChart(values, opts) {
      const W = 720, H = 200, L = 40, R = 8, T = 12, B = 26;
      const max = niceMax(Math.max(1, ...values.map(v => v.value)));
      const n = values.length;
      const band = (W - L - R) / n;
      const bw = Math.max(3, Math.min(22, band * 0.62));
      const y = v => T + (H - T - B) * (1 - v / max);
      let svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + opts.title + '">';
      [0, 0.5, 1].forEach(f => {
        const gy = y(max * f);
        svg += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '"/>';
        svg += '<text class="axis" x="' + (L - 8) + '" y="' + (gy + 3.5) + '" text-anchor="end">' + fmtAxis(max * f) + '</text>';
      });
      const every = Math.ceil(n / 8);
      values.forEach((v, i) => {
        const cx = L + band * i + band / 2;
        const x = cx - bw / 2;
        const h = Math.max(0, (H - T - B) - (y(v.value) - T));
        if (v.value > 0) svg += '<path class="bar ' + opts.cls + '" d="' + roundedTop(x, H - B, bw, Math.max(h, 2)) + '"/>';
        svg += '<rect class="hit" x="' + (L + band * i) + '" y="' + T + '" width="' + band + '" height="' + (H - T - B) + '" data-tip="' + escAttr(v.tip) + '"/>';
        if (i % every === 0 || i === n - 1) {
          svg += '<text class="axis" x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle">' + v.label + '</text>';
        }
      });
      return svg + '</svg>';
    }
  };

  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  function fmtAxis(v) {
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }

  function roundedTop(x, base, w, h) {
    const r = Math.min(4, w / 2, h);
    return 'M' + x + ',' + base +
      'V' + (base - h + r) +
      'Q' + x + ',' + (base - h) + ' ' + (x + r) + ',' + (base - h) +
      'H' + (x + w - r) +
      'Q' + (x + w) + ',' + (base - h) + ' ' + (x + w) + ',' + (base - h + r) +
      'V' + base + 'Z';
  }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  window.Pomo.Stats = Stats;
})();
