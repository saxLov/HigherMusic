import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createLoginStore } from '../electron/login-store.mjs';
import { createMusicServer } from '../server.mjs';
const secret='fixture-private-token';
const key=randomBytes(32);
const crypto={isAsyncEncryptionAvailable:async()=>true,
  encryptStringAsync:async text=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([c.update(text,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);},
  decryptStringAsync:async bytes=>{const c=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(12,28));return {result:Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString('utf8')};},
};
async function harness(t,store,detail=async()=>({data:{userid:'7',nickname:'Listener'}})){
  const server=createMusicServer({loginStore:store,request:async(_,name)=>{
    if(name==='user_detail')return detail();
    return {data:{login_qr_key:{key:'fixture'},login_qr_create:{base64:'data:image/png;base64,AA=='},login_qr_check:{status:4,token:secret,userid:'7',nickname:'Listener'}}[name]};
  }});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  let cookie='';return async(route,method='GET')=>{
    const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/'+route,{method,headers:{Cookie:cookie}});
    cookie ||= r.headers.get('set-cookie')?.split(';')[0]??'';
    const data=await r.json();assert.ok(!JSON.stringify(data).includes(secret));return {status:r.status,...data};
  };
}
test('扫码后选择免扫码：加密落盘、下一次验证账号恢复、退出清除',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'higher-login-')),store=createLoginStore(dir,crypto,'lite');
  const a=await harness(t,store);await a('session');await a('login','POST');
  assert.equal((await a('login/status?remember=1')).remember,true);
  const file=await readFile(path.join(dir,'login-lite.json'),'utf8');assert.ok(!file.includes(secret));
  const b=await harness(t,createLoginStore(dir,crypto,'lite'));
  assert.equal((await b('session')).user.name,'Listener');
  assert.equal((await b('session')).remember,true);
  await b('logout','POST');assert.deepEqual(await readdir(dir),[]);
  const c=await harness(t,store);assert.equal((await c('session')).user,null);
});
test('未勾选只保存本次会话；已登录后可开启并关闭免扫码',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'higher-login-')),store=createLoginStore(dir,crypto,'standard');
  const send=await harness(t,store);await send('session');await send('login','POST');await send('login/status');
  assert.equal(await store.load(),null);
  await send('remember?enabled=1','POST');assert.ok(await store.load());
  await send('remember?enabled=0','POST');assert.equal(await store.load(),null);
  assert.equal((await send('session')).user.name,'Listener');
});
test('失效账号不恢复；网络失败保留加密资料等待重试',async t=>{
  for(const transient of [false,true]){
    const dir=await mkdtemp(path.join(os.tmpdir(),'higher-login-')),store=createLoginStore(dir,crypto,'lite');
    await store.save({jar:{token:secret,userid:'7'}});
    const send=await harness(t,store,async()=>{if(transient)throw Error('network');return {data:{userid:'other'}}});
    const state=await send('session');assert.equal(state.user,null);assert.ok(state.loginNotice);
    assert.equal(!!await store.load(),transient);
  }
});
test('恢复中的退出不能重新写回账号；模式隔离与不可用加密均不降级明文',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'higher-login-')),store=createLoginStore(dir,crypto,'lite');
  await store.save({jar:{token:secret,userid:'7'}});
  assert.equal(await createLoginStore(dir,crypto,'standard').load(),null);
  const entered=Promise.withResolvers(),finish=Promise.withResolvers();
  const send=await harness(t,store,async()=>{entered.resolve();await finish.promise;return {data:{userid:'7'}}});
  await send('providers');
  const pending=send('session');await entered.promise;
  await send('logout','POST');finish.resolve();
  assert.equal((await pending).user,null);assert.equal(await store.load(),null);
  const unavailable=createLoginStore(dir,{...crypto,isAsyncEncryptionAvailable:async()=>false},'lite');
  await assert.rejects(unavailable.save({jar:{token:secret,userid:'7'}}));assert.deepEqual(await readdir(dir),[]);
});
