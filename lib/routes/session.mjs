import { randomBytes } from 'node:crypto';
import { ready } from '../provider.mjs';

export function createSessionRoutes({ json, call, sessions, loginStore }) {
  async function restore(s, sid) {
    if (!loginStore || s.user || s.restoreChecked) return;
    if (s.restoring) return s.restoring;
    const revision = s.authRevision ?? 0;
    const active = () => sessions.get(sid) === s && (s.authRevision ?? 0) === revision;
    s.restoring = (async () => {
      try {
        const saved = await loginStore.load();
        if (!active() || !saved) return;
        const candidate = { jar: { ...saved.jar } };
        const body = await call(candidate, 'user_detail', {});
        if (!active()) return;
        const d = body.data?.user_info ?? body.data?.userinfo ?? body.data?.profile ?? body.data;
        const uid = d?.userid ?? d?.user_id ?? d?.id;
        if (!uid || String(uid) !== String(saved.jar.userid)) {
          await loginStore.clear(); s.loginNotice = '保存的登录已失效，请重新扫码'; return;
        }
        s.jar = candidate.jar;
        s.user = { name: d.nickname || d.username || saved.user?.name || '酷狗用户' };
        s.rememberLogin = true;
      } catch { if (active()) s.loginNotice = '暂时无法验证保存的登录，可重新扫码'; }
      finally { s.restoreChecked = true; }
    })();
    return s.restoring;
  }
  return {
    "GET /api/session": async ({ res, s, sid }) => {
      await restore(s, sid);
      return json(res, 200, { ready: ready(), user: sessions.get(sid) === s ? s.user ?? null : null,
        remember: !!s.rememberLogin, rememberAvailable: !!loginStore, loginNotice: s.loginNotice });
    },
    "POST /api/remember": async ({ res, s, u }) => {
      const enabled = u.searchParams.get('enabled') === '1';
      if (!loginStore) return json(res, 400, { error: '免扫码登录仅在桌面版可用' });
      if (enabled) await loginStore.save({ jar: { ...s.jar }, user: s.user });
      else await loginStore.clear();
      s.rememberLogin = enabled;
      return json(res, 200, { remember: enabled });
    },
    "POST /api/logout": async ({ res, s, sid }) => {
      s.authRevision = (s.authRevision ?? 0) + 1;
      await loginStore?.clear();
      s.playRequest?.abort(); s.cancelPreparation?.(); s.rightsWarmControl?.abort();
      sessions.delete(sid);
      res.setHeader(
        'Set-Cookie',
        'music_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      );
      return json(res, 200, { ok: true });
    },
    "POST /api/login": async ({ res, s, u }) => {
      if (s.user) throw new Error('请先退出当前账号。');
      if (s.lastQR && Date.now() - s.lastQR < 5000)
        throw new Error('请稍候再刷新二维码。');
      s.authRevision = (s.authRevision ?? 0) + 1;
      s.restoreChecked = true;
      s.rememberLogin = !!loginStore && u.searchParams.get('remember') === '1';
      await loginStore?.clear();
      delete s.loginNotice;
      s.lastQR = Date.now();
      const b = await call(s, 'login_qr_key');
      s.qr = b.data?.qrcode ?? b.data?.key;
      if (!s.qr) throw new Error('二维码接口格式尚未适配。');
      const qr = await call(s, 'login_qr_create', { key: s.qr, qrimg: true });
      s.qrTime = Date.now();
      return json(res, 200, { image: qr.data?.base64 });
    },
    "GET /api/login/status": async ({ res, s, sid, u }) => {
      if (!s.qr || Date.now() - s.qrTime > 180000) return json(res, 200, { status: 0 });
      if (s.lastPoll && Date.now() - s.lastPoll < 2000)
        return json(res, 200, { status: 1 });
      s.lastPoll = Date.now();
      if (u.searchParams.has('remember')) s.rememberLogin = !!loginStore && u.searchParams.get('remember') === '1';
      const authRevision = s.authRevision;
      const b = await call(s, 'login_qr_check', { key: s.qr });
      if (sessions.get(sid) !== s || s.authRevision !== authRevision) return json(res, 401, { error: '登录已取消' });
      const d = b.data;
      if (d?.status === 4 || d?.status === '4') {
        if (!d.token || !d.userid) throw new Error('登录凭证不完整，请重新扫码。');
        s.jar.token = d.token;
        s.jar.userid = d.userid;
        s.user = { name: d.nickname || d.username || '酷狗用户' };
        s.qr = null;
        if (s.rememberLogin) try { await loginStore.save({ jar: { ...s.jar }, user: s.user }); }
        catch { s.rememberLogin = false; s.loginNotice = '登录成功，但无法加密保存，下次需要扫码'; }
      }
      return json(res, 200, { status: Number(d?.status), user: s.user ?? null, remember: !!s.rememberLogin, loginNotice: s.loginNotice });
    },
  };
}

export const sessionExpiry = 4 * 60 * 60 * 1000;

export function openSession(req, res, sessions) {
  let sid = req.headers.cookie?.match(
    /(?:^|;\s*)music_session=([a-f0-9]{48})(?:;|$)/,
  )?.[1];
  let s = sessions.get(sid);
  if (!s || Date.now() - s.touched > sessionExpiry) {
    if (sid) { s?.playRequest?.abort(); s?.cancelPreparation?.(); s?.rightsWarmControl?.abort(); sessions.delete(sid); }
    sid = randomBytes(24).toString('hex');
    s = { jar: {}, touched: Date.now(), tracks: new Map(), playlists: new Map() };
    sessions.set(sid, s);
    res.setHeader(
      'Set-Cookie',
      `music_session=${sid}; HttpOnly; SameSite=Strict; Path=/${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`,
    );
  }
  s.touched = Date.now();
  return { sid, s };
}
