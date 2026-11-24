/* 播放会话与媒体控件之间的连接。 */
/* stopAudio()：取消延迟播放和旧播放请求，暂停并清空 audio，清除歌词/唱片状态。
 * playbackSession.version 递增使尚未完成的旧异步结果失效，常用于换歌单或退出账号。 */
let preparationEpoch = 0, preparationTimer;
function cancelPreparation() {
  clearTimeout(preparationTimer);
  if ($('scan').hidden) void request('prepare', 'POST', () => true, { body: { tracks: [], epoch: ++preparationEpoch } }).catch(() => {});
}
function prepareNextSongs() {
  clearTimeout(preparationTimer);
  const song = songs[index], version = viewVersion, round = playbackSession.version;
  if (!song || song.provider === 'local' || $('mode').value === 'single') return;
  preparationTimer = setTimeout(() => {
    if (round !== playbackSession.version || version !== viewVersion) return;
    const rows = rawTracks.some(t => t.id === song.id) ? rawTracks : songs;
    const at = rows.findIndex(t => t.id === song.id);
    const candidates = $('mode').value === 'shuffle' ? rows.filter(t => t.id !== song.id) : rows.slice(at + 1).concat(rows.slice(0, at));
    const tracks = [...new Set(candidates.filter(t => t.provider !== 'local' && (!t.inspection?.sourceChecked || t.inspection?.playable)).map(t => t.id))].slice(0,5);
    const epoch = ++preparationEpoch;
    void request('prepare', 'POST', () => version === viewVersion && round === playbackSession.version, { body: { tracks, epoch } }).then(data => {
      if (epoch !== preparationEpoch || version !== viewVersion || round !== playbackSession.version) return;
      for (const item of data.items || []) { const raw = rawTracks.find(t => t.id === item.id); if (raw) { raw.inspection = item.inspection; checkedIds.add(raw.id); } }
      refreshPlayableGallery(); renderPlaylistBrowser();
    }).catch(() => {});
  }, 600);
}
function stopAudio() {
  cancelSearchJump();
  cancelPreparation();
  automaticSeek = null;
  clearTimeout(playTimer);
  playTimer = null;
  listening.reset();
  resetFailedRun();
  playbackSession.cancel();
  stopLyricSync();
  resetLyrics('让音乐慢下来。');
  $('currentSource').textContent = '';
  $('playbackDiagnostics').hidden = true;
  $('playbackDiagnosticsText').textContent = '';
  $('vinyl').classList.remove('playing');
  $('vinyl').classList.remove('loading');
}

/* loadSource()：尝试一条主/备音源。signal 控制切歌取消，expected 是预期完整时长（秒）。
 * 只在 playing 事件发生后成功；时长过短、加载失败、超时或取消都会退出并清理事件。 */
function loadSource(url, signal, expected) {
  return mediaEngine.load(url, signal, expected);
}
const failedRun = new Set();
const failedDiagnostics = [];
function resetFailedRun() {
  failedRun.clear();
  failedDiagnostics.length = 0;
}
function releaseMedia() {
  mediaEngine.stop();
}
const playbackSession = new HigherPlayback.PlaybackSession({
  resolve: (id, query, current, signal) =>
    request((id.startsWith('file:') ? 'local-play' : 'play') + '?track=' + encodeURIComponent(id) + query, 'POST', current, { signal }),
  load: (url, signal, duration) => loadSource(url, signal, duration),
  normalize: (song, reply) => cleanTrack({ ...song, audio: '' }, reply),
  isPlayable,
  media: { release: releaseMedia, isPaused: () => audio.paused,
    play: () => audio.play(), pause: () => audio.pause() },
});
function syncEngineCapabilities() {
  const { capabilities, name } = mediaEngine.info;
  $('seek').disabled = capabilities.seek === false;
  $('volume').disabled = capabilities.volume === false;
}
mediaEngine.addEventListener('enginechange', () => {
  stopAudio(); syncEngineCapabilities(); status('播放引擎已切换，点击播放重新开始');
});
syncEngineCapabilities();

