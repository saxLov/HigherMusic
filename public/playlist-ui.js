/* 歌单检查、待确认列表与本地歌单编辑。 */
function accessSummary(result) {
  return { state: result.eligibilityState ?? result.state, eligible: result.eligible,
    entitlement: result.entitlement, entitlementReason: result.entitlementReason ?? result.reason,
    reason: result.entitlementReason ?? result.reason, playbackState: result.playbackState,
    playbackReason: result.playbackReason, diagnostics: result.diagnostics };
}
function accessCategory(track) {
  if (track.category) return track.category;
  if (track.state === 'unavailable') return 'catalogue';
  if (/试听/.test(track.playbackReason || '')) return 'preview';
  if (track.eligible) return 'source';
  return 'rights';
}

/* rememberLocal()：把后端返回的虚拟歌单计数合并到下拉列表；local 为空时不做任何操作。 */
function rememberLocal() {}
/* renderPlaylists()：重建歌单下拉项，给本地虚拟歌单显示数量，并尽量保留当前选中值。 */
function renderPlaylists() {
  const value = $('playlists').value;
  $('playlists').replaceChildren(new Option('选择你的歌单', ''));
  for (const p of playlistRows.filter(p => !p.local && !p.editable && !p.id.startsWith("local:")))
    $('playlists').add(new Option((p.editable ? '本地 · ' : '') + p.name + (p.local ? `（${p.count}）` : ''), p.id));
  $('playlists').value = value;
}
/* loadPlaylists()：读取当前账号歌单，保存到 playlistRows 后更新下拉框；不自动替用户选择或播放。 */
async function loadPlaylists() {
  const accountVersion = loginVersion;
  const d = await request('playlists');
  if (accountVersion !== loginVersion || $('scan').hidden === false) return;
  playlistRows = d.playlists || [];
  renderPlaylists();
  if (d.snapshot) void request('playlists?refresh=1', 'GET', () => accountVersion === loginVersion).then(fresh => {
    if (accountVersion !== loginVersion) return;
    playlistRows = fresh.playlists || playlistRows; renderPlaylists();
  }).catch(() => {});
  status(d.remoteUnavailable ? '酷狗歌单暂不可用，请稍后重试' : '选择一份歌单，点播放时自动选源');
}

/* selectPlaylist()：选择普通歌单时重置播放/随机历史，先显示元数据，不自动逐首检查。
 * 本地“暂不可播放”只打开结果弹窗；viewVersion 用来隔离先前歌单请求。 */
