import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreview } from '../scripts/preview.mjs';

test('账号歌单登录、取曲和播放仍可用，独立搜索和本地编辑入口关闭', async () => {
  const { server } = createPreview();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const initial = await fetch(base + '/api/session');
    const cookie = initial.headers.get('set-cookie').split(';')[0];
    const send = async (route, method='GET') => {
      const response = await fetch(base+'/api/'+route,{method,headers:{Cookie:cookie}});
      return {status:response.status, data:await response.json()};
    };
    await send('login','POST');await send('login/status');
    const lists = (await send('playlists')).data.playlists;
    assert.ok(lists.length);
    assert.ok(lists.every(p=>!p.local&&!p.editable&&!p.id.startsWith('local:')));
    const tracks=(await send('tracks?playlist='+lists[0].id)).data.tracks;
    assert.ok(tracks.length);
    assert.equal((await send('play?track='+encodeURIComponent(tracks[0].id),'POST')).status,200);
    for (const [route,method] of [['search?q=test','GET'],['local-playlists','POST'],['local-files','GET'],['cache','GET'],['remember','POST']])
      assert.equal((await send(route,method)).status,404,route);
    assert.equal((await send('tracks?playlist=local:unauthorized')).status,404);
    await send('logout','POST');
    assert.equal((await send('session')).data.user,null);
  } finally {await new Promise(r=>server.close(r));await server.cleanup?.();}
});
