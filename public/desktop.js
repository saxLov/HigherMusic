// 桌面能力只在受控预加载桥存在时启用，网页模式保留原行为。
(() => {
  if (!window.higherDesktop) return;
  const desktop = window.higherDesktop;
  const importButton = $('importBackground');
  importButton.hidden = false;
  $('backgroundHint').textContent = '导入一张图片，为当前歌曲设置背景。';
  importButton.onclick = async () => {
    const songId = songs[index]?.id;
    if (!songId) return;
    importButton.disabled = true;
    try {
      const result = await desktop.importBackground();
      if (result.error) throw new Error(result.error);
      if (!result.canceled && songs[index]?.id === songId) {
        // AVIF 等格式由页面图片解码器确认可读后再保存映射。
        const image = new Image(); image.src = imagePath(result.name); await image.decode();
        saveBackground(result.name);
      }
    } catch (error) { $('backgroundHint').textContent = error.message || '图片导入失败'; }
    finally { importButton.disabled = false; }
  };
  try {
    const value = HigherSettings.getItem('highermusic.volume.v1');
    if (value !== null) audio.volume = Number(value);
    syncVolume();
  } catch {}
  audio.addEventListener('volumechange', () => {
    try { HigherSettings.setItem('highermusic.volume.v1', String(audio.volume)); }
    catch { status('音量设置无法保存'); }
  });
  desktop.onPower(event => {
    // 休眠期间不补算收听，唤醒后由用户继续播放。
    listening.suspend();
    if (event === 'suspend') audio.pause();
    if (event === 'resume' && playbackSession.loadedId) status('设备已唤醒，点击播放继续');
  });
  desktop.onPlaybackCommand(command => playbackCommand(command));
  const mediaSession = navigator.mediaSession;
  if (mediaSession) {
    const actions = {
      play: () => playbackCommand('play'), pause: () => playbackCommand('pause'),
      previoustrack: () => playbackCommand('previous'), nexttrack: () => playbackCommand('next'),
      seekto: ({ seekTime }) => playbackCommand('seek', seekTime),
      seekbackward: ({ seekOffset }) => playbackCommand('seek', audio.currentTime - (seekOffset || 10)),
      seekforward: ({ seekOffset }) => playbackCommand('seek', audio.currentTime + (seekOffset || 10)),
    };
    for (const [action, handler] of Object.entries(actions)) {
      try { mediaSession.setActionHandler(action, handler); } catch {}
    }
  }
  let describedSong;
  function publish() {
    const round = playbackSession.current;
    const song = round?.phase === 'started' ? round.song : null;
    const playing = !!song && !audio.paused && !audio.ended;
    desktop.publishPlayback({ title: song?.title ?? '', playing, available: songs.length > 0 });
    if (!mediaSession) return;
    mediaSession.playbackState = song ? (playing ? 'playing' : 'paused') : 'none';
    if (song === describedSong) return;
    describedSong = song;
    if (!song) { mediaSession.metadata = null; return; }
    if (window.MediaMetadata) {
      const artwork = /^\/api\/(?:proxy|artwork)\?ticket=[a-f0-9]{64}$/.test(song.cover ?? '')
        ? [{ src: new URL(song.cover, location.href).href }] : [];
      mediaSession.metadata = new window.MediaMetadata({ title: song.title, artist: song.artist, artwork });
    }
  }
  function publishPosition() {
    if (!mediaSession?.setPositionState) return;
    if (playbackSession.current?.phase !== 'started' || !Number.isFinite(audio.duration) || audio.duration <= 0)
      return mediaSession.setPositionState();
    mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.duration, audio.currentTime),
      playbackRate: audio.playbackRate || 1 });
  }
  for (const event of ['playing', 'pause', 'ended', 'emptied']) audio.addEventListener(event, publish);
  for (const event of ['seeked', 'durationchange', 'ratechange', 'emptied']) audio.addEventListener(event, publishPosition);
  document.addEventListener('higher:queue-changed', publish);
  document.addEventListener('higher:playback-started', () => { publish(); publishPosition(); });
  publish();
})();