function skipUnavailable(song) {
  failedRun.add(song.id);
  const mode = $('mode').value || playbackQueue.mode;
  if (mode === 'single') return;
  const remaining = songs.filter(item => !failedRun.has(item.id));
  if (!remaining.length) { status('播放队列暂时没有可播放的歌曲'); return; }
  if (failedRun.size >= 5) { status('已连续遇到 5 首暂不可播的歌曲，自动跳过已停止'); return; }
  const next = mode === 'shuffle'
    ? songs.findIndex(item => item.id === playbackQueue.next(remaining.map(row => row.id), song.id))
    : Array.from({ length: songs.length - 1 }, (_, offset) => wrapIndex(index + offset + 1))
      .find(position => !failedRun.has(songs[position].id));
  if (next >= 0) goTo(next, true, 1, true);
}
/* 将播放会话事件映射到画廊、歌词和历史界面。 */
async function playCurrent(resumeAt = 0, recovering = false) {
  const song = songs[index];
  if (!song) return;
  clearTimeout(playTimer);
  playTimer = null;
  automaticSeek = null;
  if (recovering) listening.suspend();
  else listening.reset();
  const round = playbackSession.begin(song, { recovering, onStarted });
  const { version, signal } = round;
  resetLyrics();
  $('currentSource').textContent = '正在加载音源…';
  $('vinyl').classList.add('loading');
  const diagnostics = [];
  function showDiagnostics(line) {
    if (version !== playbackSession.version) return;
    diagnostics.push(line);
    $('playbackDiagnosticsText').textContent = [...failedDiagnostics, song.title, ...diagnostics].join('\n');
    $('playbackDiagnostics').hidden = false;
  }
  async function readDiagnostics(url, source, result) {
    const ticket = url?.match(/^\/api\/(?:proxy|audio)\?ticket=([a-f0-9]{48})$/)?.[1];
    let data;
    if (ticket) {
      try {
        data = await request('audio-status?ticket=' + ticket, 'GET',
          () => version === playbackSession.version && !signal.aborted, { priority: 10, signal });
      } catch {}
    }
    const protocols = data?.protocols?.map((value) => value.slice(0, -1).toUpperCase()).join(' / ');
    const lines = [source + ' · ' + result + (protocols ? ' · 平台原始协议 ' + protocols : '')];
    for (const attempt of data?.attempts ?? []) {
      const engine = attempt.transport === 'disk' ? '本地磁盘' : attempt.transport === 'chromium' ? 'Chromium' : 'Node';
      const host = attempt.failedHost || attempt.responseHost || attempt.host;
      const outcome = attempt.error === 'aborted' ? '请求已中止'
        : attempt.error || (attempt.status ? 'HTTP ' + attempt.status : '等待响应');
      const stream = attempt.streamError ? ' · 读流中断' : attempt.receivedAudio ? ' · 已读到媒体字节' : '';
      const fallback = { attempted: '尝试原发 HTTP', no_original_http: '无符合条件的原发 HTTP',
        hostname_mismatch: '证书错误主机不匹配', cancelled: 'HTTP 回退已取消' }[attempt.httpFallback];
      const protocol = attempt.protocol?.slice(0, -1).toUpperCase();
      lines.push([engine, protocol, host, outcome, fallback].filter(Boolean).join(' · ') + stream);
    }
    showDiagnostics(lines.join('\n'));
    return data?.failure;
  }
  function onStarted(active, historyAllowed) {
    Object.assign(song, active);
    song.pendingSelection = false;
    $('vinyl').classList.remove('loading');
    const raw = rawTracks.find(t => t.id === song.id);
    if (raw) { raw.inspection = { ...raw.inspection, state: 'allowed', playbackState: 'allowed', playable: true, sourceChecked: true }; checkedIds.add(raw.id); }
    renderPlaylistBrowser();
    prepareNextSongs();
    if (active.playbackToken) {
      void request(song.provider === 'local' ? 'local-started' : 'play-started', 'POST', () => playbackSession.isCurrent(round), {
        signal, priority: 10, body: { songId: song.id, playbackToken: active.playbackToken },
      }).catch(() => {});
    }
    failedRun.clear();
    playbackQueue.select(song.id);
    if (!historyAllowed) {
      if (recovering) listening.cancelPending();
      listening.reset();
    } else if (!recovering || !listening.round || listening.round.songId !== song.id) listening.begin(song, audio);
    else listening.round.playbackToken = song.playbackToken;
    if (resumeAt > 0 && Number.isFinite(audio.duration)) {
      const target = Math.min(resumeAt, Math.max(0, audio.duration - 0.1));
      automaticSeek = { version, target };
      listening.suspend();
      audio.currentTime = target;
      // 某些媒体在同位置赋值时不会派发 seeked。
      if (!audio.seeking) { automaticSeek = null; listening.resume(audio); }
    } else listening.resume(audio);
    $('currentSource').textContent = '当前音源：' + (song.playbackSource?.name ?? '酷狗') +
      (song.playbackSource?.fallback ? '（备用）' : '') + (song.quality ? ' · ' + song.quality : '');
    status('正在播放');
    document.dispatchEvent(new Event('higher:playback-started'));
    void loadLyrics(song, version, showDiagnostics, signal);
  }
  status('正在确认并加载 ' + song.title);
  try {
    await playbackSession.run(round, {
      onReply(reply) {
        if (reply.selectionHit) showDiagnostics('音源准备缓存 · 命中，无需重复取链');
        if (reply.cacheHit) showDiagnostics('音频缓存 · 本地磁盘命中');
        rememberLocal(reply.localPlaylist);
        if (reply.audioScheduling) {
          const { backup, elapsedMs } = reply.audioScheduling;
          const outcome = { not_started: '未启动备用', cancelled: '已停止备用准备',
            unused: '备用已就绪，采用酷狗', selected: '采用同录音备用音源',
            unavailable: '没有可用备用音源' }[backup];
          if (outcome) showDiagnostics(`音源选择 · ${outcome} · ${elapsedMs} ms`);
        }
        if (reply.kugouSelection) {
          const { entitlement, source } = reply.kugouSelection;
          showDiagnostics(['酷狗取链', entitlement, source].filter(Boolean).join(' · '));
        }
      },
      onRejected(reply) {
        const original = rawTracks.find(track => track.id === song.id);
        if (original) original.inspection = reply;
      },
      onDiagnostic: readDiagnostics,
    });
    if (playbackSession.isCurrent(round) && round.phase === 'gesture') status('请再次点击播放按钮');
  } catch (e) {
    if (!playbackSession.isCurrent(round) || e.name === 'AbortError') return;
    const triedToken = round.candidate?.reply.playbackToken;
    releaseMedia();
    resetLyrics('暂无可播放音源');
    showDiagnostics(e.message);
    status('此歌曲暂不可播放');
    failedDiagnostics.push(song.title + ' · ' + e.message);
    if (failedDiagnostics.length > 5) failedDiagnostics.shift();
    if (!e.unavailable) return;
    const raw = rawTracks.find(track => track.id === song.id);
    const reason = { state: 'unknown', ...raw?.inspection, playbackState: 'unknown',
      playbackReason: e.message, playable: false, sourceChecked: true };
    if (raw) { raw.inspection = reason; checkedIds.add(raw.id); }
    rejected = rejected.filter(track => track.id !== song.id);
    rejected.push({ ...(raw ?? song), ...accessSummary(reason) });
    renderRejected();
    if (triedToken && song.provider !== 'local') void request('source-unavailable', 'POST', () => true, {
      priority: 10, body: { songId: song.id, playbackToken: triedToken },
    }).then(result => rememberLocal(result.localPlaylist)).catch(() => {});
    skipUnavailable(song);
    const removed = songs.indexOf(song);
    if (activePlaylistId) renderGallery();
    if (removed >= 0 && !activePlaylistId) {
      songs.splice(removed, 1);
      if (removed < index) index--;
      index = Math.min(index, Math.max(0, songs.length - 1));
      renderGallery();
    }
  } finally {
    if (version === playbackSession.version) $('vinyl').classList.remove('loading');
  }
}
// UI 立即提交，音频请求短暂合并；任何下载/权限请求都不能阻塞画廊。
/* goTo()：切到目标索引，立即更新画廊，120ms 合并后再异步加载音频。
 * directionHint 指定移动方向；随机远跳同样复用一格位移，不因索引距离而省略动画。 */
