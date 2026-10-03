/* Sound (Web Audio, no files) and desktop notifications. */
(function () {
  'use strict';

  let ctx = null;
  let master = null;
  const stateListeners = [];

  function ensureContext() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    ctx.onstatechange = () => stateListeners.forEach(fn => fn());
    return ctx;
  }

  function tone(freq, t0, dur, type, gain) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  const Audio = {
    get ready() {
      return !!ctx && ctx.state === 'running';
    },

    onStateChange(fn) {
      stateListeners.push(fn);
    },

    /* Must be called from a user gesture (click) the first time. */
    unlock() {
      try {
        ensureContext();
        if (ctx && ctx.state === 'suspended') {
          ctx.resume().then(() => stateListeners.forEach(fn => fn()));
        }
      } catch (e) {
        console.warn('Audio unlock failed', e);
      }
      return this.ready;
    },

    play(kind, level) {
      if (!ctx) return false;
      if (ctx.state === 'suspended') ctx.resume();
      level = level || 0;
      const vol = Number(window.Pomo.Store.data.settings.volume);
      master.gain.value = isFinite(vol) ? vol : 0.7;
      const t = ctx.currentTime + 0.03;
      let i;

      switch (kind) {
        case 'test':
        case 'start':
          tone(659.25, t, 0.25, 'sine', 0.45);
          tone(987.77, t + 0.16, 0.45, 'sine', 0.4);
          break;
        case 'soft':
          tone(523.25, t, 1.4, 'sine', 0.25);
          tone(783.99, t + 0.05, 1.4, 'sine', 0.12);
          break;
        case 'focusEnd':
          [523.25, 659.25, 783.99, 1046.5].forEach((f, n) => tone(f, t + n * 0.17, 0.5, 'sine', 0.4));
          break;
        case 'warn':
          tone(880, t, 0.2, 'triangle', 0.4);
          tone(880, t + 0.3, 0.2, 'triangle', 0.4);
          break;
        case 'end':
          for (i = 0; i < 2; i++) {
            tone(880, t + i * 0.9, 0.2, 'triangle', 0.5);
            tone(880, t + i * 0.9 + 0.25, 0.2, 'triangle', 0.5);
            tone(1174.66, t + i * 0.9 + 0.5, 0.3, 'triangle', 0.5);
          }
          break;
        case 'decay': {
          /* Gets longer, higher and harsher with each level. */
          const n = Math.min(4 + level * 2, 18);
          const f = 880 + level * 70;
          const g = Math.min(0.22 + level * 0.06, 0.6);
          for (i = 0; i < n; i++) tone(i % 2 ? f * 0.8 : f, t + i * 0.14, 0.11, 'square', g);
          break;
        }
        case 'alarm':
          for (i = 0; i < 8; i++) tone(i % 2 ? 660 : 990, t + i * 0.15, 0.13, 'square', 0.6);
          break;
      }
      return ctx.state === 'running';
    }
  };

  const Notify = {
    get supported() {
      return 'Notification' in window;
    },
    get permission() {
      return this.supported ? Notification.permission : 'unsupported';
    },
    async request() {
      if (!this.supported) return 'unsupported';
      try { return await Notification.requestPermission(); } catch (e) { return 'denied'; }
    },
    /* Only shows when the tab is hidden; the page itself shows everything otherwise. */
    show(title, body, sticky) {
      if (!this.supported || Notification.permission !== 'granted' || !document.hidden) return;
      try {
        const n = new Notification(title, { body, tag: 'pomodoro', renotify: true, requireInteraction: !!sticky });
        n.onclick = () => { window.focus(); n.close(); };
      } catch (e) { /* ignore */ }
    }
  };

  window.Pomo.Audio = Audio;
  window.Pomo.Notify = Notify;
})();
