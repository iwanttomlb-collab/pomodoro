/*
 * Timer state machine. All time is derived from stored timestamps, so a reload,
 * a throttled background tab or a sleeping laptop never makes the clock drift.
 *
 * Modes: idle -> reset (breathe + pray) -> focus -> break -> (locked) -> reset -> focus ...
 */
(function () {
  'use strict';

  const Pomo = window.Pomo;
  const Store = Pomo.Store;

  const TICK_MS = 250;
  const ALARM_EVERY_MS = 1500;
  const STALE_RING_MS = 30 * 1000;       // rings missed by more than this play silently
  const ABANDON_MS = 60 * 60 * 1000;     // break left 1 h past lock = abandoned, not doomscrolling

  const st = () => Store.state;
  const cfg = () => Store.data.settings;

  const BREAK_FIELDS = ['breakId', 'breakType', 'breakStartAt', 'allowanceSec', 'rings', 'fired', 'lockAtSec', 'afterSessionId', 'lockedAt'];
  const FOCUS_FIELDS = ['sessionId', 'startAt', 'plannedSec', 'pauses', 'pausedAt'];
  const RESET_FIELDS = ['resetStartAt', 'resetBreatheSec', 'resetPraySec', 'resetPhase'];

  function clearFields(fields) {
    fields.forEach(f => { delete st()[f]; });
  }

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  const Engine = {
    listeners: [],
    lastAlarmAt: 0,
    worker: null,
    interval: null,

    on(fn) { this.listeners.push(fn); },
    emit(evt) { this.listeners.forEach(fn => fn(evt)); },

    speed() { return st().speed || 1; },
    toRealMs(sec) { return sec * 1000 / this.speed(); },

    resetTotal() { return (st().resetBreatheSec || 0) + (st().resetPraySec || 0); },
    resetElapsed(now) { return Math.max(0, (now || Date.now()) - st().resetStartAt) * this.speed() / 1000; },

    focusElapsed(now) {
      now = now || Date.now();
      let paused = 0;
      (st().pauses || []).forEach(p => { paused += (p.end || now) - p.start; });
      return Math.max(0, now - st().startAt - paused) * this.speed() / 1000;
    },

    breakElapsed(now) {
      return Math.max(0, (now || Date.now()) - st().breakStartAt) * this.speed() / 1000;
    },

    /* Ring schedule for a break, in seconds from break start. */
    buildRings(allowance, settings) {
      const s = settings || cfg();
      const lockAfter = Math.max(10, Number(s.lockAfterSec) || 180);
      const byTime = new Map();
      const add = (at, kind, level) => {
        const prev = byTime.get(at);
        if (!prev || level > prev.level) byTime.set(at, { at, kind, level });
      };
      (s.ringOffsetsSec || []).forEach(off => {
        const at = allowance + off;
        if (at < 0 || off >= lockAfter) return;
        add(at, off < 0 ? 'warn' : off === 0 ? 'end' : 'decay', off > 0 ? 1 : 0);
      });
      const decay = (s.decaySec || []).filter(n => n > 0);
      let t = allowance;
      for (let i = 0; decay.length && i < 500; i++) {
        t += decay[Math.min(i, decay.length - 1)];
        if (t >= allowance + lockAfter) break;
        add(t, 'decay', i + 1);
      }
      const rings = Array.from(byTime.values()).sort((a, b) => a.at - b.at);
      return { rings, lockAtSec: allowance + lockAfter };
    },

    /* ---------- transitions ---------- */

    /* Entry point for every session: notice "Start" or lock unlock. */
    beginSession(taskId, goal) {
      const s = st();
      const now = Date.now();
      if (s.mode === 'break' || s.mode === 'locked') this.closeBreak('focus', '', now);
      s.taskId = taskId || null;
      s.goal = goal || '';
      s.lastTaskId = s.taskId;
      s.speed = Number(cfg().speed) || 1;
      const breathe = Math.max(0, Number(cfg().breatheSec) || 0);
      const pray = Math.max(0, Number(cfg().praySec) || 0);
      if (breathe + pray > 0) {
        s.mode = 'reset';
        s.resetStartAt = now;
        s.resetBreatheSec = breathe;
        s.resetPraySec = pray;
        s.resetPhase = breathe > 0 ? 'breathe' : 'pray';
      } else {
        this.startFocus(now);
      }
      Store.saveState();
      this.emit({ type: 'state' });
    },

    skipReset() {
      if (st().mode !== 'reset') return;
      this.startFocus(Date.now());
      Pomo.Audio.play('start');
      Store.saveState();
      this.emit({ type: 'state' });
    },

    cancelReset() {
      if (st().mode !== 'reset') return;
      clearFields(RESET_FIELDS);
      st().mode = 'idle';
      Store.saveState();
      this.emit({ type: 'state' });
    },

    startFocus(at) {
      const s = st();
      clearFields(RESET_FIELDS);
      s.mode = 'focus';
      s.sessionId = Store.uid();
      s.startAt = at;
      s.plannedSec = Math.max(1, Number(cfg().focusMin) || 25) * 60;
      s.pauses = [];
      s.pausedAt = null;
    },

    pause() {
      const s = st();
      if (s.mode !== 'focus' || s.pausedAt) return;
      const now = Date.now();
      s.pausedAt = now;
      s.pauses.push({ start: now, end: null });
      Store.saveState();
      this.emit({ type: 'state' });
    },

    resume() {
      const s = st();
      if (s.mode !== 'focus' || !s.pausedAt) return;
      const last = s.pauses[s.pauses.length - 1];
      if (last && !last.end) last.end = Date.now();
      s.pausedAt = null;
      Store.saveState();
      this.emit({ type: 'state' });
    },

    sessionRecord(endTs, aborted) {
      const s = st();
      const task = Store.data.tasks.find(t => t.id === s.taskId);
      let pausedMs = 0;
      (s.pauses || []).forEach(p => { pausedMs += (p.end || endTs) - p.start; });
      return {
        id: s.sessionId,
        taskId: s.taskId,
        taskTitle: task ? task.title : null,
        goal: s.goal || '',
        plannedSec: s.plannedSec,
        actualSec: aborted ? Math.round(this.focusElapsed(endTs)) : s.plannedSec,
        startAt: s.startAt,
        endAt: endTs,
        pauseCount: (s.pauses || []).length,
        pausedSec: Math.round(pausedMs / 1000),
        aborted: !!aborted,
        result: null,
        note: '',
        taskDone: false
      };
    },

    abort() {
      const s = st();
      if (s.mode !== 'focus') return;
      const now = Date.now();
      Store.data.sessions.push(this.sessionRecord(now, true));
      clearFields(FOCUS_FIELDS);
      s.mode = 'idle';
      Store.save();
      Store.saveState();
      this.emit({ type: 'state' });
    },

    completeFocus(endTs) {
      const s = st();
      const rec = this.sessionRecord(endTs, false);
      Store.data.sessions.push(rec);
      s.pendingReviewId = rec.id;
      s.completedSinceLong = (s.completedSinceLong || 0) + 1;
      const every = Math.max(1, Number(cfg().longBreakEvery) || 4);
      const isLong = s.completedSinceLong >= every;
      if (isLong) s.completedSinceLong = 0;
      clearFields(FOCUS_FIELDS);
      this.startBreak(endTs, isLong ? 'long' : 'short', rec.id);
      Store.save();
      Store.saveState();
      if (Date.now() - endTs < STALE_RING_MS) {
        Pomo.Audio.play('focusEnd');
        Pomo.Notify.show('Session complete', (isLong ? 'Long' : 'Short') + ' break started.');
      }
      this.emit({ type: 'focusEnd' });
    },

    startBreak(at, type, afterSessionId) {
      const s = st();
      const min = type === 'long' ? cfg().longBreakMin : cfg().shortBreakMin;
      const allowance = Math.max(1, Number(min) || 10) * 60;
      const plan = this.buildRings(allowance);
      Object.assign(s, {
        mode: 'break',
        breakId: Store.uid(),
        breakType: type,
        breakStartAt: at,
        allowanceSec: allowance,
        rings: plan.rings,
        fired: [],
        lockAtSec: plan.lockAtSec,
        afterSessionId,
        lockedAt: null
      });
    },

    closeBreak(endedBy, reason, endTs) {
      const s = st();
      endTs = endTs || Date.now();
      const elapsed = Math.max(0, endTs - s.breakStartAt) * this.speed() / 1000;
      let overtime = Math.max(0, elapsed - s.allowanceSec);
      if (endedBy === 'abandoned') overtime = s.lockAtSec - s.allowanceSec;
      const ringsIgnored = (s.rings || []).filter((r, i) => s.fired.includes(i) && r.at >= s.allowanceSec).length;
      Store.data.breaks.push({
        id: s.breakId,
        type: s.breakType,
        afterSessionId: s.afterSessionId || null,
        allowanceSec: s.allowanceSec,
        startAt: s.breakStartAt,
        endAt: endTs,
        overtimeSec: Math.round(overtime),
        ringsIgnored,
        locked: !!s.lockedAt,
        lockReason: reason || '',
        endedBy
      });
      clearFields(BREAK_FIELDS);
      Store.save();
    },

    endWork() {
      const s = st();
      if (s.mode !== 'break') return;
      this.closeBreak('stopped', '', Date.now());
      s.mode = 'idle';
      Store.saveState();
      this.emit({ type: 'state' });
    },

    unlock(reason) {
      const s = st();
      if (s.mode !== 'locked') return;
      this.closeBreak('unlock', reason, Date.now());
      s.mode = 'idle';
      const taskId = Store.data.tasks.some(t => t.id === s.lastTaskId) ? s.lastTaskId : null;
      this.beginSession(taskId, '');
    },

    saveReview(id, result, note, taskDone) {
      const rec = Store.data.sessions.find(x => x.id === id);
      if (rec) {
        rec.result = result || null;
        rec.note = note || '';
        rec.taskDone = !!taskDone;
        if (taskDone && rec.taskId) {
          const task = Store.data.tasks.find(t => t.id === rec.taskId);
          if (task && task.status !== 'done') {
            task.status = 'done';
            task.completedAt = Date.now();
          }
        }
      }
      if (st().pendingReviewId === id) st().pendingReviewId = null;
      Store.save();
      Store.saveState();
      this.emit({ type: 'state' });
    },

    abandon(lockTs) {
      this.closeBreak('abandoned', '', lockTs);
      st().mode = 'idle';
      Store.saveState();
      this.emit({ type: 'abandoned' });
    },

    /* ---------- clock ---------- */

    tick() {
      const s = st();
      const now = Date.now();

      if (s.mode === 'reset') {
        const el = this.resetElapsed(now);
        const total = this.resetTotal();
        if (el >= total) {
          this.startFocus(s.resetStartAt + this.toRealMs(total));
          Store.saveState();
          Pomo.Audio.play('start');
          this.emit({ type: 'state' });
        } else if (s.resetPhase === 'breathe' && el >= s.resetBreatheSec) {
          s.resetPhase = 'pray';
          Store.saveState();
          Pomo.Audio.play('soft');
        }
      }

      if (s.mode === 'focus' && !s.pausedAt) {
        const el = this.focusElapsed(now);
        if (el >= s.plannedSec) this.completeFocus(now - this.toRealMs(el - s.plannedSec));
      }

      if (s.mode === 'break') {
        const el = this.breakElapsed(now);
        if (el >= s.lockAtSec) {
          const lockTs = s.breakStartAt + this.toRealMs(s.lockAtSec);
          if (now - lockTs > ABANDON_MS) {
            this.abandon(lockTs);
          } else {
            s.mode = 'locked';
            s.lockedAt = lockTs;
            s.rings.forEach((r, i) => { if (!s.fired.includes(i)) s.fired.push(i); });
            Store.saveState();
            Pomo.Notify.show('Locked', 'Type a reason to unlock. Your next session starts right after.', true);
            this.emit({ type: 'state' });
          }
        } else {
          const due = [];
          s.rings.forEach((r, i) => { if (r.at <= el && !s.fired.includes(i)) due.push(i); });
          if (due.length) {
            s.fired.push.apply(s.fired, due);
            Store.saveState();
            const ring = s.rings[due[due.length - 1]];
            const ringTs = s.breakStartAt + this.toRealMs(ring.at);
            if (now - ringTs < STALE_RING_MS) {
              Pomo.Audio.play(ring.kind, ring.level);
              Pomo.Notify.show(this.ringTitle(ring), 'Lock in ' + fmt(s.lockAtSec - ring.at) + '.');
              this.emit({ type: 'ring', ring });
            }
          }
        }
      }

      if (s.mode === 'locked') {
        if (now - s.lockedAt > ABANDON_MS) {
          this.abandon(s.lockedAt);
        } else if (now - this.lastAlarmAt >= ALARM_EVERY_MS) {
          this.lastAlarmAt = now;
          Pomo.Audio.play('alarm');
        }
      }

      this.emit({ type: 'tick' });
    },

    ringTitle(ring) {
      const s = st();
      const diff = ring.at - s.allowanceSec;
      if (diff < 0) return 'Break ends in ' + fmt(-diff);
      if (diff === 0) return 'Break is over';
      return 'Over by ' + fmt(diff);
    },

    nextRing() {
      const s = st();
      if (s.mode !== 'break') return null;
      const idx = s.rings.findIndex((r, i) => !s.fired.includes(i));
      return idx === -1 ? null : s.rings[idx];
    },

    start() {
      const onTick = () => this.tick();
      const src = 'var id;onmessage=function(e){clearInterval(id);if(e.data==="go"){id=setInterval(function(){postMessage(1)},' + TICK_MS + ')}}';
      const fallback = () => {
        if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } this.worker = null; }
        if (!this.interval) this.interval = setInterval(onTick, TICK_MS);
      };
      try {
        this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        this.worker.onmessage = onTick;
        this.worker.onerror = fallback;
        this.worker.postMessage('go');
      } catch (e) {
        fallback();
      }
      this.tick();
    },

    stop() {
      if (this.worker) this.worker.postMessage('stop');
      if (this.interval) clearInterval(this.interval);
      this.interval = null;
    }
  };

  Pomo.Engine = Engine;
  Pomo.fmt = fmt;
})();
