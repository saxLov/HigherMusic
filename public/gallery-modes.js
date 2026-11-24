/* 三种画廊共享播放会话。书脊浏览位置、预览歌曲与播放索引独立。 */
(() => {
 const key='higherweb.gallery.mode.v1';
 let mode='vertical';try{const saved=HigherSettings.getItem(key);if(['vertical','spine','wall'].includes(saved))mode=saved;}catch{}
 let picked='',revision='',busy=false,epoch=0;
 const host=document.createElement('section');host.id='spineGallery';host.hidden=true;
 const rack=document.createElement('div');rack.className='spine-rack';rack.setAttribute('aria-label','拖动浏览歌曲，点击抽出预览');
 const detail=document.createElement('section');detail.className='spine-detail';detail.hidden=true;
 const title=document.createElement('h2'),artist=document.createElement('p'),meta=document.createElement('small'),play=document.createElement('button'),put=document.createElement('button');
 play.textContent='播放这首';put.textContent='放回';const actions=document.createElement('div');actions.append(play,put);detail.append(title,artist,meta,actions);host.append(rack,detail);$('stage').append(host);
 const label=document.createElement('label');label.textContent='画廊样式';label.htmlFor='galleryModeSelect';const select=document.createElement('select');select.id='galleryModeSelect';
 for(const [value,text] of [['vertical','竖直'],['wall','展墙'],['spine','书脊']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}
 $('settingsAtmosphere').append(label,select);select.value=mode;
 const slots=Array.from({length:18},()=>{
  const book=document.createElement('button');
  book.className='spine-book';
  const plane=document.createElement('div'),surface=document.createElement('div'),img=document.createElement('img'),name=document.createElement('span');
  plane.className='spine-plane';surface.className='spine-surface';img.alt='';img.draggable=false;surface.append(img);plane.append(surface,name);book.append(plane);rack.append(book);
  book.onclick=event=>{if(event.detail===0&&!busy)preview(book.dataset.trackId)};
  return book;
 });
 let pointerX=0,pointerY=0,keyTime=-Infinity,keyDirection=0,hoverId='';
 let edgePixels=0,reverseGuard=null,wrapping=false,pageAnimations=[];
 const buffer=()=>Math.max(65,rackWidth*.16);
 let position=0,goal=0,frame=0,dragFrame=0,warmKey='',rackWidth=0;
 const radius=()=>mode==='wall'?2:4;
 const stride=()=>rackWidth*(mode==='wall'?.20:.105);
 const clamp=value=>Math.max(0,Math.min(songs.length-1,value));
 function stop(){
  cancelAnimationFrame(frame);
  cancelAnimationFrame(dragFrame);
  frame=dragFrame=0;
  pageAnimations.forEach(animation=>animation.cancel());pageAnimations=[];
  rack.classList.remove('moving');
 }
 const active=()=>mode!=='vertical'&&songs.length&&!document.body.classList.contains('immersive');
 function clear(){stop();wrapping=false;seam.hidden=true;edgePixels=0;reverseGuard=null;hoverId='';start=null;dragged=false;wheelTime=-Infinity;wheelDistance=0;pointerX=pointerY=0;epoch++;busy=false;picked='';host.classList.remove('spine-closing');document.querySelectorAll('.spine-flight').forEach(e=>e.remove());}
 function refresh(){
  const next=JSON.stringify([viewVersion,activePlaylistId,songs.map(s=>s.id)]);
  if(next!==revision){clear();revision=next;goal=position=clamp(index);}
  document.body.classList.toggle('gallery-spine',!!active());document.body.classList.toggle('gallery-wall',mode==='wall'&&songs.length>0&&!document.body.classList.contains('immersive'));
  host.hidden=!active();if(!active())return;
  rackWidth=rack.clientWidth;
  $('galleryPrevious').textContent=mode==='vertical'?'↑':'←';
  $('galleryNext').textContent=mode==='vertical'?'↓':'→';
  if(mode!=='vertical'){
   for(const [id,text] of [['galleryPrevious','浏览上一首'],['galleryNext','浏览下一首']]){
    $(id).disabled=songs.length<2;$(id).title=text;$(id).setAttribute('aria-label',text);
   }
  }
  warmKey='';
  prepareSeam();
  draw();
 }
 const seam=document.createElement('div');seam.className='gallery-seam';rack.append(seam);
 const leaves=Array.from({length:18},()=>{
  const leaf=document.createElement('div');leaf.className='spine-book transition-page';
  const plane=document.createElement('div'),surface=document.createElement('div'),img=document.createElement('img'),name=document.createElement('span');
  plane.className='spine-plane';surface.className='spine-surface';surface.append(img);plane.append(surface,name);leaf.append(plane);seam.append(leaf);return leaf;
 });
 function bindCover(card, track){
  const song=songs[track];
  if(!song)return;
  const caption=song.title;
  card.dataset.trackId=song.id;
  paintCover(card.querySelector('img'),song.cover);
  const name=card.querySelector('span');
  if(name.textContent!==caption)name.textContent=caption;
 }
 function prepareSeam(){
  leaves.forEach((leaf,i)=>{
   const count=radius()*2+1,k=i%count,center=i<count?songs.length-1:0,track=center+k-radius();
   leaf.hidden=i>=count*2||track<0||track>=songs.length;
   if(!leaf.hidden)bindCover(leaf,track);
  });
 }
 function wrap(direction){
  if(wrapping||songs.length<2)return;
  stop();wrapping=true;hoverId='';picked='';edgePixels=0;detail.hidden=true;
  slots.forEach(book=>book.hidden=true);seam.hidden=false;
  const count=radius()*2+1,from=direction>0?songs.length-1:0,to=direction>0?0:songs.length-1;
  leaves.forEach((leaf,i)=>{
   const center=i<count?from:to,track=center+i%count-radius();
   leaf.hidden=i>=count*2||track<0||track>=songs.length;
   if(!leaf.hidden)bindCover(leaf,track);
  });
  const began=performance.now(),unit=rackWidth/1024;
  const limit=v=>Math.max(0,Math.min(1,v)),ease=v=>v*v*(3-2*v);
  function tick(now){
   const t=reducedMotion.matches?1:Math.min(1,(now-began)/1100),elapsed=t*1100,eased=ease(t);
   leaves.forEach((leaf,i)=>{
    if(leaf.hidden)return;
    const incoming=i>=count,d=i%count-radius(),rank=Math.abs(d),wall=mode==='wall';
    const depth=wall?0:(Math.sin(d*1.25)*110-Math.abs(d)*48)*.8;
    const baseY=(wall?Math.cos(Math.abs(d)*Math.PI)*18:Math.sin(d*1.7)*25)*unit;
    let x=d*stride(),y=baseY,z=depth,angle=wall?0:42+Math.sin(d*.7)*20,opacity=1,origin=50,order=0;
    if(wall){
     x+=direction*rackWidth*.24*(incoming?1-eased:-eased);
     opacity=incoming?Math.min(1,eased/.45):1-Math.max(0,(eased-.55)/.45);
    }else{
     const p=ease(limit((elapsed-(incoming?120+rank*105:rank*65))/(incoming?550:480)));
     if(incoming){
      x+=-d*stride()*(1-p)+direction*rackWidth*.10*(1-p);
      y+=-baseY*(1-p)-18*Math.sin(p*Math.PI);
      z+=(-depth-100+rank*5)*(1-p)+90*Math.sin(p*Math.PI);
      angle-=direction*115*(1-p);opacity=limit(p*5);origin=p*50;order=(150-rank*10)*(1-p);
     }else{
      x+=-d*stride()*p+direction*rackWidth*.05*Math.sin(p*Math.PI);
      y-=baseY*p;z+=-depth*p+70*Math.sin(p*Math.PI)-90*p;
      angle+=direction*110*p;opacity=1-p;origin=(1-p)*50;order=30-rank;
     }
    }
    const scale=wall?.82+.34*Math.max(0,1-Math.abs(d)):900/(900-z);
    leaf.style.transform='translate(calc(-50% + '+x+'px),calc(-50% + '+y+'px)) scale('+scale+')';
    leaf.style.opacity=opacity;leaf.style.zIndex=Math.round(1000+z+order);
    leaf.style.filter=wall?'none':'blur('+(Math.max(0,Math.abs(d)-1.3)*.28*unit)+'px)';
    leaf.firstChild.style.transformOrigin=origin+'% center';
    leaf.firstChild.style.transform=wall?'none':'perspective('+(650*unit)+'px) rotateY('+angle+'deg)';
   });
   if(t<1)frame=requestAnimationFrame(tick);
   else{wrapping=false;seam.hidden=true;position=goal=to;reverseGuard={direction:-direction,remaining:buffer()};warmKey='';draw();}
  }
  frame=requestAnimationFrame(tick);
 }
 function animateLayout(change){
  stop();
  const old=new Map(slots.filter(book=>!book.hidden).map(book=>[book.dataset.trackId,{transform:book.style.transform,plane:book.firstChild.style.transform,opacity:book.style.opacity}]));
  change();draw();
  if(reducedMotion.matches)return;
  for(const book of slots){
   const before=old.get(book.dataset.trackId);if(book.hidden||!before)continue;
   pageAnimations.push(book.animate([{transform:before.transform,opacity:before.opacity},{transform:book.style.transform,opacity:book.style.opacity}],{duration:340,easing:'cubic-bezier(.2,.7,.2,1)'}));
   pageAnimations.push(book.firstChild.animate([{transform:before.plane},{transform:book.firstChild.style.transform}],{duration:340,easing:'cubic-bezier(.2,.7,.2,1)'}));
  }
 }
 function draw(){
  if(wrapping)return;
  seam.hidden=true;
  const center=Math.round(position),count=Math.min(18,songs.length),first=center-Math.min(8,Math.floor(count/2));
  if(warmKey!==first){
   warmKey=first;
   for(let distance=0;distance<=10;distance++){
    const positions=distance?[center-distance,center+distance]:[center];
    for(const absolute of positions){
     if(absolute<first||absolute>=first+count)continue;
     const track=wrapIndex(absolute),book=slots[((absolute%18)+18)%18];
     bindCover(book,track);
     book.setAttribute('aria-label','预览 '+songs[track].title+' · '+songs[track].artist);
    }
   }
   for(let distance=1;distance<=6;distance++){
    for(const absolute of [first-distance,first+count-1+distance]){
     const cover=songs[wrapIndex(absolute)].cover;
     if(cover)preloadCover(cover).catch(()=>{});
    }
   }
  }
  const selected=picked?songs.find(song=>song.id===picked):null;
  slots.forEach((book,slot)=>{
   const absolute=first+((slot-first%18+18)%18),track=wrapIndex(absolute);
   const distance=Math.abs(absolute-position),offset=absolute-position;
   book.hidden=absolute>=first+count||absolute<0||absolute>=songs.length||distance>=radius()+.95;
   if(book.hidden)return;
   const song=songs[track];
   const wall=mode==='wall',focus=Math.max(0,1-distance),chosen=song.id===picked;
   const unit=rackWidth/1024;
   const depth=wall?0:(Math.sin(offset*1.25)*110-distance*48)*.8;
   let x=offset*stride()-(wall?0:pointerX*(18+Math.max(-150,depth)*.35)*unit)+edgePixels*.19;
   let y=(wall?-Math.cos(distance*Math.PI)*-18:Math.sin(offset*1.7)*25)*unit-(wall?0:pointerY*(10+depth*.11)*unit);
   let angle=wall?0:42+Math.sin(offset*.7)*20-pointerX*7;
   let scale=wall?.82+.34*focus:900/(900-depth);
   if(chosen){x=0;y=innerHeight<=720?-rack.clientHeight*.17:0;angle=0;scale=innerHeight<=720?.82:1.08;}else if(picked){x+=Math.sign(track-songs.indexOf(selected))*Math.min(180,rackWidth*.18);scale*=.86;}
   book.style.translate=!picked&&song.id===hoverId?'0 '+(-18*unit)+'px':'0 0';
   book.style.transform='translate(calc(-50% + '+x+'px),calc(-50% + '+y+'px)) scale('+scale+')';
   book.firstChild.style.transform=wall?'none':'perspective('+(650*unit)+'px) rotateY('+angle+'deg) rotateX('+(chosen?0:pointerY*3)+'deg)';
   book.style.filter='blur('+(wall||chosen?0:Math.max(0,distance-1.3)*.35*.8*unit)+'px)';
   book.style.opacity=String(Math.min(1,Math.max(0,radius()+1-distance))*(picked&&!chosen?.55:1));book.style.zIndex=chosen?1000:Math.round(500+depth);book.classList.toggle('picked',chosen);book.disabled=busy;
  });
  detail.hidden=!selected;if(selected){title.textContent=selected.title;artist.textContent=selected.artist||'未知歌手';const d=Number(selected.duration);meta.textContent=[typeof selected.album==='string'?selected.album:'',Number.isFinite(d)&&d>0?Math.floor(d/60)+':'+String(Math.floor(d%60)).padStart(2,'0'):'',`档案 ${songs.indexOf(selected)+1} / ${songs.length}`].filter(Boolean).join(' · ');}
  play.disabled=put.disabled=busy;
 }
 function preview(id){
  if(busy||wrapping||!songs.some(s=>s.id===id))return;
  if(document.body.classList.contains('immersive'))toggleImmersive();
  const target=songs.findIndex(song=>song.id===id);
  if(!slots.some(book=>!book.hidden&&book.dataset.trackId===id)){position=goal=target;warmKey='';draw();}
  animateLayout(()=>{picked=id;hoverId='';});
 }
 function glide(target, fromDrag=false){
  stop();
  goal=clamp(target);
  picked='';
  const origin=position;
  const distance=Math.abs(goal-origin);
  const duration=150;
  if(distance<.001||reducedMotion.matches){position=goal;draw();return;}
  rack.classList.add('moving');
  const began=performance.now();
  function tick(now){
   const progress=Math.min(1,Math.max(0,(now-began)/duration));
   position=progress===1?goal:origin+(goal-origin)*(1-(1-progress)**3);
   draw();
   if(progress<1) frame=requestAnimationFrame(tick);
   else stop();
  }
  frame=requestAnimationFrame(tick);
 }
 function browse(delta){
  if(!active()||flashing||songs.length<2||busy||wrapping||start)return;
  if(reverseGuard&&Math.sign(delta)===reverseGuard.direction){
   reverseGuard.remaining-=buffer()*.55;
   if(reverseGuard.remaining>0)return;
  }
  reverseGuard=null;
  const target=Math.round(goal)+delta;
  if(target<0||target>=songs.length){
   edgePixels-=Math.sign(delta)*buffer()*.55;
   if(Math.abs(edgePixels)>=buffer())wrap(Math.sign(delta));else draw();
   return;
  }
  edgePixels=0;
  if(!frame||target!==goal)glide(target);
 }
 select.onchange=()=>{cancelSearchJump();clear();mode=select.value;try{HigherSettings.setItem(key,mode)}catch{}renderGallery();refresh();};
 put.onclick=()=>animateLayout(()=>{picked='';});
 play.onclick=async()=>{
  const target=songs.find(s=>s.id===picked);if(!target||busy)return;const id=++epoch,version=viewVersion;busy=true;refresh();host.classList.add('spine-closing');
  const book=slots.find(b=>b.dataset.trackId===target.id),r=book?.getBoundingClientRect();
  if(!reducedMotion.matches)await new Promise(resolve=>setTimeout(resolve,450));
  if(id!==epoch||version!==viewVersion||!songs.includes(target))return;
  picked='';if(!document.body.classList.contains('immersive'))toggleImmersive();
  if(r&&!reducedMotion.matches){const ghost=document.createElement('img');ghost.className='spine-flight';ghost.src=target.cover||FALLBACK;ghost.style.cssText=`position:fixed;z-index:30;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;pointer-events:none`;document.body.append(ghost);const to=$('discCover').getBoundingClientRect();ghost.animate([{transform:'translate(0,0)',borderRadius:'0',opacity:1},{transform:`translate(${to.left-r.left}px,${to.top-r.top}px) scale(${to.width/r.width})`,transformOrigin:'top left',borderRadius:'50%',opacity:0}],{duration:650,easing:'ease-in-out'});setTimeout(()=>ghost.remove(),700);}
  busy=false;host.classList.remove('spine-closing');const targetIndex=songs.indexOf(target);
  if(targetIndex===index){if(audio.paused)playbackCommand('play');}else goTo(targetIndex,false);
  refresh();
 };
 let start=null,dragged=false;
 let wheelTime=-Infinity,wheelDistance=0,wheelDirection=0;
 function dragTo(clientX){
  if(songs.length<2){edgePixels=0;draw();return;}
  let pixels=clientX-start.x;
  if(start.guard&&Math.sign(-pixels)===start.guard.direction){
   const consumed=Math.min(Math.abs(pixels),start.guard.remaining);
   reverseGuard={...start.guard,remaining:start.guard.remaining-consumed};
   pixels=Math.sign(pixels)*Math.max(0,Math.abs(pixels)-start.guard.remaining);
   if(pixels)reverseGuard=null;
  }else if(start.guard&&Math.abs(pixels)>5)reverseGuard=null;
  const raw=start.position-pixels/stride();
  goal=position=clamp(raw);
  edgePixels=(position-raw)*stride();
  draw();
 }
 rack.addEventListener('pointerdown',event=>{
  if(event.button!==0||flashing||busy||wrapping||start)return;
  stop();
  goal=position;
  start={position,x:event.clientX,id:event.pointerId,guard:reverseGuard?{...reverseGuard}:null};
  dragged=false;
  rack.setPointerCapture(event.pointerId);
  event.stopPropagation();
 });
 document.addEventListener('pointermove',event=>{
  if(!active()||flashing||busy||wrapping||document.querySelector('dialog[open]'))return;
  if(!start){
   if(picked||reducedMotion.matches||event.pointerType==='touch')return;
   hoverId=event.target.closest('.spine-book')?.dataset.trackId||'';
   pointerX=event.clientX/innerWidth*2-1;
   pointerY=event.clientY/innerHeight*2-1;
   if(!dragFrame)dragFrame=requestAnimationFrame(()=>{dragFrame=0;draw()});
   return;
  }
  if(start.id!==event.pointerId||(!dragged&&Math.abs(event.clientX-start.x)<=5))return;
  dragged=true;
  picked='';
  rack.classList.add('moving');
  start.latestX=event.clientX;
  if(!dragFrame)dragFrame=requestAnimationFrame(()=>{
   dragFrame=0;
   if(start)dragTo(start.latestX);
  });
 });
 function finishPointer(event){
  if(start?.id!==event.pointerId)return;
  cancelAnimationFrame(dragFrame);
  dragFrame=0;
  if(dragged)dragTo(event.type==='pointerup'?event.clientX:start.latestX);
  start=null;
  if(dragged||event.type!=='pointerup'){
   if(event.type==='pointerup'&&Math.abs(edgePixels)>=buffer())wrap(edgePixels<0?1:-1);
   else{edgePixels=0;glide(Math.round(position),true);}
  }
  else{
   const book=document.elementFromPoint(event.clientX,event.clientY)?.closest('.spine-book');
   if(book)preview(book.dataset.trackId);
  }
  setTimeout(()=>dragged=false,0);
 }
 rack.addEventListener('pointerup',finishPointer);
 rack.addEventListener('pointercancel',finishPointer);
 rack.addEventListener('lostpointercapture',finishPointer);
 document.documentElement.addEventListener('pointerleave',()=>{if(!start){pointerX=pointerY=0;hoverId='';draw()}});
 rack.addEventListener('dragstart',event=>event.preventDefault());
 document.addEventListener('wheel',event=>{
  if(!active()||document.querySelector('dialog[open]')||event.ctrlKey)return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const delta=Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX:event.deltaY;
  if(!delta||start||busy)return;
  const now=performance.now();
  const direction=Math.sign(delta);
  if(direction!==wheelDirection||now-wheelTime>150)wheelDistance=0;
  if(direction===wheelDirection&&now-wheelTime<85)return;
  wheelDirection=direction;
  wheelDistance+=delta*(event.deltaMode===1?16:event.deltaMode===2?rackWidth:1);
  if(Math.abs(wheelDistance)<32)return;
  wheelTime=now;
  browse(Math.sign(wheelDistance));
  wheelDistance=0;
 },{capture:true,passive:false});
 document.addEventListener('keydown',event=>{
  if(!active()||document.querySelector('dialog[open]')||event.target.closest('input,textarea,select,[contenteditable]'))return;
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Escape'].includes(event.key))return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if(event.key==='Escape'){clear();glide(Math.round(position),true);}
  else{
   const direction=['ArrowRight','ArrowDown'].includes(event.key)?1:-1,now=performance.now();
   if(event.repeat&&direction===keyDirection&&now-keyTime<100)return;
   keyTime=now;keyDirection=direction;browse(direction);
  }
 },true);
 globalThis.HigherGalleryModes={get mode(){return mode},refresh,preview, browse,
  prepareSearch(){clear();detail.hidden=true;draw();}};
 document.addEventListener('higher:queue-changed',refresh);window.addEventListener('resize',refresh);
 let lastImmersive=document.body.classList.contains('immersive');
 new MutationObserver(()=>{const now=document.body.classList.contains('immersive');if(now===lastImmersive)return;lastImmersive=now;if(!active())clear();refresh()}).observe(document.body,{attributes:true,attributeFilter:['class']});
 refresh();
})();
