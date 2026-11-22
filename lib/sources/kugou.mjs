import { listFrom, normalizeTrack } from '../provider.mjs';

const text = (value) => String(value ?? '').replace(/<\/?em>/gi, '').trim().slice(0, 300);

export function createKugouSearch(call, authorize) {
  return {
    id: 'kugou',
    name: '酷狗',
    ...(authorize ? { authorize } : {}),
    async search(session, keywords) {
      if (!session.jar.dfid) {
        const registered = await call(session, 'register_dev');
        const dfid = registered?.data?.dfid;
        if (typeof dfid !== 'string' || !dfid) throw new Error('酷狗设备验证失败');
        session.jar.dfid = dfid;
      }
      const body = await call(session, 'search', { keywords, type: 'song', page: 1, pagesize: 20 });
      return listFrom(body).slice(0, 20).map((row) => {
        const track = normalizeTrack({
          hash: row.FileHash ?? row.Hash ?? row.hash,
          album_id: row.AlbumID ?? row.album_id,
          album_audio_id: row.MixSongID ?? row.album_audio_id,
          audio_id: row.Audioid ?? row.audio_id,
          name: text(row.SongName ?? row.songname ?? row.FileName ?? row.filename),
          author_name: text(row.SingerName ?? row.singername),
          duration: row.Duration ?? row.duration,
          cover: row.Image ?? row.AlbumPic ?? row.cover,
        });
        return { ...track, provider: 'kugou', album: text(row.AlbumName ?? row.album_name),
          id: 'search:kugou:' + track.id + ':' + String(track.hash ?? '').toLowerCase() };
      }).filter((track) => /^[a-f0-9]{32}$/i.test(track.hash ?? '') && track.title);
    },
  };
}

