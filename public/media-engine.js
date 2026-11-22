/* Engine adapters own decoders and output. The host owns stable controls/events. */
(function(root) {
  const events = ['play', 'playing', 'pause', 'ended', 'emptied', 'error', 'waiting', 'stalled',
    'seeking', 'seeked', 'timeupdate', 'durationchange', 'ratechange', 'volumechange', 'loadedmetadata'];
  const required = ['snapshot', 'subscribe', 'load', 'play', 'pause', 'stop', 'seek', 'setVolume', 'setRate', 'dispose'];
  function validate(adapter) {
    if (!adapter || typeof adapter.id !== 'string' || !adapter.id ||
        required.some(method => typeof adapter[method] !== 'function')) throw new TypeError('播放引擎接口不完整');
    const state = adapter.snapshot();
    if (!state || typeof state.paused !== 'boolean' || !Number.isFinite(state.volume) ||
        state.volume < 0 || state.volume > 1) throw new TypeError('播放引擎状态无效');
    return adapter;
  }
  class EngineHost {
    constructor(adapter) {
      this.listeners = new Map(); this.generation = 0; this.disposed = false;
      this.install(validate(adapter));
    }
    install(adapter) {
      this.adapter = adapter;
      const generation = ++this.generation;
      this.unsubscribe = adapter.subscribe(type => {
        if (!this.disposed && generation === this.generation && events.includes(type)) this.dispatchEvent({ type });
      });
      if (typeof this.unsubscribe !== 'function') throw new TypeError('播放引擎订阅必须可释放');
    }
    snapshot() { return Object.freeze({ ...this.adapter.snapshot() }); }
    get info() { return Object.freeze({ id: this.adapter.id, name: this.adapter.name || this.adapter.id,
      capabilities: Object.freeze({ ...this.adapter.capabilities }) }); }
    addEventListener(type, callback, options = {}) {
      if (!callback || options?.signal?.aborted) return;
      const rows = this.listeners.get(type) || new Map();
      if (rows.has(callback)) return;
      const remove = () => this.removeEventListener(type, callback);
      rows.set(callback, { once: !!options?.once, signal: options?.signal, remove }); this.listeners.set(type, rows);
      options?.signal?.addEventListener('abort', remove, { once: true });
    }
    removeEventListener(type, callback) {
      const row = this.listeners.get(type)?.get(callback);
      row?.signal?.removeEventListener('abort', row.remove);
      this.listeners.get(type)?.delete(callback);
    }
    dispatchEvent(event) {
      for (const [callback, options] of [...(this.listeners.get(event.type) || [])]) {
        if (options.once) this.removeEventListener(event.type, callback);
        if (typeof callback === 'function') callback.call(this, event); else callback.handleEvent(event);
      }
      this['on' + event.type]?.call(this, event);
      return true;
    }
    async load(url, signal, expected = 0, timeout = 15000) {
      if (this.disposed) throw new Error('播放引擎已释放');
      this.cancelLoad();
      const control = new AbortController(), generation = this.generation, adapter = this.adapter;
      this.loading = control;
      const abort = () => control.abort();
      let timer, timedOut = false, cancelled;
      if (signal?.aborted) control.abort(); else signal?.addEventListener('abort', abort, { once: true });
      try {
        control.signal.throwIfAborted();
        const cancellation = new Promise((_, reject) => {
          cancelled = () => {
            try { adapter.stop(); } catch { /* Reject promptly even if an adapter cannot stop cleanly. */ }
            reject(new DOMException('媒体加载已取消', 'AbortError'));
          };
          control.signal.addEventListener('abort', cancelled, { once: true });
        });
        timer = setTimeout(() => { timedOut = true; control.abort(); }, timeout);
        await Promise.race([adapter.load({ url, signal: control.signal, expectedDuration: expected, timeout }), cancellation]);
        control.signal.throwIfAborted();
        if (generation !== this.generation) throw new DOMException('引擎已切换', 'AbortError');
      } catch (error) {
        if (timedOut) throw Object.assign(new Error('音源加载超时'), { mediaCode: 'timeout' });
        throw error;
      } finally {
        clearTimeout(timer); control.signal.removeEventListener('abort', cancelled);
        signal?.removeEventListener('abort', abort);
        if (this.loading === control) this.loading = null;
      }
    }
    cancelLoad() { this.loading?.abort(); this.loading = null; }
    play() { if (this.disposed) return Promise.reject(new Error('播放引擎已释放')); return this.adapter.play(); }
    pause() { if (!this.disposed) this.adapter.pause(); }
    stop() { this.cancelLoad(); if (!this.disposed) this.adapter.stop(); }
    seek(value) {
      if (this.disposed || this.info.capabilities.seek === false || !Number.isFinite(value)) return;
      const duration = this.duration;
      if (Number.isFinite(duration) && duration > 0) this.adapter.seek(Math.max(0, Math.min(duration, value)));
    }
    get paused() { return this.snapshot().paused; }
    get ended() { return this.snapshot().ended; }
    get seeking() { return this.snapshot().seeking; }
    get readyState() { return this.snapshot().readyState; }
    get error() { return this.snapshot().error; }
    get duration() { return this.snapshot().duration; }
    get currentTime() { return this.snapshot().position; }
    set currentTime(value) { this.seek(value); }
    get volume() { return this.snapshot().volume; }
    set volume(value) { if (!this.disposed && this.info.capabilities.volume !== false && Number.isFinite(value)) this.adapter.setVolume(Math.max(0, Math.min(1, value))); }
    get playbackRate() { return this.snapshot().rate; }
    set playbackRate(value) { if (!this.disposed && Number.isFinite(value) && value > 0 && this.info.capabilities.rate !== false) this.adapter.setRate(value); }
    get src() { return this.snapshot().url; }
    async enableSpectrum() { if (this.info.capabilities.spectrum && !this.disposed) await this.adapter.enableSpectrum?.(); }
    readSpectrum() { return this.info.capabilities.spectrum && !this.disposed ? this.adapter.readSpectrum?.() : null; }
    replace(candidate) {
      if (this.disposed) throw new Error('播放引擎已释放');
      validate(candidate);
      if (candidate === this.adapter) return;
      // Prepare the subscription and settings before disturbing the active decoder.
      const state = this.snapshot(), old = this.adapter, oldUnsubscribe = this.unsubscribe;
      let ready = false;
      const relay = type => { if (ready && this.adapter === candidate && events.includes(type)) this.dispatchEvent({ type }); };
      let unsubscribe;
      try {
        if (candidate.capabilities?.volume !== false) candidate.setVolume(state.volume);
        if (candidate.capabilities?.rate !== false) candidate.setRate(state.rate);
        unsubscribe = candidate.subscribe(relay);
        if (typeof unsubscribe !== 'function') throw new TypeError('播放引擎订阅必须可释放');
      } catch (error) { unsubscribe?.(); candidate.dispose(); throw error; }
      this.cancelLoad();
      try { old.stop(); }
      catch (error) { unsubscribe(); candidate.dispose(); throw error; }
      ++this.generation; oldUnsubscribe();
      this.adapter = candidate; this.unsubscribe = unsubscribe; ready = true;
      try { old.dispose(); } catch { /* A stopped old adapter cannot block the new adapter's controls. */ }
      this.dispatchEvent({ type: 'emptied' }); this.dispatchEvent({ type: 'enginechange' });
    }
    dispose() {
      if (this.disposed) return;
      this.stop(); this.disposed = true; ++this.generation; this.unsubscribe(); this.adapter.dispose();
      for (const [type, rows] of this.listeners) for (const callback of [...rows.keys()]) this.removeEventListener(type, callback);
      this.listeners.clear();
      for (const type of [...events, 'enginechange']) this['on' + type] = null;
    }
  }

  function createHtmlAudioEngine(element) {
    let disposed = false, pending, context, source, analyser, data;
    const subscribers = new Set();
    const handlers = events.map(type => {
      const handler = () => { if (!disposed) for (const callback of subscribers) callback(type); };
      element.addEventListener(type, handler); return [type, handler];
    });
    const stop = () => { pending?.abort(); pending = null; element.pause(); element.removeAttribute('src'); element.load(); };
    return {
      id: 'html-audio', name: 'Chromium / HTML Audio',
      capabilities: Object.freeze({ seek: true, volume: true, rate: true, spectrum: true }),
      snapshot: () => ({ paused: element.paused, ended: !!element.ended, seeking: !!element.seeking,
        readyState: element.readyState || 0, error: element.error ? { code: element.error.code, message: element.error.message } : null,
        duration: element.duration, position: element.currentTime || 0, volume: element.volume ?? 1,
        rate: element.playbackRate || 1, url: element.getAttribute?.('src') || element.src || '' }),
      subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
      async load({ url, signal, expectedDuration, timeout }) {
        if (disposed) throw new Error('播放引擎已释放');
        if (!/^\/api\/(?:proxy|audio)\?ticket=[a-f0-9]{48}$/.test(url))
          throw Object.assign(new Error('音源未通过本地网关'), { mediaCode: 'url' });
        stop();
        const control = new AbortController(); pending = control;
        const abort = () => { control.abort(); if (pending === control) stop(); };
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        try { await root.HigherPlayer.loadAudio(element, url, control.signal, timeout, expectedDuration); }
        finally { signal.removeEventListener('abort', abort); if (pending === control) pending = null; }
      },
      play: () => element.play(), pause: () => element.pause(), stop,
      seek: value => { element.currentTime = value; }, setVolume: value => { element.volume = value; },
      setRate: value => { element.playbackRate = value; },
      async enableSpectrum() {
        const AudioContext = root.AudioContext || root.webkitAudioContext;
        if (!AudioContext || disposed) return;
        if (!context) {
          context = new AudioContext();
          try {
            source = context.createMediaElementSource(element); source.connect(context.destination);
            analyser = context.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.7;
            source.connect(analyser); data = new Uint8Array(analyser.frequencyBinCount);
          } catch { analyser = null; /* Keep direct output if analysis fails. */ }
        }
        if (context.state === 'suspended') await context.resume();
      },
      readSpectrum() {
        if (!analyser || disposed) return null;
        analyser.getByteFrequencyData(data); return { data, sampleRate: context.sampleRate, fftSize: analyser.fftSize };
      },
      dispose() {
        if (disposed) return; stop(); disposed = true;
        for (const [type, handler] of handlers) element.removeEventListener(type, handler);
        subscribers.clear(); source?.disconnect(); analyser?.disconnect();
        context?.close().catch(() => {});
      },
    };
  }
  root.HigherMedia = { EngineHost, createHtmlAudioEngine, events };
})(globalThis);
