/* Persistence: everything lives in localStorage under the "pomo:" prefix. */
(function () {
  'use strict';

  const DATA_KEY = 'pomo:v1:data';
  const STATE_KEY = 'pomo:v1:state';
  const SCHEMA = 1;

  const DEFAULT_SETTINGS = {
    focusMin: 25,
    shortBreakMin: 10,
    longBreakMin: 20,
    longBreakEvery: 4,
    dailyGoal: 4,
    breatheSec: 90,
    praySec: 90,
    prayerText: 'Pray before you begin.',
    ringOffsetsSec: [-60, -30, 0],
    decaySec: [60, 45, 30, 20, 15, 10],
    lockAfterSec: 180,
    minReasonLength: 30,
    volume: 0.7,
    speed: 1
  };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function emptyData() {
    return {
      schemaVersion: SCHEMA,
      tasks: [],
      sessions: [],
      breaks: [],
      settings: Object.assign({}, DEFAULT_SETTINGS),
      meta: { createdAt: Date.now(), lastExportAt: null, backupNagDismissedOn: null }
    };
  }

  function emptyState() {
    return {
      mode: 'idle',
      selectedTaskId: null,
      lastTaskId: null,
      completedSinceLong: 0,
      pendingReviewId: null
    };
  }

  function read(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('Save failed', e);
      return false;
    }
  }

  function migrate(d) {
    const base = emptyData();
    d.tasks = Array.isArray(d.tasks) ? d.tasks : [];
    d.sessions = Array.isArray(d.sessions) ? d.sessions : [];
    d.breaks = Array.isArray(d.breaks) ? d.breaks : [];
    d.settings = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
    d.meta = Object.assign({}, base.meta, d.meta || {});
    d.schemaVersion = SCHEMA;
    return d;
  }

  const Store = {
    data: null,
    state: null,
    saveFailed: false,
    DEFAULT_SETTINGS,
    uid,

    load() {
      this.data = migrate(read(DATA_KEY) || emptyData());
      this.state = Object.assign(emptyState(), read(STATE_KEY) || {});
    },

    save() {
      this.saveFailed = !write(DATA_KEY, this.data);
    },

    saveState() {
      write(STATE_KEY, this.state);
    },

    exportJSON() {
      return JSON.stringify({
        app: 'pomodoro',
        exportedAt: new Date().toISOString(),
        data: this.data
      }, null, 2);
    },

    importJSON(text) {
      const obj = JSON.parse(text);
      const d = obj && obj.data ? obj.data : obj;
      if (!d || !Array.isArray(d.tasks) || !Array.isArray(d.sessions) || !Array.isArray(d.breaks)) {
        throw new Error('This file is not a pomodoro backup.');
      }
      this.data = migrate(d);
      this.state = emptyState();
      this.save();
      this.saveState();
    },

    resetAll() {
      this.data = emptyData();
      this.state = emptyState();
      this.save();
      this.saveState();
    },

    async requestPersist() {
      if (!navigator.storage || !navigator.storage.persist) return false;
      try {
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      } catch (e) {
        return false;
      }
    },

    async isPersisted() {
      if (!navigator.storage || !navigator.storage.persisted) return false;
      try { return await navigator.storage.persisted(); } catch (e) { return false; }
    }
  };

  window.Pomo = window.Pomo || {};
  window.Pomo.Store = Store;
})();
