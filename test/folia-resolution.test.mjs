import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKugouPlaybackResolver } from '../lib/kugou-playback.mjs';
import { createConceptBenefits } from '../lib/kugou-benefits.mjs';
import { legacyPlayInfo } from '../lib/kugou-legacy.mjs';
const track={hash:'abc',albumId:5,albumAudioId:123};
const full={hash:'abc',url:'https://audio.example/full',timeLength:180};
test('仅hash重试成功时不降音质或调用旧接口；返回其他录音仍拒绝',async()=>{
  for(const wrong of [false,true]){
    const calls=[];
    const resolve=createKugouPlaybackResolver(async(_,name,p)=>{
      calls.push({name,p});
      return name==='song_url'&&!p.album_id ? {...full,...(wrong?{album_audio_id:999}:{})} : {};
    });
    const r=await resolve({},track,{duration:180});
    assert.equal(r.state,wrong?'unknown':'allowed');
    assert.equal(calls[1].p.album_audio_id,'');
    assert.equal(calls.some(c=>c.name==='legacy_play_info'),wrong);
  }
});
test('音质逐级回退且每级先带信息后只传hash，全部失败后只读一次旧接口',async()=>{
  const calls=[];
  const r=await createKugouPlaybackResolver(async(_,name,p)=>{
    calls.push([name,p.quality,p.album_id]);return name==='legacy_play_info'?full:{};
  })({},track,{duration:180,quality:'flac'});
  assert.equal(r.state,'allowed');
  assert.deepEqual(calls.slice(0,-1),['flac','320','128'].flatMap(q=>[['song_url',q,5],['song_url',q,'']]));
  assert.equal(calls.at(-1)[0],'legacy_play_info');
});
test('现代接口超时仍试旧接口；拒绝或限流不继续；取消请求不再取链',async()=>{
  for(const status of [408,403,429]){
    const calls=[];
    const r=await createKugouPlaybackResolver(async(_,name)=>{
      calls.push(name);if(name==='song_url')throw Object.assign(Error('test'),{httpStatus:status});return full;
    })({},track,{duration:180,fastFallback:true});
    assert.equal(r.state,status===408?'allowed':'unknown');
    assert.equal(calls.includes('legacy_play_info'),status===408);
  }
  const control=new AbortController();control.abort();
  await assert.rejects(createKugouPlaybackResolver(()=>{throw Error('must not call')})({},track,{signal:control.signal}),{name:'AbortError'});
});
test('旧接口固定目的地、不转发账号cookie、规范备用地址，失败与试听不通过',async()=>{
  const body=await legacyPlayInfo('abc',{},async(url,options)=>{
    assert.equal(url.hostname,'m.kugou.com');assert.equal(url.searchParams.get('hash'),'abc');
    assert.equal(options.credentials,'omit');assert.equal(options.headers.Cookie,undefined);
    return Response.json({...full,backup_url:['https://audio.example/backup']});
  });
  assert.deepEqual(body.backupUrl,['https://audio.example/backup']);
  await assert.rejects(legacyPlayInfo('abc',{},async()=>Response.json({status:0,url:full.url})));
  const r=await createKugouPlaybackResolver(async(_,name)=>name==='legacy_play_info'?{...full,timeLength:30}:{} )({},track,{duration:180});
  assert.equal(r.state,'blocked');
});
test('概念版赠送权益合并并发、同日复用、跨日重查，领取失败不妨碍后续播放',async()=>{
  const previous=process.env.platform;process.env.platform='lite';
  try{
    let now=Date.UTC(2026,10,13),names=[];
    const benefits=createConceptBenefits(async(_,name,p)=>{names.push(name);if(name==='youth_day_vip')assert.equal(p.receive_day,'2026-11-13');return {status:1,data:{is_vip:0}}},()=>now);
    const s={jar:{userid:'fixture',token:'fixture'}};
    await Promise.all([benefits(s),benefits(s)]);await benefits(s);
    assert.deepEqual(names,['youth_union_vip','youth_day_vip','youth_day_vip_upgrade']);
    process.env.platform='';await benefits({jar:s.jar});assert.equal(names.length,3);
    process.env.platform='lite';now+=86400000;
    // Failure is contained, and does not assert membership or song entitlement.
    await createConceptBenefits(async()=>{throw Error('unavailable')})(s);
    await benefits(s);assert.ok(names.length>3);
  }finally{if(previous===undefined)delete process.env.platform;else process.env.platform=previous;}
});
