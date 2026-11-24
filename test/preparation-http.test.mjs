import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreview } from '../scripts/preview.mjs';
import { createLocalLibrary } from '../lib/local-library.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('persistent snapshots survive restart, isolate accounts and exclude credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(),'higher-snapshot-'));
  let db = createLocalLibrary(directory);
  const s = {jar:{userid:1}};
  try {
    db.saveSnapshot(s,'playlists','',[{id:'1',name:'Songs',listid:1,token:'secret-token'}]);
    db.saveSnapshot(s,'tracks','1',[{id:'a',title:'A',url:'secret-url',audio:'secret-audio'}]);
    db.close(); db = createLocalLibrary(directory);
    assert.equal(db.snapshot(s,'playlists').data[0].name,'Songs');
    assert.equal(db.snapshot(s,'tracks','1').data[0].url,undefined);
    assert.equal(db.snapshot({jar:{userid:2}},'tracks','1'),undefined);
    db.close(); assert.doesNotMatch(await readFile(path.join(directory,'library.sqlite3'),'utf8'),/secret-/);
  } finally {db.close();await rm(directory,{recursive:true,force:true});}
});

test('HTTP prepared selections reuse URLs but mint distinct tickets and create history only after started', async () => {
  const {server,calls}=createPreview();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  let cookie='';
  const send=async(route,method='GET',body)=>{
    const response=await fetch(base+'/api/'+route,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    cookie ||= response.headers.get('set-cookie')?.split(';')[0];
    const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
  };
  try {
    await send('login','POST');await send('login/status');await send('playlists');
    const tracks=(await send('tracks?playlist=1')).tracks;
    const remote=calls.length;
    assert.equal((await send('playlists')).snapshot,true);
    assert.equal((await send('tracks?playlist=1')).snapshot,true);
    assert.equal(calls.length,remote);
    const prepared=await send('prepare','POST',{tracks:[tracks[0].id],epoch:1});
    assert.equal(prepared.items.length,1);
    assert.deepEqual((await send('local-history')).items,[]);
    const a=await send('play?track='+encodeURIComponent(tracks[0].id),'POST');
    const b=await send('play?track='+encodeURIComponent(tracks[0].id),'POST');
    assert.equal(a.selectionHit,true);assert.equal(b.selectionHit,true);
    assert.notEqual(a.url,b.url);assert.notEqual(a.playbackToken,b.playbackToken);
    assert.equal((await send('local-history')).items.length,0);
    await send('play-started','POST',{songId:tracks[0].id,playbackToken:b.playbackToken});
    assert.equal((await send('local-history')).items.length,1);
    assert.equal((await send('prepare','POST',{tracks:[],epoch:0})).stale,true);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