function goTo(target, animate = true, directionHint = 0, automatic = false) {
  if (flashing || !songs.length) return;
  target = wrapIndex(target);
  if (target === index) return;
  if (!automatic) resetFailedRun();
  const direction = directionHint || Math.sign(target - index);
  const center = galleryCenter();
  // 首尾相邻仍按一格处理；搜索跨 2–3 首时一次平移对应格数。
  const distance = wrapIndex(center + direction) === target
    ? 1
    : Math.abs(target - center);
  const steps = distance >= 1 && distance <= 3 ? distance : 1;
  galleryBrowse = null;
  clearTimeout(playTimer);
  automaticSeek = null;
  listening.reset();
  playbackSession.cancel();
  resetLyrics();
  const recycled = [];
  if (animate && !reducedMotion.matches) {
    for (let n = 0; n < steps; n++) {
      const card = direction > 0 ? cards.shift() : cards.pop();
      if (direction > 0) cards.push(card);
      else cards.unshift(card);
      card.style.transition = 'none';
      recycled.push(card);
    }
  }
  index = target;
  renderGallery(recycled.length === 0);
  if (recycled.length) {
    void $('rail').offsetWidth;
    for (const card of recycled) card.style.transition = '';
  }
  playTimer = setTimeout(() => {
    playTimer = null;
    playCurrent();
  }, 120);
}
/* advance()：上一首/下一首的统一入口，direction 为 -1/+1；ended 表示自然播放完毕。
 * 顺序模式首尾循环；单曲循环只在自然结束时重播；随机模式维护真实历史和一轮不重复的抽签袋。 */
