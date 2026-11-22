let networkSearchVersion = 0;

function search() {
  if (busy) return status('请等待权限检查完成，或先停止检查');
  if (flashing || sliding || $('searchDialog').open) return;
  if (!$('scan').hidden) return login();
  $('searchDialog').showModal();
  $('searchInput').value = '';
  resetSearchResults();
  $('searchInput').focus();
}

function resetSearchResults() {
  networkSearchVersion++;
  searchMatches = [];
  $('searchResults').replaceChildren();
  $('searchHint').textContent = '输入歌名或歌手 / Esc 关闭';
  $('searchSubmit').textContent = '搜索';
}

function renderSearchResults() {
  const query = $('searchInput').value.trim().toLocaleLowerCase();
  const results = $('searchResults');
  results.replaceChildren();
  const matches = songs.map((song, at) => ({ song, at })).filter(({ song }) =>
    query && `${song.title} ${song.artist}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.song.title.toLocaleLowerCase() === query) - Number(a.song.title.toLocaleLowerCase() === query));
  searchMatches = matches;
  for (const { song, at } of matches.slice(0, 60)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${song.title} · ${song.artist} · ${at + 1}/${songs.length}`;
    button.onclick = async () => { await $('searchDialog').close(); searchJumpTo(at).catch((e) => status(e.message)); };
    results.append(button);
  }
  $('searchHint').textContent = query ? (matches.length ? `${matches.length} 个结果${matches.length > 60 ? '，显示前 60 项' : ''}` : '当前歌单没有匹配的歌曲') : '输入歌名或歌手 / Esc 关闭';
}

function bindSearch() {
  $('searchInput').oninput = () => {
    resetSearchResults();
    renderSearchResults();
  };
  $('searchDialog').addEventListener('close', () => { networkSearchVersion++; });
  $('searchForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!searchMatches.length) renderSearchResults();
    if (searchMatches.length) {
      const at = searchMatches[0].at;
      await $('searchDialog').close();
      searchJumpTo(at).catch((error) => status(error.message));
    }
  };
  $('searchDialog').addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const buttons = [...$('searchResults').querySelectorAll('button')];
    if (!buttons.length) return;
    e.preventDefault();
    const current = buttons.indexOf(document.activeElement);
    const at = e.key === 'ArrowDown' ? (current + 1) % buttons.length : (current <= 0 ? buttons.length - 1 : current - 1);
    buttons[at].focus();
  });
}

let searchMatches = [];
async function playPickedTrack(track, fresh = false) {
  if (flashing || sliding) return status('请等待切歌动画结束');
  let target = songs.findIndex(song => song.id === track.id);
  if (target < 0) return;
  if (fresh) songs[target].audio = '';
  rejected = rejected.filter(item => item.id !== track.id);
  renderRejected();
  return searchJumpTo(target);
}
