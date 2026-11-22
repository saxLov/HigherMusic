// Concept-client daily benefits are account benefits, not proof of per-song coverage.
export function createConceptBenefits(request, now = Date.now) {
  const sessions = new WeakMap();
  const success = b => Number(b?.status ?? 1) === 1 && Number(b?.error_code ?? b?.errcode ?? 0) === 0;
  return async (session, signal) => {
    if (process.env.platform !== 'lite' || !session.jar?.token || !session.jar?.userid) return;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()));
    const identity = session.jar.userid + ':' + session.jar.token;
    let entry = sessions.get(session);
    if (entry?.identity === identity && entry.day === day && now() < entry.until) return entry.pending;
    entry = { identity, day, until: now() + 60000 };
    sessions.set(session, entry);
    entry.pending = (async () => {
      const union = await request(session, 'youth_union_vip', {}, { signal });
      signal?.throwIfAborted();
      if (!success(union)) return;
      const vip = union.data ?? union;
      const active = Number(vip.is_vip ?? vip.vip_type) > 0 || (Array.isArray(vip.busi_vip) && vip.busi_vip.some(x => Number(x?.is_vip ?? x?.vip_type) > 0));
      if (!active) {
        const claim = await request(session, 'youth_day_vip', { receive_day: day }, { signal });
        signal?.throwIfAborted();
        if (!success(claim)) return;
        const upgrade = await request(session, 'youth_day_vip_upgrade', {}, { signal });
        signal?.throwIfAborted();
        if (!success(upgrade)) return;
      }
      entry.until = Infinity;
    })().catch(() => { signal?.throwIfAborted(); });
    return entry.pending;
  };
}