function advance(direction, ended = false) {
  if (!songs.length || flashing) return;
  if ($('mode').value && playbackQueue.mode !== $('mode').value) playbackQueue.setMode($('mode').value);
  const ids = songs.map((song) => song.id);
  const current = songs[index].id;
  const target = direction < 0 ? playbackQueue.previous(ids, current)
    : playbackQueue.next(ids, current, { ended });
  if (!target) return;
  if (target === current) { if (ended) playCurrent(); return; }
  goTo(ids.indexOf(target), true, direction);
}

/* recordState()：切换唱机外壳的 is-playing 类；CSS 据此让唱臂落下或抬起，唱片旋转另由 vinyl.playing 控制。 */
function recordState(playing) {
  document.querySelector('.record-deck').classList.toggle('is-playing', playing);
}
/* 【播放按钮】上一首/下一首走统一 advance；改变播放模式时清空随机抽签袋。 */
$('previous').onclick = () => playbackCommand('previous');
$('next').onclick = () => playbackCommand('next');
$('mode').onchange = () => {
  playbackQueue.setMode($('mode').value);
  cancelPreparation(); prepareNextSongs();
  $('previous').disabled = $('next').disabled = !songs.length;
};
/* 【播放/暂停】尚未加载当前曲时重新确认音源；否则沿用当前 audio 进度继续或暂停。 */
function playbackCommand(command, position) {
  if (command === 'pause') {
    if (searchJumpControl) { stopAudio(); return; }
    if (playbackSession.loading) stopAudio();
    else audio.pause();
    return;
  }
  if (command === 'previous' || command === 'next') return advance(command === 'previous' ? -1 : 1);
  if (command === 'seek') {
    if (playbackSession.loadedId && Number.isFinite(audio.duration) && audio.duration > 0 && Number.isFinite(position)) {
      automaticSeek = null;
      listening.seek();
      audio.currentTime = Math.max(0, Math.min(audio.duration, position));
    }
    return;
  }
  if (flashing || sliding) return;
  if (!['play', 'toggle'].includes(command) || (command === 'play' && !audio.paused)) return;
  playbackSession.toggle(songs[index]?.id, () => { resetFailedRun(); return playCurrent(); })
    ?.catch(() => status('请再次点击播放'));
}
$('toggle').onclick = () => playbackCommand('toggle');

