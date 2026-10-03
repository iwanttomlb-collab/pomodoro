/* UI wiring: views, tasks, modals, overlays, stats and settings. */
(function () {
  'use strict';

  const { Store, Engine, Audio, Notify, Stats } = window.Pomo;
  const fmt = window.Pomo.fmt;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ui = {
    view: 'timer',
    taskFilter: 'active',
    editingId: null,
    statsTab: 'overview',
    range: 14,
    reviewResult: null,
    controlsKey: '',
    passive: false,
    tickCount: 0
  };

  const st = () => Store.state;
  const cfg = () => Store.data.settings;
  const taskById = id => Store.data.tasks.find(t => t.id === id);

  /* ---------- helpers ---------- */

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, 3200);
  }

  function show(el, on) { el.hidden = !on; }

  function anyModalOpen() {
    return ['#notice', '#confirm', '#review'].some(s => !$(s).hidden);
  }

  function resetSeconds() {
    return Math.max(0, Number(cfg().breatheSec) || 0) + Math.max(0, Number(cfg().praySec) || 0);
  }

  function taskSessionCount(id) {
    return Store.data.sessions.filter(s => s.taskId === id && !s.aborted).length;
  }

  /* ---------- views ---------- */

  function setView(view) {
    ui.view = view;
    $$('.tab').forEach(b => b.classList.toggle('is-on', b.dataset.view === view));
    $$('.view').forEach(v => v.classList.toggle('is-on', v.id === 'view-' + view));
    if (view === 'stats') renderStats();
    if (view === 'settings') fillSettings();
  }

  /* ---------- tasks ---------- */

  function renderTasks() {
    const list = $('#task-list');
    const tasks = Store.data.tasks
      .filter(t => (ui.taskFilter === 'done' ? t.status === 'done' : t.status !== 'done'))
      .sort((a, b) => ui.taskFilter === 'done' ? (b.completedAt || 0) - (a.completedAt || 0) : a.createdAt - b.createdAt);

    if (!tasks.length) {
      list.innerHTML = '<li class="empty">' + (ui.taskFilter === 'done' ? 'No finished tasks yet.' : 'No tasks. Add one above.') + '</li>';
      return;
    }

    list.innerHTML = tasks.map(t => {
      const done = taskSessionCount(t.id);
      const pct = Math.min(100, (done / Math.max(1, t.estSessions)) * 100);
      const over = done > t.estSessions;
      if (ui.editingId === t.id) {
        return '<li class="task editing" data-id="' + t.id + '">' +
          '<form class="task-edit">' +
          '<input name="title" type="text" maxlength="140" value="' + esc(t.title) + '" required>' +
          '<input name="est" type="number" min="1" max="99" value="' + t.estSessions + '" required>' +
          '<button type="submit" class="btn">Save</button>' +
          '<button type="button" class="btn ghost" data-act="cancel-edit">Cancel</button>' +
          '</form></li>';
      }
      return '<li class="task' + (st().selectedTaskId === t.id ? ' is-selected' : '') + (t.status === 'done' ? ' is-done' : '') + '" data-id="' + t.id + '">' +
        '<button class="check-btn" data-act="toggle" aria-label="' + (t.status === 'done' ? 'Reopen task' : 'Mark task done') + '"></button>' +
        '<div class="task-main" data-act="select">' +
        '<div class="task-title">' + esc(t.title) + '</div>' +
        '<div class="task-meta mono"><span class="' + (over ? 'over' : '') + '">' + done + ' / ' + t.estSessions + '</span> sessions</div>' +
        '<div class="task-bar"><span style="width:' + pct + '%"' + (over ? ' class="over"' : '') + '></span></div>' +
        '</div>' +
        '<div class="task-actions">' +
        '<button class="link" data-act="edit">Edit</button>' +
        '<button class="link" data-act="delete">Delete</button>' +
        '</div></li>';
    }).join('');
  }

  function bindTasks() {
    $('#task-form').addEventListener('submit', e => {
      e.preventDefault();
      const title = $('#task-title').value.trim();
      const est = Math.max(1, Math.min(99, parseInt($('#task-est').value, 10) || 1));
      if (!title) return;
      const task = { id: Store.uid(), title, estSessions: est, status: 'active', createdAt: Date.now(), completedAt: null };
      Store.data.tasks.push(task);
      if (!st().selectedTaskId) st().selectedTaskId = task.id;
      Store.save();
      Store.saveState();
      $('#task-title').value = '';
      $('#task-est').value = 2;
      ui.taskFilter = 'active';
      syncSeg('#task-filter', 'filter', 'active');
      renderAll();
    });

    $('#task-filter').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      ui.taskFilter = b.dataset.filter;
      syncSeg('#task-filter', 'filter', ui.taskFilter);
      renderTasks();
    });

    $('#task-list').addEventListener('click', e => {
      const act = e.target.closest('[data-act]');
      const li = e.target.closest('li[data-id]');
      if (!act || !li) return;
      const task = taskById(li.dataset.id);
      if (!task) return;
      switch (act.dataset.act) {
        case 'select':
          st().selectedTaskId = task.id;
          Store.saveState();
          renderTasks();
          renderTimer(true);
          break;
        case 'toggle':
          task.status = task.status === 'done' ? 'active' : 'done';
          task.completedAt = task.status === 'done' ? Date.now() : null;
          if (task.status === 'done' && st().selectedTaskId === task.id) st().selectedTaskId = null;
          Store.save();
          Store.saveState();
          renderAll();
          break;
        case 'edit':
          ui.editingId = task.id;
          renderTasks();
          $('.task-edit input[name=title]').focus();
          break;
        case 'cancel-edit':
          ui.editingId = null;
          renderTasks();
          break;
        case 'delete':
          openConfirm({
            title: 'Delete task?',
            body: '"' + task.title + '" will be removed. Its past sessions stay in your stats.',
            ok: 'Delete',
            danger: true,
            onOk() {
              Store.data.tasks = Store.data.tasks.filter(t => t.id !== task.id);
              if (st().selectedTaskId === task.id) st().selectedTaskId = null;
              Store.save();
              Store.saveState();
              renderAll();
            }
          });
          break;
      }
    });

    $('#task-list').addEventListener('submit', e => {
      e.preventDefault();
      const li = e.target.closest('li[data-id]');
      const task = li && taskById(li.dataset.id);
      if (!task) return;
      const f = e.target;
      const title = f.title.value.trim();
      if (!title) return;
      task.title = title;
      task.estSessions = Math.max(1, Math.min(99, parseInt(f.est.value, 10) || 1));
      ui.editingId = null;
      Store.save();
      renderAll();
    });
  }

  function syncSeg(sel, key, value) {
    $$(sel + ' button').forEach(b => b.classList.toggle('is-on', String(b.dataset[key]) === String(value)));
  }

  /* ---------- timer panel ---------- */

  function renderCycle() {
    const s = st();
    const every = Math.max(1, Number(cfg().longBreakEvery) || 4);
    let filled = s.completedSinceLong || 0;
    if ((s.mode === 'break' || s.mode === 'locked') && s.breakType === 'long') filled = every;
    let html = '';
    for (let i = 0; i < every; i++) {
      const cls = i < filled ? 'dot is-full' : (s.mode === 'focus' && i === filled ? 'dot is-now' : 'dot');
      html += '<span class="' + cls + '"></span>';
    }
    $('#cycle').innerHTML = html;
  }

  function renderControls() {
    const s = st();
    const key = s.mode + ':' + (s.pausedAt ? 'p' : '');
    if (key === ui.controlsKey) return;
    ui.controlsKey = key;
    let html = '';
    if (s.mode === 'idle') {
      html = '<button class="btn primary big" data-ctl="start">Start focus</button>';
    } else if (s.mode === 'focus') {
      html = (s.pausedAt
        ? '<button class="btn primary big" data-ctl="resume">Resume</button>'
        : '<button class="btn big" data-ctl="pause">Pause</button>') +
        '<button class="btn ghost" data-ctl="abort">Abort</button>';
    } else if (s.mode === 'break' || s.mode === 'locked') {
      html = '<button class="btn primary big" data-ctl="start">Start focus</button>' +
        '<button class="btn ghost" data-ctl="end">End work</button>';
    }
    $('#controls').innerHTML = html;
  }

  function renderTimer(force) {
    const s = st();
    if (force) ui.controlsKey = '';
    const clock = $('#clock');
    const timer = $('#timer');
    let label = 'Ready', time = '', pct = 0, over = false, heat = 0, ringInfo = '', title = 'Pomodoro';
    let taskText = '', goalText = '';

    const sel = taskById(s.selectedTaskId);

    if (s.mode === 'idle') {
      time = fmt((Number(cfg().focusMin) || 25) * 60);
      taskText = sel ? sel.title : 'No task selected';
    } else if (s.mode === 'reset') {
      label = 'Reset';
      const left = Engine.resetTotal() - Engine.resetElapsed();
      time = fmt(Math.ceil(left));
      title = 'Reset ' + time;
      const t = taskById(s.taskId);
      taskText = t ? t.title : 'No task';
    } else if (s.mode === 'focus') {
      const el = Engine.focusElapsed();
      const left = Math.max(0, s.plannedSec - el);
      label = s.pausedAt ? 'Focus / paused' : 'Focus';
      time = fmt(Math.ceil(left));
      pct = Math.min(100, (el / s.plannedSec) * 100);
      title = time + ' Focus';
      const t = taskById(s.taskId);
      taskText = t ? t.title : 'No task';
      goalText = s.goal;
    } else if (s.mode === 'break' || s.mode === 'locked') {
      const el = Engine.breakElapsed();
      const left = s.allowanceSec - el;
      label = s.breakType === 'long' ? 'Long break' : 'Short break';
      if (left > 0) {
        time = fmt(Math.ceil(left));
        pct = Math.min(100, (el / s.allowanceSec) * 100);
        title = time + ' Break';
        taskText = 'Doomscroll allowance';
      } else {
        over = true;
        time = '+' + fmt(Math.floor(-left));
        pct = 100;
        heat = Math.min(1, -left / Math.max(1, s.lockAtSec - s.allowanceSec));
        title = '+' + fmt(Math.floor(-left)) + ' OVER';
        taskText = 'Over the break. Start the next session.';
      }
      if (s.mode === 'locked') { heat = 1; title = 'LOCKED'; }
      const next = Engine.nextRing();
      if (s.mode === 'break') {
        ringInfo = (next ? 'Next ring in ' + fmt(Math.ceil(next.at - el)) + '  /  ' : '') + 'Lock in ' + fmt(Math.ceil(s.lockAtSec - el));
      }
    }

    $('#mode-label').textContent = label;
    clock.textContent = time;
    clock.classList.toggle('is-over', over);
    timer.dataset.mode = s.mode;
    $('#progress').style.width = pct + '%';
    $('#progress').classList.toggle('is-over', over);
    $('#now-task').textContent = taskText;
    $('#now-goal').textContent = goalText ? 'Goal: ' + goalText : '';
    $('#ring-info').textContent = ringInfo;
    document.body.style.setProperty('--heat', heat.toFixed(3));
    document.title = title;
    renderCycle();
    renderControls();
  }

  function bindControls() {
    $('#controls').addEventListener('click', e => {
      const b = e.target.closest('[data-ctl]');
      if (!b) return;
      Audio.unlock();
      switch (b.dataset.ctl) {
        case 'start':
          if (st().pendingReviewId) { renderOverlays(); return; }
          openNotice();
          break;
        case 'pause': Engine.pause(); break;
        case 'resume': Engine.resume(); break;
        case 'abort':
          openConfirm({
            title: 'Abort this session?',
            body: 'It is recorded as aborted and resets your unbroken-session streak.',
            ok: 'Abort',
            danger: true,
            onOk: () => Engine.abort()
          });
          break;
        case 'end':
          openConfirm({
            title: 'End work for now?',
            body: 'The break is recorded with its current overtime and the timer stops.',
            ok: 'End work',
            onOk: () => Engine.endWork()
          });
          break;
      }
    });
  }

  /* ---------- today ---------- */

  function renderToday() {
    const d = Store.data;
    const t = Stats.today(d);
    const ss = Stats.sessionStreak(d.sessions);
    const ds = Stats.dailyStreak(d.sessions, Number(cfg().dailyGoal) || 4);
    const goal = Number(cfg().dailyGoal) || 4;
    $('#today').innerHTML =
      '<div class="mini"><span class="k">Today</span><span class="v mono">' + t.sessions + '<small> / ' + goal + '</small></span></div>' +
      '<div class="mini"><span class="k">Focus</span><span class="v mono">' + Stats.fmtDur(t.focusSec) + '</span></div>' +
      '<div class="mini"><span class="k">Overtime</span><span class="v mono' + (t.overSec ? ' red' : '') + '">' + Stats.fmtClock(t.overSec) + '</span></div>' +
      '<div class="mini"><span class="k">Unbroken</span><span class="v mono">' + ss.current + '</span></div>' +
      '<div class="mini"><span class="k">Day streak</span><span class="v mono">' + ds.current + '</span></div>';
  }

  /* ---------- banners ---------- */

  function renderBanners() {
    const out = [];
    const s = st();
    const active = ['reset', 'focus', 'break', 'locked'].includes(s.mode);
    if (active && !Audio.ready) {
      out.push('<button class="banner warn" data-banner="audio">Sound is off. Click here to turn it on.</button>');
    }
    if (Store.saveFailed) {
      out.push('<div class="banner warn">Saving failed. Browser storage may be full or blocked. Export a backup now.</div>');
    }
    const m = Store.data.meta;
    const today = Stats.dayKey(Date.now());
    const hasData = Store.data.sessions.length > 0;
    const last = m.lastExportAt || m.createdAt;
    if (hasData && Date.now() - last > 7 * 86400000 && m.backupNagDismissedOn !== today) {
      out.push('<div class="banner">No backup in the last 7 days. <button class="link" data-banner="export">Export now</button> <button class="link" data-banner="dismiss">Later</button></div>');
    }
    $('#banners').innerHTML = out.join('');
  }

  function bindBanners() {
    $('#banners').addEventListener('click', e => {
      const b = e.target.closest('[data-banner]');
      if (!b) return;
      if (b.dataset.banner === 'audio') { Audio.unlock(); Audio.play('test'); }
      if (b.dataset.banner === 'export') exportBackup();
      if (b.dataset.banner === 'dismiss') {
        Store.data.meta.backupNagDismissedOn = Stats.dayKey(Date.now());
        Store.save();
      }
      renderBanners();
    });
  }

  /* ---------- notice ---------- */

  function openNotice() {
    const sel = $('#nb-task');
    const active = Store.data.tasks.filter(t => t.status !== 'done');
    sel.innerHTML = '<option value="">No task</option>' + active.map(t =>
      '<option value="' + t.id + '">' + esc(t.title) + ' (' + taskSessionCount(t.id) + '/' + t.estSessions + ')</option>').join('');
    sel.value = active.some(t => t.id === st().selectedTaskId) ? st().selectedTaskId : (active[0] ? active[0].id : '');
    $('#nb-blocked').checked = false;
    $('#nb-goal').value = '';
    $('#nb-start').disabled = true;
    const r = resetSeconds();
    $('#nb-reset-hint').textContent = r > 0
      ? 'A ' + fmt(r) + ' breathing and prayer reset runs before the timer.'
      : '';
    renderNotifyButtons();
    show($('#notice'), true);
    $('#nb-blocked').focus();
  }

  function renderNotifyButtons() {
    const p = Notify.permission;
    ['#nb-notify', '#settings-notify'].forEach(id => { $(id).hidden = p !== 'default'; });
    const text = p === 'granted' ? 'Notifications on.' : p === 'denied' ? 'Notifications are blocked in browser settings.' : p === 'unsupported' ? 'Notifications not supported here.' : '';
    $('#nb-status').textContent = (Audio.ready ? 'Sound on. ' : '') + text;
    $('#notify-status').textContent = text;
  }

  function bindNotice() {
    $('#nb-blocked').addEventListener('change', e => { $('#nb-start').disabled = !e.target.checked; });
    $('#nb-test').addEventListener('click', () => {
      Audio.unlock();
      setTimeout(() => { Audio.play('test'); renderNotifyButtons(); }, 60);
    });
    $('#nb-notify').addEventListener('click', async () => { await Notify.request(); renderNotifyButtons(); });
    $('#nb-start').addEventListener('click', () => {
      Audio.unlock();
      const taskId = $('#nb-task').value || null;
      if (taskId) st().selectedTaskId = taskId;
      show($('#notice'), false);
      Engine.beginSession(taskId, $('#nb-goal').value.trim());
    });
    $('#nb-goal').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !$('#nb-start').disabled) $('#nb-start').click();
    });
  }

  /* ---------- review ---------- */

  function renderReview() {
    const id = st().pendingReviewId;
    const rec = id && Store.data.sessions.find(x => x.id === id);
    const visible = !!rec && st().mode !== 'locked' && st().mode !== 'reset';
    if (!visible) { show($('#review'), false); return; }
    if (!$('#review').hidden && $('#review').dataset.id === id) return;
    $('#review').dataset.id = id;
    ui.reviewResult = null;
    const task = taskById(rec.taskId);
    $('#rv-task').textContent = task ? task.title : (rec.taskTitle || 'No task');
    $('#rv-goal').textContent = rec.goal ? 'Goal: ' + rec.goal : 'No goal was set.';
    $('#rv-note').value = '';
    $('#rv-done').checked = false;
    $('#rv-done-row').hidden = !task || task.status === 'done';
    $('#rv-save').disabled = true;
    $$('#rv-choice button').forEach(b => b.classList.remove('is-on'));
    show($('#review'), true);
  }

  function bindReview() {
    $('#rv-choice').addEventListener('click', e => {
      const b = e.target.closest('[data-result]');
      if (!b) return;
      ui.reviewResult = b.dataset.result;
      $$('#rv-choice button').forEach(x => x.classList.toggle('is-on', x === b));
      $('#rv-save').disabled = false;
    });
    $('#rv-save').addEventListener('click', () => {
      const id = $('#review').dataset.id;
      show($('#review'), false);
      Engine.saveReview(id, ui.reviewResult, $('#rv-note').value.trim(), $('#rv-done').checked);
    });
    $('#rv-skip').addEventListener('click', () => {
      const id = $('#review').dataset.id;
      show($('#review'), false);
      Engine.saveReview(id, null, '', false);
    });
  }

  /* ---------- confirm ---------- */

  let confirmCb = null;
  function openConfirm(o) {
    $('#cf-title').textContent = o.title;
    $('#cf-body').textContent = o.body;
    const ok = $('#cf-ok');
    ok.textContent = o.ok || 'OK';
    ok.className = 'btn ' + (o.danger ? 'danger' : 'primary');
    const input = $('#cf-input');
    input.hidden = !o.requireText;
    input.value = '';
    input.placeholder = o.requireText ? 'Type ' + o.requireText : '';
    ok.disabled = !!o.requireText;
    input.oninput = () => { ok.disabled = input.value.trim() !== o.requireText; };
    confirmCb = o.onOk;
    show($('#confirm'), true);
    (o.requireText ? input : ok).focus();
  }

  function bindConfirm() {
    $('#cf-ok').addEventListener('click', () => {
      show($('#confirm'), false);
      const cb = confirmCb;
      confirmCb = null;
      if (cb) cb();
    });
  }

  /* ---------- reset overlay ---------- */

  const BREATH = [
    { cue: 'Breathe in', sec: 4, from: 0.42, to: 1 },
    { cue: 'Hold', sec: 4, from: 1, to: 1 },
    { cue: 'Breathe out', sec: 6, from: 1, to: 0.42 }
  ];
  const BREATH_CYCLE = BREATH.reduce((a, p) => a + p.sec, 0);
  let rafId = null;

  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  function drawReset() {
    const s = st();
    if (s.mode !== 'reset') { rafId = null; return; }
    const el = Engine.resetElapsed();
    const total = Engine.resetTotal();
    const breathing = el < s.resetBreatheSec;
    const core = $('#breath-core');
    const reset = $('#reset');
    reset.classList.toggle('is-pray', !breathing);

    if (breathing) {
      let t = el % BREATH_CYCLE;
      let phase = BREATH[0];
      for (const p of BREATH) {
        if (t < p.sec) { phase = p; break; }
        t -= p.sec;
      }
      const k = phase.from + (phase.to - phase.from) * ease(t / phase.sec);
      core.style.transform = 'scale(' + k.toFixed(4) + ')';
      $('#reset-phase').textContent = 'Breathe';
      $('#reset-cue').textContent = phase.cue + '  ' + Math.ceil(phase.sec - t);
    } else {
      core.style.transform = 'scale(' + (0.5 + 0.03 * Math.sin(el * 0.8)).toFixed(4) + ')';
      $('#reset-phase').textContent = 'Pray';
      $('#reset-cue').textContent = cfg().prayerText || 'Pray before you begin.';
    }
    $('#reset-time').textContent = fmt(Math.ceil(total - el));
    rafId = requestAnimationFrame(drawReset);
  }

  function renderResetOverlay() {
    const s = st();
    const on = s.mode === 'reset';
    show($('#reset'), on);
    if (on) {
      const t = taskById(s.taskId);
      $('#reset-task').textContent = 'Next: ' + (t ? t.title : 'No task') + (s.goal ? '  /  ' + s.goal : '');
      if (!rafId) rafId = requestAnimationFrame(drawReset);
    }
  }

  function bindReset() {
    $('#reset-skip').addEventListener('click', () => { Audio.unlock(); Engine.skipReset(); });
    $('#reset-cancel').addEventListener('click', () => Engine.cancelReset());
  }

  /* ---------- lock overlay ---------- */

  function reasonValid(text) {
    const min = Math.max(1, Number(cfg().minReasonLength) || 30);
    const t = text.trim();
    const words = t.split(/\s+/).filter(Boolean);
    const distinct = new Set(t.toLowerCase().replace(/\s/g, '')).size;
    return { ok: t.length >= min && words.length >= 3 && distinct >= 6, len: t.length, min };
  }

  function renderLock() {
    const s = st();
    const on = s.mode === 'locked';
    const wasHidden = $('#lock').hidden;
    show($('#lock'), on);
    if (!on) return;
    const over = Engine.breakElapsed() - s.allowanceSec;
    $('#lock-clock').textContent = '+' + fmt(Math.floor(over));
    $('#lock-text').textContent = 'Your next session should have started ' + fmt(Math.floor(over)) +
      ' ago. Write why you kept scrolling. The next session starts right after.';
    if (wasHidden) {
      $('#lock-reason').value = '';
      updateLockCount();
      setTimeout(() => $('#lock-reason').focus(), 50);
    }
  }

  function updateLockCount() {
    const v = reasonValid($('#lock-reason').value);
    $('#lock-count').textContent = v.len + ' / ' + v.min + ' chars, 3+ words';
    $('#lock-submit').disabled = !v.ok;
  }

  function bindLock() {
    const box = $('#lock-reason');
    box.addEventListener('input', updateLockCount);
    box.addEventListener('paste', e => { e.preventDefault(); toast('Type it. Pasting is off here.'); });
    box.addEventListener('drop', e => e.preventDefault());
    $('#lock').addEventListener('pointerdown', () => Audio.unlock());
    $('#lock-submit').addEventListener('click', () => {
      const text = box.value.trim();
      if (!reasonValid(text).ok) return;
      Audio.unlock();
      Engine.unlock(text);
    });
  }

  /* ---------- overlays ---------- */

  function renderOverlays() {
    renderResetOverlay();
    renderLock();
    renderReview();
  }

  /* ---------- stats view ---------- */

  function tile(k, v, sub, cls) {
    return '<div class="tile"><div class="k">' + k + '</div><div class="v mono' + (cls ? ' ' + cls : '') + '">' + v + '</div>' +
      (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
  }

  function chartBlock(title, sub, series, field, cls, unitFmt) {
    const vals = series.map(r => {
      const d = new Date(r.ts);
      const label = (d.getMonth() + 1) + '/' + d.getDate();
      return { label, value: r[field] / 60, tip: label + '  ' + unitFmt(r[field]) };
    });
    const rows = series.slice().reverse().map(r => '<tr><td>' + r.key + '</td><td class="mono">' + unitFmt(r[field]) + '</td></tr>').join('');
    return '<div class="panel chart-panel"><div class="chart-head"><h3>' + title + '</h3><span class="hint">' + sub + '</span></div>' +
      Stats.barChart(vals, { title, cls }) +
      '<details><summary>Table</summary><table class="tbl"><thead><tr><th>Day</th><th>' + title + '</th></tr></thead><tbody>' + rows + '</tbody></table></details></div>';
  }

  function rangeLabel() {
    return ui.range ? 'Last ' + ui.range + ' days' : 'All time';
  }

  function renderStats() {
    const d = Store.data;
    const body = $('#stats-body');
    const goal = Number(cfg().dailyGoal) || 4;
    $('#stats-range').style.visibility = ui.statsTab === 'tasks' ? 'hidden' : 'visible';

    if (ui.statsTab === 'overview') {
      const ss = Stats.sessionStreak(d.sessions);
      const ds = Stats.dailyStreak(d.sessions, goal);
      const ot = Stats.onTimeStreak(d.breaks);
      const sessions = Stats.inRange(d.sessions, ui.range);
      const rc = Stats.reviewCounts(sessions);
      const focusSec = sessions.reduce((a, s) => a + (s.actualSec || 0), 0);
      const doneCount = sessions.filter(s => !s.aborted).length;
      const series = Stats.daySeries(d, ui.range);
      body.innerHTML =
        '<div class="tiles">' +
        tile('Unbroken sessions', ss.current, 'best ' + ss.best) +
        tile('Day streak', ds.current, goal + '+ sessions a day / best ' + ds.best) +
        tile('On-time returns', ot.current, 'best ' + ot.best) +
        tile('Sessions', doneCount, rangeLabel() + ', ' + (sessions.length - doneCount) + ' aborted') +
        tile('Focus time', Stats.fmtDur(focusSec), rangeLabel()) +
        tile('Done as planned', rc.rate == null ? '--' : Math.round(rc.rate * 100) + '%', rc.yes + ' yes / ' + rc.partial + ' partly / ' + rc.no + ' no') +
        '</div>' +
        chartBlock('Focus minutes', rangeLabel(), series, 'focusSec', 'bar-focus', s => Stats.fmtDur(s)) +
        chartBlock('Overtime minutes', rangeLabel(), series, 'overSec', 'bar-over', s => Stats.fmtClock(s));
    }

    if (ui.statsTab === 'tasks') {
      const rows = Stats.perTask(d).sort((a, b) => b.focusSec - a.focusSec);
      body.innerHTML = rows.length
        ? '<div class="panel"><table class="tbl"><thead><tr><th>Task</th><th>Status</th><th>Sessions</th><th>Focus</th><th>As planned</th><th>Within estimate</th></tr></thead><tbody>' +
          rows.map(r => {
            const est = r.withinEstimate == null ? '--' : r.withinEstimate ? 'Yes' : 'No (+' + (r.sessionsDone - r.task.estSessions) + ')';
            const rv = r.review.reviewed ? r.review.yes + ' / ' + r.review.partial + ' / ' + r.review.no : '--';
            return '<tr><td>' + esc(r.task.title) + '</td><td>' + (r.task.status === 'done' ? 'Done' : 'Active') + '</td>' +
              '<td class="mono">' + r.sessionsDone + ' / ' + r.task.estSessions + (r.aborted ? ' <span class="hint">(' + r.aborted + ' aborted)</span>' : '') + '</td>' +
              '<td class="mono">' + Stats.fmtDur(r.focusSec) + '</td><td class="mono" title="yes / partly / no">' + rv + '</td>' +
              '<td class="' + (r.withinEstimate === false ? 'red' : '') + '">' + est + '</td></tr>';
          }).join('') + '</tbody></table><p class="hint">As planned = yes / partly / no answers after each session.</p></div>'
        : '<div class="panel empty">No tasks yet.</div>';
    }

    if (ui.statsTab === 'doom') {
      const breaks = Stats.inRange(d.breaks, ui.range);
      const ds = Stats.doomscroll(breaks);
      const series = Stats.daySeries(d, ui.range);
      const reasons = breaks.filter(b => b.lockReason).sort((a, b) => b.startAt - a.startAt);
      body.innerHTML =
        '<div class="tiles">' +
        tile('Total overtime', Stats.fmtClock(ds.totalSec), rangeLabel(), ds.totalSec ? 'red' : '') +
        tile('Average per break', Stats.fmtClock(ds.avgSec), ds.breaks + ' breaks') +
        tile('Breaks over time', ds.overCount, ds.breaks ? Math.round(ds.overCount / ds.breaks * 100) + '% of breaks' : '') +
        tile('Locks', ds.locks, 'reached the lock') +
        tile('Rings ignored', ds.ringsIgnored, 'after the break ended') +
        tile('Longest overtime', Stats.fmtClock(ds.longestSec), ds.abandoned ? ds.abandoned + ' abandoned' : '') +
        '</div>' +
        chartBlock('Overtime minutes', rangeLabel(), series, 'overSec', 'bar-over', s => Stats.fmtClock(s)) +
        '<div class="panel"><h3>Reasons</h3>' + (reasons.length
          ? '<table class="tbl"><thead><tr><th>When</th><th>Overtime</th><th>Reason</th></tr></thead><tbody>' +
            reasons.map(b => '<tr><td class="mono nowrap">' + Stats.fmtWhen(b.startAt) +
              '</td><td class="mono red">+' + Stats.fmtClock(b.overtimeSec) + '</td><td>' + esc(b.lockReason) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="hint">No locks in this range.</p>') + '</div>';
    }

    if (ui.statsTab === 'history') {
      const items = Stats.inRange(d.sessions, ui.range).map(s => ({ kind: 's', at: s.startAt, r: s }))
        .concat(Stats.inRange(d.breaks, ui.range).map(b => ({ kind: 'b', at: b.startAt, r: b })))
        .sort((a, b) => b.at - a.at).slice(0, 200);
      const resultText = { yes: 'Yes', partial: 'Partly', no: 'No' };
      body.innerHTML = items.length
        ? '<div class="panel"><table class="tbl"><thead><tr><th>When</th><th>Type</th><th>Detail</th><th>Length</th><th>Result</th></tr></thead><tbody>' +
          items.map(it => {
            const when = Stats.fmtWhen(it.at);
            if (it.kind === 's') {
              const s = it.r;
              const t = taskById(s.taskId);
              return '<tr><td class="mono nowrap">' + when + '</td><td>Focus</td><td>' + esc(t ? t.title : (s.taskTitle || 'No task')) +
                (s.goal ? '<div class="hint">' + esc(s.goal) + '</div>' : '') + (s.note ? '<div class="hint">' + esc(s.note) + '</div>' : '') +
                '</td><td class="mono">' + Stats.fmtDur(s.actualSec) + (s.pauseCount ? ' <span class="hint">' + s.pauseCount + ' pause' + (s.pauseCount > 1 ? 's' : '') + '</span>' : '') +
                '</td><td' + (s.aborted ? ' class="red"' : '') + '>' + (s.aborted ? 'Aborted' : (resultText[s.result] || '--')) + '</td></tr>';
            }
            const b = it.r;
            const ended = { focus: 'Back to focus', unlock: 'Unlocked', stopped: 'Ended work', abandoned: 'Abandoned' }[b.endedBy] || '';
            return '<tr><td class="mono nowrap">' + when + '</td><td>' + (b.type === 'long' ? 'Long break' : 'Break') + '</td><td>' + ended +
              (b.lockReason ? '<div class="hint">' + esc(b.lockReason) + '</div>' : '') + '</td><td class="mono">' + Stats.fmtClock(b.overtimeSec ? b.allowanceSec + b.overtimeSec : Math.min(b.allowanceSec, (b.endAt - b.startAt) / 1000)) +
              '</td><td class="mono' + (b.overtimeSec ? ' red' : '') + '">' + (b.overtimeSec ? '+' + Stats.fmtClock(b.overtimeSec) : 'On time') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="panel empty">Nothing recorded in this range.</div>';
    }
  }

  function bindStats() {
    $('#stats-tabs').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      ui.statsTab = b.dataset.tab;
      syncSeg('#stats-tabs', 'tab', ui.statsTab);
      renderStats();
    });
    $('#stats-range').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      ui.range = Number(b.dataset.range);
      syncSeg('#stats-range', 'range', ui.range);
      renderStats();
    });
    const tip = $('#tooltip');
    $('#stats-body').addEventListener('mousemove', e => {
      const hit = e.target.closest('[data-tip]');
      if (!hit) { tip.hidden = true; return; }
      tip.textContent = hit.dataset.tip;
      tip.hidden = false;
      const x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 12);
      tip.style.left = x + 'px';
      tip.style.top = (e.clientY - 34) + 'px';
    });
    $('#stats-body').addEventListener('mouseleave', () => { tip.hidden = true; });
  }

  /* ---------- settings ---------- */

  const NUM_FIELDS = ['focusMin', 'shortBreakMin', 'longBreakMin', 'longBreakEvery', 'dailyGoal', 'breatheSec', 'praySec', 'lockAfterSec', 'minReasonLength'];

  function parseList(text) {
    return String(text).split(/[\s,]+/).filter(Boolean).map(Number).filter(n => isFinite(n));
  }

  function fillSettings() {
    const f = $('#settings-form');
    const s = cfg();
    NUM_FIELDS.forEach(k => { f[k].value = s[k]; });
    f.prayerText.value = s.prayerText || '';
    f.ringOffsetsSec.value = s.ringOffsetsSec.join(', ');
    f.decaySec.value = s.decaySec.join(', ');
    f.volume.value = s.volume;
    f.speed.value = String(s.speed || 1);
    renderRingPreview();
    renderNotifyButtons();
    renderStorageStatus();
  }

  function readSettingsForm() {
    const f = $('#settings-form');
    const out = {};
    NUM_FIELDS.forEach(k => {
      const v = Number(f[k].value);
      out[k] = isFinite(v) && f[k].value !== '' ? Math.max(Number(f[k].min) || 0, Math.min(Number(f[k].max) || 1e6, v)) : cfg()[k];
    });
    out.prayerText = f.prayerText.value.trim();
    out.ringOffsetsSec = parseList(f.ringOffsetsSec.value);
    out.decaySec = parseList(f.decaySec.value).filter(n => n > 0);
    out.volume = Number(f.volume.value);
    out.speed = Number(f.speed.value) || 1;
    return out;
  }

  function renderRingPreview() {
    const s = Object.assign({}, cfg(), readSettingsForm());
    const allowance = s.shortBreakMin * 60;
    const plan = Engine.buildRings(allowance, s);
    $('#ring-preview').textContent = 'Short break (' + s.shortBreakMin + ' min): rings at ' +
      (plan.rings.map(r => fmt(r.at)).join(', ') || 'none') + '. Lock at ' + fmt(plan.lockAtSec) + '.';
  }

  function bindSettings() {
    const f = $('#settings-form');
    f.addEventListener('input', renderRingPreview);
    f.addEventListener('submit', e => {
      e.preventDefault();
      Object.assign(Store.data.settings, readSettingsForm());
      Store.save();
      fillSettings();
      renderAll();
      toast('Settings saved. Timing changes apply from the next session or break.');
    });
    $('#settings-defaults').addEventListener('click', () => {
      openConfirm({
        title: 'Restore default settings?',
        body: 'Your tasks and records are kept.',
        ok: 'Restore',
        onOk() {
          Store.data.settings = Object.assign({}, Store.DEFAULT_SETTINGS);
          Store.save();
          fillSettings();
          renderAll();
        }
      });
    });
    $('#settings-test').addEventListener('click', () => {
      Audio.unlock();
      const vol = Number(f.volume.value);
      const old = cfg().volume;
      cfg().volume = vol;
      setTimeout(() => { Audio.play('decay', 3); cfg().volume = old; }, 60);
    });
    $('#settings-notify').addEventListener('click', async () => { await Notify.request(); renderNotifyButtons(); });

    $('#export-btn').addEventListener('click', exportBackup);
    $('#import-file').addEventListener('change', e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (st().mode !== 'idle') { toast('Stop the timer before importing.'); return; }
      openConfirm({
        title: 'Import backup?',
        body: 'This replaces all current tasks, records and settings with the contents of ' + file.name + '.',
        ok: 'Import',
        danger: true,
        onOk() {
          const reader = new FileReader();
          reader.onload = () => {
            try {
              Store.importJSON(reader.result);
              renderAll();
              fillSettings();
              toast('Backup imported.');
            } catch (err) {
              toast(err.message || 'Import failed.');
            }
          };
          reader.readAsText(file);
        }
      });
    });
    $('#reset-btn').addEventListener('click', () => {
      if (st().mode !== 'idle') { toast('Stop the timer before resetting.'); return; }
      openConfirm({
        title: 'Reset all data?',
        body: 'Every task, session, break and setting is deleted from this browser. Export a backup first if you might want it.',
        ok: 'Delete everything',
        danger: true,
        requireText: 'RESET',
        onOk() {
          Store.resetAll();
          renderAll();
          fillSettings();
          toast('All data deleted.');
        }
      });
    });
  }

  async function renderStorageStatus() {
    const d = Store.data;
    const persisted = await Store.isPersisted();
    const last = d.meta.lastExportAt ? Stats.fmtDate(d.meta.lastExportAt) : 'never';
    $('#storage-status').textContent = d.tasks.length + ' tasks, ' + d.sessions.length + ' sessions, ' + d.breaks.length +
      ' breaks saved in this browser. Persistent storage: ' + (persisted ? 'on' : 'off') + '. Last backup: ' + last + '.';
  }

  function exportBackup() {
    const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pomodoro-backup-' + Stats.dayKey(Date.now()) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    Store.data.meta.lastExportAt = Date.now();
    Store.save();
    renderBanners();
    if (ui.view === 'settings') renderStorageStatus();
  }

  /* ---------- tabs across browser windows ---------- */

  function bindTabGuard() {
    if (!('BroadcastChannel' in window)) return;
    const ch = new BroadcastChannel('pomodoro');
    const me = Store.uid();
    ch.onmessage = e => {
      if (e.data && e.data.type === 'claim' && e.data.id !== me) {
        ui.passive = true;
        Engine.stop();
        show($('#tab-block'), true);
      }
    };
    ch.postMessage({ type: 'claim', id: me });
    $('#tab-take').addEventListener('click', () => location.reload());
  }

  /* ---------- render ---------- */

  function renderAll() {
    renderTasks();
    renderTimer(true);
    renderToday();
    renderBanners();
    renderOverlays();
    if (ui.view === 'stats') renderStats();
  }

  function onEngine(evt) {
    if (ui.passive) return;
    if (evt.type === 'tick') {
      renderTimer(false);
      if (st().mode === 'locked') renderLock();
      if (++ui.tickCount % 40 === 0) renderToday();
      return;
    }
    if (evt.type === 'ring') {
      const c = $('#clock');
      c.classList.remove('is-ringing');
      void c.offsetWidth;
      c.classList.add('is-ringing');
      return;
    }
    if (evt.type === 'abandoned') toast('A break was left open for over an hour. It was recorded as abandoned.');
    renderAll();
  }

  function init() {
    Store.load();
    bindTasks();
    bindControls();
    bindBanners();
    bindNotice();
    bindReview();
    bindConfirm();
    bindReset();
    bindLock();
    bindStats();
    bindSettings();

    $$('.tab').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
    $$('[data-close]').forEach(b => b.addEventListener('click', () => show(b.closest('.overlay'), false)));
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      ['#notice', '#confirm'].forEach(s => show($(s), false));
    });

    /* Any click can unlock audio (browsers require a gesture). */
    document.addEventListener('pointerdown', () => { if (!Audio.ready) Audio.unlock(); }, true);
    Audio.onStateChange(() => { renderBanners(); renderNotifyButtons(); });

    window.addEventListener('beforeunload', e => {
      if (!ui.passive && st().mode !== 'idle') { e.preventDefault(); e.returnValue = ''; }
    });

    Engine.on(onEngine);
    Store.requestPersist();
    if (st().mode !== 'idle') Audio.unlock();
    bindTabGuard();
    renderAll();
    Engine.start();
  }

  init();
})();
