/* 播放会话只管理命令、候选和实际起播。渲染、队列以及平台请求由调用方接入。 */
(function (root) {
  class PlaybackSession {
    constructor({ resolve, load, normalize, isPlayable, media }) {
      Object.assign(this, { resolve, load, normalize, isPlayable, media });
      this.version = 0;
      this.current = null;
    }
    get loading() {
      return ['resolving', 'loading'].includes(this.current?.phase);
    }
    get loadedId() {
      return ['started', 'gesture'].includes(this.current?.phase) ? this.current.song.id : '';
    }
    isCurrent(round) {
      return this.current === round && !round.controller.signal.aborted;
    }
    clearRecovery() {
      clearTimeout(this.recoveryTimer);
    }
    cancel() {
      const previous = this.current;
      this.current = null;
      this.version++;
      this.clearRecovery();
      previous?.controller.abort();
      this.media.release();
    }
    begin(song, { recovering = false, onStarted }) {
      const previous = this.current;
      const recoveryAttempts = recovering && previous?.song.id === song.id ? previous.recoveryAttempts : 0;
      this.cancel();
      const controller = new AbortController();
      return this.current = { song, version: this.version, controller, signal: controller.signal,
        phase: 'resolving', recoveryAttempts, onStarted };
    }
    toggle(songId, start) {
      if (this.loading) return;
      if (!this.loadedId || this.loadedId !== songId) return start();
      if (this.media.isPaused()) return this.media.play();
      this.media.pause();
    }
    scheduleRecovery(delay, canRecover, recover) {
      const round = this.current;
      if (round?.phase !== 'started' || round.recoveryAttempts >= 1) return;
      this.clearRecovery();
      this.recoveryTimer = setTimeout(() => {
        if (!this.isCurrent(round) || !canRecover(round)) return;
        round.recoveryAttempts++;
        recover();
      }, delay);
    }
    commit(round) {
      if (!this.isCurrent(round) || round.phase === 'started' || !round.candidate) return;
      const { media, reply } = round.candidate;
      const source = reply.playbackSource;
      round.active = { audio: media.audio, urls: media.urls, duration: media.duration,
        playbackSource: source, playbackToken: reply.playbackToken, quality: reply.quality };
      round.phase = 'started';
      round.onStarted(round.active, !source || (source.provider === 'kugou' && source.history !== false));
    }
    mediaPlaying() {
      this.clearRecovery();
      if (this.current?.phase === 'gesture') this.commit(this.current);
    }
    async run(round, { onReply, onRejected, onDiagnostic }) {
      const { song, signal } = round;
      const current = () => this.isCurrent(round);
      let lastFailure;
      const request = (query) => this.resolve(song.id, query, current, signal);
      const tryCandidate = async (reply, media) => {
        if (!current()) return false;
        round.candidate = { media, reply };
        round.phase = 'loading';
        for (const url of media.urls) {
          signal.throwIfAborted();
          try {
            await this.load(url, signal, media.duration);
            if (!current()) return false;
            void onDiagnostic(url, reply.playbackSource?.name ?? '音源', '起播成功');
            return true;
          } catch (error) {
            if (!current() || ['AbortError', 'NotAllowedError'].includes(error.name)) throw error;
            const source = reply.playbackSource?.name ?? '音源';
            const problem = await onDiagnostic(url, source, error.message);
            lastFailure = { error, source, problem };
          }
        }
        return false;
      };
      try {
        const initial = await request('');
        if (!current()) return;
        onReply(initial);
        const media = this.normalize(song, initial);
        if (!this.isPlayable(initial, media)) {
          onRejected(initial);
          throw Object.assign(new Error(initial.reason || '暂无可播放的完整音源'), { unavailable: true });
        }
        let loaded = await tryCandidate(initial, media);
        const retry = async (query) => {
          if (!current()) return false;
          round.phase = 'resolving';
          let reply;
          try { reply = await request(query); } catch { return false; }
          if (!current()) return false;
          const next = this.normalize(song, reply);
          if (!this.isPlayable(reply, next)) {
            onDiagnostic(null, '备用音源', reply.reason || '未取得可用的备用音源');
            return false;
          }
          return tryCandidate(reply, next);
        };
        let delayedAuthorized = false;
        if (!loaded && current() && initial.playbackSource?.provider === 'kugou') {
          const failure = lastFailure?.problem;
          delayedAuthorized = failure?.code === 'redirect' || failure?.code === 'invalid_media' ||
            [403, 404].includes(failure?.status) || /^(?:ERR_TLS_|CERT_|ERR_CERT_)/.test(failure?.detail ?? '');
          loaded = await retry(delayedAuthorized ? '&alternate=1' : '&retry=authorized');
          if (!loaded && !delayedAuthorized) loaded = await retry('&alternate=1');
        }
        const selected = round.candidate?.reply;
        if (!loaded && selected?.playbackSource?.provider === 'netease' && selected.quality !== '128k')
          loaded = await retry('&retry=standard');
        if (!loaded && delayedAuthorized) loaded = await retry('&retry=authorized');
        if (!current()) return;
        if (loaded) this.commit(round);
        else {
          const problem = lastFailure?.error.mediaCode === 'duration' ? null : lastFailure?.problem;
          const reasons = { redirect: '线路跳转地址无法验证', invalid_media: '线路返回了无效的音频响应',
            connection: '连接音频线路失败', timeout: '音频线路响应超时' };
          const reason = problem?.code === 'http' ? '线路拒绝或无法提供音频（HTTP ' + problem.status + '）'
            : reasons[problem?.code] ?? lastFailure?.error?.message ?? '音源无法加载';
          const detail = problem?.detail ? '（' + problem.detail + '）' : '';
          throw Object.assign(new Error((lastFailure?.source ? lastFailure.source + '：' : '') + reason + detail),
            { unavailable: true });
        }
      } catch (error) {
        if (!current()) return;
        if (error.name === 'NotAllowedError') { round.phase = 'gesture'; return; }
        round.phase = 'failed';
        throw error;
      }
    }
  }
  root.HigherPlayback = { PlaybackSession };
})(globalThis);