let browsePlaylist = { id: '', name: '', tracks: [], selected: '', status: 'empty', version: 0 };
function updateGalleryEntry() {
  $('enterGallery').disabled = browsePlaylist.status !== 'ready';
  const active = playlistRows.find(p => p.id === activePlaylistId)?.name || (songs.length ? '当前队列' : '尚未进入');
  $('playlistSelectionHint').textContent = `当前选择：${browsePlaylist.name || '未选择'} · 画廊：${active}`;
  if (browsePlaylist.status === 'loading') $('playlistSelectionHint').textContent += ' · 正在读取…';
  if (browsePlaylist.status === 'error') $('playlistSelectionHint').textContent += ' · 读取失败，请重新选择重试';
  $('check').title = '检查当前画廊：' + active;
  $('activeCheckHint').textContent='权限检查作用于画廊：'+active;
}
async function selectPlaylist() {
  const id = $('playlists').value;
  const version = browsePlaylist.version + 1;
  browsePlaylist = { id, name: playlistRows.find(p => p.id === id)?.name || '', tracks: [], selected: '', status: id ? 'loading' : 'empty', version };
  playlistPage = 0; $('playlistFilter').value = ''; $('playlistBrowseList').scrollTop=0;
  updateGalleryEntry(); renderPlaylistBrowser();
  if (!id) return;
  const apply = data => {
    if (browsePlaylist.version !== version) return;
    const old = new Map(browsePlaylist.tracks.map(t => [t.id,t.inspection]));
    browsePlaylist.tracks = (data.tracks || []).map(t => ({...t,inspection:old.get(t.id) ?? t.inspection}));
    browsePlaylist.status = 'ready';
    rememberLocal(data.localPlaylist);updateGalleryEntry();renderPlaylistBrowser();
  };
  try {
    const data = await request('tracks?playlist=' + encodeURIComponent(id), 'GET', () => browsePlaylist.version === version);
    apply(data);
    if(data.snapshot && browsePlaylist.version === version) void request('tracks?playlist='+encodeURIComponent(id)+'&refresh=1','GET',()=>browsePlaylist.version===version).then(apply).catch(()=>{});
  } catch(error) {
    if(browsePlaylist.version!==version)return;
    browsePlaylist.status='error';updateGalleryEntry();renderPlaylistBrowser();
  }
}
async function enterSelectedGallery() {
  if(browsePlaylist.status!=='ready')return;
  if(busy || sliding || flashing)return status('请先结束检查或等待切歌动画');
  const chosen=browsePlaylist;
  ++viewVersion;stopAudio();playbackQueue.reset();checkedIds.clear();
  activePlaylistId=chosen.id;
  rawTracks=chosen.tracks.map(t=>({...t}));
  songs=rawTracks.map(t=>cleanTrack(t));
  rejected=rawTracks.filter(t=>t.inspection?.sourceChecked&&!isPlayable(t.inspection,{})).map(t=>({...t,...accessSummary(t.inspection)}));
  for(const t of rawTracks)if(t.inspection)checkedIds.add(t.id);
  index=Math.max(0,songs.findIndex(t=>t.id===chosen.selected));
  if(document.body.classList.contains('immersive'))toggleImmersive();
  renderGallery();renderRejected();updateGalleryEntry();
  if(window.HigherPanels)await HigherPanels.close();
  status(`${songs.length} 首`);
}
$('enterGallery').onclick=enterSelectedGallery;
function applyPlaylistTracks(data) {
  const previous = new Map(rawTracks.map(t => [t.id,t.inspection]));
  rawTracks = (data.tracks || []).map(t => ({ ...t, inspection: previous.get(t.id) ?? t.inspection }));
  rejected = []; checkedIds.clear();
  rememberLocal(data.localPlaylist);
  for (const track of rawTracks) if (track.inspection) {
    checkedIds.add(track.id);
    if (track.inspection.sourceChecked && !isPlayable(track.inspection, {})) rejected.push({ ...track, ...accessSummary(track.inspection) });
  }
  refreshPlayableGallery(); renderRejected(); renderPlaylistBrowser();
}
function refreshPlayableGallery() {
  const selected = songs[index]?.id;
  const existing = new Map(songs.map(song => [song.id, song]));
  const playlistIds = new Set(rawTracks.map(track => track.id));
  const next = rawTracks.filter(track => activePlaylistId || (track.inspection && isPlayable(track.inspection, {})) || (track.id === selected && existing.get(track.id)?.pendingSelection))
    .map(track => existing.get(track.id) ?? cleanTrack(track))
    .concat([...existing.values()].filter(song => !playlistIds.has(song.id)));
  if (next.length === songs.length && next.every((song, position) => song === songs[position])) return;
  songs = next;
  const position = songs.findIndex(song => song.id === selected);
  if (selected && position < 0 && (playbackSession.loadedId || playbackSession.loading)) stopAudio();
  index = position < 0 ? Math.min(index, Math.max(0, songs.length - 1)) : position;
  renderGallery();
}
/* checkAll()：串行检查 rows 的完整音源；可以中途请求停止，但当前请求结束后才真正退出。
 * 用 Map 按歌曲 ID 合并成功与失败，逐首更新画廊；finally 恢复按钮和进度条。 */