audio.addEventListener('timeupdate', () => listening.tick(audio));
audio.addEventListener('playing', () => {
  playbackSession.mediaPlaying();
  if (!automaticSeek && !playbackSession.loading) listening.resume(audio);
});
for (const event of ['pause', 'waiting', 'ended', 'emptied', 'error'])
  audio.addEventListener(event, () => listening.suspend());
audio.addEventListener('seeking', () => {
  if (automaticSeek?.version === playbackSession.version && Math.abs(audio.currentTime - automaticSeek.target) < 0.2) listening.suspend();
  else { automaticSeek = null; listening.seek(); }
});
audio.addEventListener('seeked', () => {
  automaticSeek = null;
  if (!audio.paused) listening.resume(audio);
});
audio.addEventListener('ratechange', () => listening.resume(audio));
// 中途故障最多自动刷新一次音源，保留进度；不重试历史提交，不恢复拖动后的上报资格。
function scheduleRecovery(immediate = false) {
  if (flashing) return;
  playbackSession.scheduleRecovery(immediate ? 0 : 12000,
    round => songs[index]?.id === round.song.id && !audio.ended && (!audio.paused || !!audio.error),
    () => {
      status('音源中断，正在恢复播放…');
      playCurrent(audio.currentTime, true);
    });
}
audio.addEventListener('waiting', () => scheduleRecovery());
audio.addEventListener('stalled', () => scheduleRecovery());
audio.addEventListener('error', () => scheduleRecovery(true));
audio.addEventListener('pause', () => playbackSession.clearRecovery());
/* 【媒体事件】唱片旋转和唱臂状态随实际 audio 事件更新；歌词从 playing 才启动逐帧同步。 */
audio.onplay = () => { /* UI playback state starts at real playing below. */ };
audio.onplaying = () => {
  startLyricSync();
  recordState(true);
  $('toggle').textContent = 'Ⅱ';
  $('vinyl').classList.add('playing');
};

audio.onpause = () => {
  recordState(false);
  stopLyricSync();
  updateLyrics();
  $('toggle').textContent = '▶';
  $('vinyl').classList.remove('playing');
  if (!playbackSession.loading && playbackSession.loadedId) status('已暂停');
};
audio.onended = () => {
  recordState(false);
  stopLyricSync();
  advance(1, true);
};
audio.onseeking = audio.onseeked = updateLyrics;
audio.addEventListener('emptied', stopLyricSync);
/* 页面切到后台先停歌词逐帧任务，回到前台按当前音频时间重新定位，不从旧歌词继续数。 */
document.addEventListener('visibilitychange', () => {
  stopLyricSync();
  updateLyrics();
  if (!document.hidden) startLyricSync();
});
/* 【进度栏】timeupdate 只刷新时间文字和滑块；歌词使用更细的 requestAnimationFrame。 */
audio.ontimeupdate = () => {
  $('elapsed').textContent = time(audio.currentTime);
  $('duration').textContent = time(audio.duration);
  $('seek').value =
    Number.isFinite(audio.duration) && audio.duration > 0
      ? (audio.currentTime / audio.duration) * 1000
      : 0;
};
/* 进度滑块范围 0…1000，按比例转换成音频秒数，duration 有效时才允许跳转。 */
$('seek').oninput = () => playbackCommand('seek', (Number($('seek').value) / 1000) * audio.duration);
/* 音量滑块是 0…1；修改后同步可视填色与无障碍描述。 */
$('volume').oninput = () => {
  audio.volume = Number($('volume').value);
  syncVolume();
};
/* syncVolume()：把 audio.volume 的 0…1 同步为滑块数值、百分比填色和无障碍提示。 */
function syncVolume() {
  const value = Math.round(audio.volume * 100);
  $('volume').value = audio.volume;
  $('volume').style.setProperty('--volume-level', value + '%');
  $('volume').setAttribute('aria-valuetext', value + '%');
  $('volumeControl').title = '音量 ' + value + '%';
}
audio.onvolumechange = syncVolume;
/* 【可调参数】页面初始音量 70%；此处不会从浏览器存储恢复音量。 */
audio.volume = 0.7;
syncVolume();
