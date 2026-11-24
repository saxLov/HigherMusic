/* 登录、二维码轮询和退出。 */
/* closeLogin()：关闭扫码框、停止轮询，并递增 loginVersion，让旧二维码请求失效。 */
function closeLogin() {
  loginVersion++;
  clearTimeout(pollTimer);
  $('loginDialog').close();
}
/* login()：请求二维码，每 3 秒轮询状态。0 表示过期，2 等待手机确认，4 登录成功。
 * 所有回调检查 loginVersion，关窗或刷新二维码后旧轮询不能再次更新界面。 */
async function login() {
  const version = ++loginVersion;
  clearTimeout(pollTimer);
  if (!$('loginDialog').open) $('loginDialog').showModal();
  $('qr').hidden = true;
  $('qrStatus').textContent = '正在获取二维码…';
  $('refreshQR').disabled = true;
  try {
    const d = await request('login', 'POST');
    if (version !== loginVersion) return;
    if (typeof d.image !== 'string' || !d.image.startsWith('data:image/'))
      throw Error('二维码数据无效');
    $('qr').src = d.image;
    $('qr').hidden = false;
    $('qrStatus').textContent = '请使用手机酷狗扫码确认';
    const poll = async () => {
      if (version !== loginVersion) return;
      try {
        const state = await request('login/status');
        if (version !== loginVersion) return;
        if (state.status === 4) {
          closeLogin();
          setAccount(state.user, state);
          await loadPlaylists();
          return;
        }
        if (state.status === 0) {
          $('qrStatus').textContent = '二维码已过期，请刷新';
          return;
        }
        $('qrStatus').textContent =
          state.status === 2 ? '请在手机上确认登录' : '等待扫码…';
        pollTimer = setTimeout(poll, 3000);
      } catch (e) {
        if (version === loginVersion) $('qrStatus').textContent = e.message;
      }
    };
    pollTimer = setTimeout(poll, 3000);
  } catch (e) {
    if (version === loginVersion) $('qrStatus').textContent = e.message;
  } finally {
    if (version === loginVersion) $('refreshQR').disabled = false;
  }
}
/* setAccount()：只更新扫码/退出按钮的可见性；真实登录状态仍由后端会话决定。 */
function setAccount(user, info = {}) {
  window.higherAccount = { user, ...info };
  document.dispatchEvent(new CustomEvent('higher:account', { detail: window.higherAccount }));
  listening.cancelPending();
  $('scan').hidden = !!user;
  $('logout').hidden = !user;
  $('emptyScan').hidden = !!user;
  if (user) {
    const version = loginVersion;
    void request('rights-warm', 'POST', () => version === loginVersion && $('scan').hidden).catch(() => {});
  }
}
/* 【登录事件】扫码、空态连接和刷新二维码共用 login；所有带 data-close 的按钮按目标关闭对应弹窗。 */
$('scan').onclick = $('emptyScan').onclick = $('refreshQR').onclick = login;
$('playbackDiagnostics').onclick = () => $('playbackDiagnosticsDialog').showModal();
for (const button of document.querySelectorAll('[data-close]'))
  button.onclick = () =>
    button.dataset.close === 'loginDialog'
      ? closeLogin()
      : $(button.dataset.close).close();
$('loginDialog').addEventListener('cancel', closeLogin);
/* 【退出事件】先使旧请求失效并停播，再让后端销毁会话；成功后清空本页歌曲、歌单和账号按钮。 */
$('logout').onclick = async () => {
  listening.cancelPending();
  stopCheck = true;
  viewVersion++;
  stopAudio();
  closeLogin();
  try {
    await request('logout', 'POST');
    songs = [];
    rawTracks = [];
    activePlaylistId = ''; browsePlaylist = {id:'',name:'',tracks:[],selected:'',status:'empty',version:browsePlaylist.version+1};updateGalleryEntry();
    rejected = [];
    playlistRows = [];
    renderPlaylists();
    renderGallery();
    setAccount(null);
    $('playbackDiagnostics').hidden = true;
    $('playbackDiagnosticsText').textContent = '';
    status('已退出');
  } catch (e) {
    status(e.message);
  }
};