async function checkAll(rows = rawTracks.filter((t) => !checkedIds.has(t.id)), version = viewVersion, fresh = false) {
  if (busy) return;
  if (sliding || flashing) return status('请等待切歌动画结束');
  busy = true;
  if (fresh) stopAudio();
  let refreshIncomplete = false;
  let accountRefreshed = false;
  stopCheck = false;
  $('check').textContent = '停止检查';
  $('playlists').disabled = false;
  const failures = new Map(rejected.map((t) => [t.id, t]));
  try {
    for (let n = 0; n < rows.length; n++) {
      if (stopCheck || version !== viewVersion) break;
      const raw = rows[n];
      status(`确认音源 ${n + 1}/${rows.length}：${raw.title}`);
      $('progress').style.width = `${((n + 1) / rows.length) * 100}%`;
      try {
        const refreshAccount = fresh && !accountRefreshed && (!raw.provider || raw.provider === 'kugou');
        const result = await request((raw.provider === 'local' ? 'local-inspect' : 'inspect') + '?track=' + encodeURIComponent(raw.id) + (fresh ? '&fresh=1' : '') + (refreshAccount ? '&accountFresh=1' : ''), 'POST', () => version === viewVersion && !stopCheck, { priority: -10 });
        if (version !== viewVersion) break;
        if (refreshAccount) accountRefreshed = !result.refreshIncomplete;
        refreshIncomplete ||= !!result.refreshIncomplete;
        rememberLocal(result.localPlaylist);
        checkedIds.add(raw.id);
        raw.inspection = result;
        const listed = rawTracks.find(item => item.id === raw.id);
        if (listed) listed.inspection = result;
        if (isPlayable(result, {})) failures.delete(raw.id);
        else failures.set(raw.id, { ...raw, ...accessSummary(result) });
      } catch (e) {
        if (e.name === 'AbortError') break;
        refreshIncomplete = true;
        failures.set(raw.id, { ...raw, category: 'network', reason: '检查请求失败，可重试', playbackReason: e.message });
      }
      if (version !== viewVersion) break;
      rejected = [...failures.values()];
      refreshPlayableGallery(); renderPlaylistBrowser();
    }
  } finally {
    busy = false;
    $('check').textContent = '重新检查权限';
    $('playlists').disabled = false;
    $('progress').style.width = '0';
    if (version === viewVersion) {
      status(
        `${checkedIds.size} 首已检查 · ${rejected.length} 首待确认${stopCheck ? ' · 已停止' : ''}${refreshIncomplete ? ' · 部分刷新未完成，请重试' : ''}`,
      );
      renderRejected();
    }
  }
}

/* openRejected()：合并服务端虚拟歌单与本次未入选结果，并打开原因列表；不会改动云端歌单。 */
async function openRejected() {
  if (!$('rejectedDialog').open) $('rejectedDialog').showModal();
  try {
    const d = await request('tracks?playlist=local%3Aunauthorized');
    const byId = new Map(rejected.map((t) => [String(t.id), t]));
    for (const t of d.tracks || []) if (!byId.has(String(t.id))) byId.set(String(t.id), t);
    rejected = [...byId.values()];
  } catch {}
  renderRejected();
}
/* renderRejected()：用 textContent 创建歌曲名与原因，避免把平台文本当作 HTML 解析。 */
function renderRejected() {
  const list = $('rejectedList');
  list.replaceChildren();
  const filter = $('rejectedFilter').value || 'all';
  let shown = 0;
  for (const t of rejected) {
    if (filter !== 'all' && accessCategory(t) !== filter) continue;
    shown++;
    const row = document.createElement('div'),
      name = document.createElement('strong'),
      reason = document.createElement('small');
    name.textContent = t.title;
    reason.textContent = `账号权益：${t.entitlementReason || t.reason || '待确认'}；音源：${t.playbackReason || '待确认'}`;
    row.append(name, reason);
    const actions = document.createElement('div');
    actions.className = 'rejected-actions';
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = '尝试播放';
    play.onclick = () => {
      if (busy) return status('请等待检查结束');
      $('rejectedDialog').close();
      playPickedTrack(t, true);
    };
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = '重新获取权限与音源';
    refresh.onclick = () => checkAll([rawTracks.find(raw => raw.id === t.id) || t], viewVersion, true);
    actions.append(play, refresh);
    row.append(actions);
    if (t.diagnostics?.length) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = '查看取链诊断';
      const stages = { device: '设备验证', standard_url: '常规取链', user_verify: '登录验证',
        song_authorization: '单曲授权', authorized_url: '授权取链', recording_metadata: '录音格式核对',
        hash_url: '仅文件标识重试', quality_url: '音质回退', legacy_url: '旧手机接口' };
      const outcomes = { ready: '通过', cached: '已复用', cooldown: '稍后重试', failed: '失败',
        wrong_recording: '返回标识与当前歌曲不一致', complete: '取得完整音源', preview: '返回试听或不完整音源', unusable: '未取得匹配音源',
        verify_duration: '等待实际音频校验' };
      const output = document.createElement('pre');
      const mismatchLabels = { hash: '文件标识未匹配', album: '专辑不一致', recording: '录音版本不一致' };
      output.textContent = t.diagnostics.map((d) => `${stages[d.stage] || '取链'}：${outcomes[d.outcome] || '待确认'}${d.encodingMatched ? '（已确认同一录音的不同格式）' : ''}${Array.isArray(d.mismatch) ? d.mismatch.map(k => mismatchLabels[k]).filter(Boolean).map(v => `（${v}）`).join('') : ''}${d.httpStatus ? `（HTTP ${d.httpStatus}）` : ''}${d.platformCode ? `（平台码 ${d.platformCode}）` : ''}`).join('\n');
      details.append(summary, output);
      row.append(details);
    }
    list.append(row);
  }
  if (!shown) list.textContent = '当前分类没有暂不可播放的歌曲。';
}

