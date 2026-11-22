// Local file access is deliberately separate from account playlists and cloud history.
(() => {
  if (typeof window === 'undefined' || !window.higherDesktop?.importMusic) return;
  const dialog = $('localFilesDialog'), hint = $('localFilesHint'), list = $('localFilesList');
  const openButton = $('localFilesOpen'), importButton = $('importMusic'), queueButton = $('queueLocalFiles');
  openButton.hidden = false;
  let data = { tracks: [], unavailable: [] }, generation = 0, pending = false;

  function useQueue(selected) {
    if (busy || flashing || sliding) return status('请先停止检查或等待切歌结束');
    activePlaylistId = '';
    ++viewVersion;
    stopAudio();
    playbackQueue.reset(); checkedIds.clear();
    rawTracks = data.tracks.map(track => ({ ...track, inspection: {
      state: 'allowed', playbackState: 'allowed', playable: true } }));
    songs = rawTracks.map(track => cleanTrack(track));
    rejected = data.unavailable.map(track => ({ ...track, category: 'source', playbackReason: track.reason }));
    index = Math.max(0, songs.findIndex(track => track.id === selected));
    $('playlists').value = '';
    renderGallery(); renderRejected(); dialog.close();
    status(`${songs.length} 首本地音乐 · ${rejected.length} 首待确认`);
    if (selected && songs[index]?.id === selected) void playCurrent();
  }

  async function refresh() {
    const version = ++generation;
    hint.textContent = '正在读取本地音乐…';
    try {
      const next = await request('local-files');
      if (version !== generation || !dialog.open) return;
      data = next;
      const missing = new Map(data.unavailable.map(track => [track.id, track]));
      const unavailableQueued = songs.filter(track => missing.has(track.id));
      if (unavailableQueued.length) {
        const selected = songs[index]?.id;
        if (missing.has(selected)) stopAudio();
        songs = songs.filter(track => !missing.has(track.id));
        for (const track of rawTracks) if (missing.has(track.id)) track.inspection = {
          state: 'unknown', playbackState: 'unavailable', playable: false };
        rejected = rejected.filter(track => !missing.has(track.id)).concat(unavailableQueued.map(track => ({
          ...track, category: 'source', playbackReason: missing.get(track.id).reason })));
        index = Math.max(0, songs.findIndex(track => track.id === selected));
        renderGallery(); renderRejected();
      }
      queueButton.disabled = !data.tracks.length;
      hint.textContent = `${data.tracks.length} 首可用 · ${data.unavailable.length} 首待确认；同名 .lrc 文件会自动读取。`;
      list.replaceChildren();
      for (const [tracks, unavailable] of [[data.tracks, false], [data.unavailable, true]]) {
        for (const track of tracks) {
          const row = document.createElement('div'), name = document.createElement('strong');
          name.textContent = `${track.title} · ${track.artist}`;
          row.append(name);
          if (unavailable) {
            const reason = document.createElement('small'); reason.textContent = '音源待确认 · ' + track.reason; row.append(reason);
          } else {
            const play = document.createElement('button'); play.textContent = '播放';
            play.onclick = () => useQueue(track.id); row.append(play);
          }
          const remove = document.createElement('button'); remove.textContent = '移出曲库';
          remove.onclick = async () => {
            remove.disabled = true;
            try {
              await request('local-remove?track=' + encodeURIComponent(track.id), 'POST');
              if (songs[index]?.id === track.id) stopAudio();
              const selected = songs[index]?.id;
              songs = songs.filter(item => item.id !== track.id);
              rawTracks = rawTracks.filter(item => item.id !== track.id);
              rejected = rejected.filter(item => item.id !== track.id);
              index = Math.max(0, songs.findIndex(item => item.id === selected));
              renderGallery(); renderRejected(); await refresh();
            } catch (error) { hint.textContent = error.message; remove.disabled = false; }
          };
          row.append(remove); list.append(row);
        }
      }
    } catch (error) { if (version === generation) hint.textContent = error.message; }
  }
  openButton.onclick = () => { if (!dialog.open) dialog.showModal(); void refresh(); };
  $('refreshLocalFiles').onclick = refresh;
  queueButton.onclick = () => useQueue();
  importButton.onclick = async () => {
    if (pending) return;
    pending = true; importButton.disabled = true;
    hint.textContent = '请选择音乐文件，正在读取歌曲信息…';
    try {
      const result = await window.higherDesktop.importMusic();
      if (result.error) throw new Error(result.error);
      await refresh();
      if (!result.canceled) hint.textContent = `已导入 ${result.imported} 首 · ${result.failed} 个文件未通过检查。移出曲库不会删除原文件。`;
    } catch (error) { hint.textContent = error.message; }
    finally { pending = false; importButton.disabled = false; }
  };
})();
