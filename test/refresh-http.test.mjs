import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMusicServer} from '../server.mjs';
import {createAccessChecker} from '../lib/access.mjs';
import {createLocalLibrary} from '../lib/local-library.mjs';
import {refreshSources} from '../lib/source-refresh.mjs';
import {recordingKey} from '../lib/audio-cache.mjs';

async function harness(t, options={}) {
  let bought=false, reads=0;
  const track={id:'a',hash:'abc',albumId:5,albumAudioId:123,title:'Purchased sample',artist:'Artist',duration:180};
  const full={hash:'abc',album_id:5,album_audio_id:123,url:'https://audio.example/full',timeLength:180};
  const request=async(s,name)=>{
    if(name==='user_purchased_songs'){reads++;return {data:bought?[{album_audio_id:123}]:[]};}
    if(name==='user_purchased_albums') return {data:[]};
    if(name==='user_vip_detail') return {data:{is_vip:0}};
    if(name==='privilege_lite') return {data:[]};
    if(name==='register_dev')return {data:{dfid:'fixture-device'}};
    if(name==='song_url')return options.songUrl ? options.songUrl(full) : bought ? full : {}; 
    if(name==='login_qr_key')return {data:{key:'test'}};
    if(name==='login_qr_create')return {data:{}};
    if(name==='login_qr_check')return {data:{status:4,userid:'test',token:'fixture',nickname:'Test'}};
    if(name==='user_playlist')return {data:{list:[{listid:1,name:'Test',count:1}],total:1}};
    if(name==='playlist_track_all_new')return {data:{list:[track],total:1}};
    throw new Error('Unexpected fixture request: '+name);
  };
  const check=createAccessChecker(request), library=createLocalLibrary();
  const server=createMusicServer({request,localLibrary:library,inspectAccess:check,
    adapters:async name=> name==='access'?{checkAccess:check}:{normalizeTrack:x=>x},
    sources:{fallback:async()=>({state:'allowed',playbackState:'allowed',url:'https://m10.music.126.net/test',expectedDuration:180,playbackSource:{provider:'netease',name:'网易云',fallback:true}})},
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));library.close();});
  const base='http://127.0.0.1:'+server.address().port;let cookie='';
  const send=async(route,method='GET')=>{
    const response=await fetch(base+'/api/'+route,{method,headers:{Cookie:cookie}});
    cookie ||= response.headers.get('set-cookie')?.split(';')[0];
    return {status:response.status,body:await response.json()};
  };
  await send('login','POST');await send('login/status');await send('playlists');
  const id=(await send('tracks?playlist=1')).body.tracks[0].id;
  return {send,id,buy:()=>bought=true,reads:()=>reads,library};
}

test('购买后主动刷新清除网易云选源缓存，后续点播重新采用酷狗',async t=>{
  const h=await harness(t);const play=()=>h.send('play?track='+h.id,'POST');
  assert.equal((await play()).body.playbackSource.provider,'netease');
  assert.equal((await play()).body.selectionHit,true);
  h.buy();const fresh=await h.send('inspect?track='+h.id+'&fresh=1&accountFresh=1','POST');
  assert.equal(fresh.status,200);assert.equal(fresh.body.entitlement,'purchased');
  const current=await play();assert.equal(current.body.playbackSource.provider,'kugou');
  assert.notEqual(current.body.selectionHit,true);assert.equal(h.reads(),2);
});

test('刷新前迟到的取链不能覆盖新购买状态或签发旧备用票据',async t=>{
  let release,announce,once=true;
  const entered=new Promise(r=>announce=r);
  const h=await harness(t,{songUrl:async full=>{
    if(once){once=false;announce();await new Promise(r=>release=r);}return full;
  }});
  const old=h.send('play?track='+h.id,'POST');await entered;h.buy();
  const fresh=await h.send('inspect?track='+h.id+'&fresh=1&accountFresh=1','POST');
  assert.equal(fresh.body.entitlement,'purchased');release();
  const stale=await old;assert.notEqual(stale.status,200);assert.equal(stale.body.url,undefined);
  const latest=await h.send('play?track='+h.id,'POST');
  assert.equal(latest.body.playbackSource.provider,'kugou');
  assert.equal(h.library.cached({jar:{userid:'test'}},h.id).entitlement,'purchased');
});

test('刷新期间发起播放等待新权益，不使用旧缓存结果',async t=>{
  let release,announce,block=false;
  const entered=new Promise(r=>announce=r);
  const h=await harness(t,{songUrl:async full=>{if(block){block=false;announce();await new Promise(r=>release=r);}return full;}});
  await h.send('play?track='+h.id,'POST');h.buy();block=true;
  const refresh=h.send('inspect?track='+h.id+'&fresh=1&accountFresh=1','POST');await entered;
  let settled=false;const play=h.send('play?track='+h.id,'POST').then(v=>{settled=true;return v;});
  await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);
  release();assert.equal((await refresh).status,200);
  assert.equal((await play).body.playbackSource.provider,'kugou');
});

test('刷新撤销旧缓存授权与反馈凭据，保留磁盘媒体和已购事实',()=>{
  const track={id:'a'}, key=recordingKey(track);
  const s={cacheGrants:new Map([[key,{key:'file'}]]),playbackSources:new Map([['a',{}]]),accountRights:{songs:[{album_audio_id:123}]}};
  refreshSources(s,track,false,{reject:()=>assert.fail('must not delete media')});
  assert.equal(s.cacheGrants.size,0);assert.equal(s.playbackSources.size,0);
  assert.equal(s.accountRights.songs.length,1);
});