/* 【歌单事件】下拉选择、开始/停止权限检查、只重试当前原歌单内未入选的记录。 */
$('playlists').onchange = () => selectPlaylist().catch((e) => status(e.message));
$('check').onclick = () => {
  if (busy) {
    stopCheck = true;
    status('将在当前请求完成后停止');
  } else if (rawTracks.length) {
    checkAll(rawTracks, viewVersion, true);
  }
  else status('先选择一份歌单');
};

$('rejectedFilter').onchange = renderRejected;

let playlistPage = 0;
function openPlaylistBrowser() {
  renderPlaylistBrowser();
  if (!$('playlistBrowser').open) $('playlistBrowser').showModal();
}
function renderPlaylistBrowser() {
  const scroll=$('playlistBrowseList').scrollTop;
  const query = $('playlistFilter').value.trim().toLocaleLowerCase();
  const rows = browsePlaylist.tracks.filter(t => !query || (t.title + ' ' + t.artist).toLocaleLowerCase().includes(query));
  playlistPage = Math.min(playlistPage, Math.max(0, Math.ceil(rows.length / 80) - 1));
  $('playlistBrowseTitle').textContent = '歌单列表' + (browsePlaylist.name ? ' · ' + browsePlaylist.name : '');
  $('playlistBrowseHint').textContent = browsePlaylist.status === 'loading' ? '正在读取歌单…' : browsePlaylist.status === 'error' ? '读取失败，请返回 Setting 重新选择' : `${rows.length} 首`;
  const list = $('playlistBrowseList'); list.replaceChildren();
  for (const track of rows.slice(playlistPage * 80, (playlistPage + 1) * 80)) {
    const button = document.createElement('button'); button.type = 'button';
    const cover = document.createElement('img'); cover.loading = 'lazy'; cover.alt = ''; cover.src = track.cover || FALLBACK;
    const text = document.createElement('span'); text.textContent = [track.title,track.artist].filter(Boolean).join(' · ');
    button.append(cover,text);
    button.className = 'playlist-track-row';
    button.disabled = true;
    list.append(button);
  }
  list.scrollTop=scroll;
  $('playlistPageLabel').textContent = `${rows.length ? playlistPage + 1 : 0} / ${Math.ceil(rows.length / 80)}`;
  $('playlistPageBack').disabled = playlistPage === 0;
  $('playlistPageNext').disabled = (playlistPage + 1) * 80 >= rows.length;
}
$('playlistBrowse').onclick = openPlaylistBrowser;
$('playlistFilter').oninput = () => { $('playlistBrowseList').scrollTop=0;playlistPage = 0; renderPlaylistBrowser(); };
$('playlistPageBack').onclick = () => { $('playlistBrowseList').scrollTop=0;playlistPage--; renderPlaylistBrowser(); };
$('playlistPageNext').onclick = () => { $('playlistBrowseList').scrollTop=0;playlistPage++; renderPlaylistBrowser(); };
