(() => {
  const host=$('settingsDialog'),home=$('settingsHome'),grid=$('settingsGrid'),trigger=$('settingsOpen');
  const groups={settingsLibrary:['playlists','playlistBrowse','enterGallery','searchOpen'],settingsAtmosphere:['viewToggle','backgroundOpen'],settingsPlayback:['check'],settingsAccountActions:['scan','logout']};
  for(const [slot,ids] of Object.entries(groups))for(const id of ids)$(slot).append($(id));
  $('settingsPlayback').append($('historySync').closest('label'));$('settingsStaging').remove();
  const pages=[...document.querySelectorAll('.panel-page')];
  let current=null,revision=0,animations=[],closing=false,suppressClose=false;
  const nativeOpen=host.showModal.bind(host),nativeClose=host.close.bind(host);
  const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  const shuffle=a=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
  const cancel=()=>{animations.forEach(a=>a.cancel());animations=[];host.style.width='';host.style.height='';};
  const notify=page=>{if(!page)return;suppressClose=true;try{page.dispatchEvent(new Event('close'));if(page.id==='loginDialog')closeLogin();}finally{suppressClose=false;}};
  function chunks(page){return page===home?[...grid.children]:[...page.children].filter(n=>!n.hidden).slice(0,8)}
  async function motion(page,out=false){
    if(reduced()||!page)return;
    const jobs=chunks(page).map((node,i)=>{
      if(!out){node.dataset.flyX=String((i%2?1:-1)*(innerWidth*.55+Math.random()*100));node.dataset.flyY=String((Math.random()-.5)*160)}
      const s=getComputedStyle(node),inside={transform:out?s.transform:'translate(0,0)',opacity:out?s.opacity:1,filter:out?s.filter:'blur(0px)'};
      const outside={transform:`translate(${node.dataset.flyX||400}px,${node.dataset.flyY||0}px) scale(.97)`,opacity:0,filter:'blur(15px)'};
      const a=node.animate(out?[inside,outside]:[outside,inside],{duration:out?260:520,delay:i*(out?12:28),easing:out?'ease-in':'cubic-bezier(.16,1,.3,1)',fill:'both'});animations.push(a);return a.finished.catch(()=>{});
    });await Promise.all(jobs);
  }
  async function open(id='settingsHome'){
    const target=$(id);if(!target||!pages.includes(target))return;
    if(current===target&&host.open&&!closing)return;
    const rev=++revision,previous=current,wasOpen=host.open,before=wasOpen?host.getBoundingClientRect():null;
    cancel();closing=false;host.classList.remove('closing');current=target;
    if(!wasOpen){

      pages.forEach(p=>p.hidden=p!==target);host.dataset.page=id;nativeOpen();trigger.setAttribute('aria-expanded','true');
    }else{
      notify(previous);await motion(previous,true);if(rev!==revision)return;
      pages.forEach(p=>p.hidden=p!==target);cancel();host.dataset.page=id;
      const after=host.getBoundingClientRect();
      if(!reduced()){
        const a=host.animate([{width:before.width+'px',height:before.height+'px'},{width:after.width+'px',height:after.height+'px'}],{duration:340,easing:'cubic-bezier(.2,.8,.2,1)'});animations.push(a);
      }
    }
    await motion(target);if(rev!==revision)return;cancel();
    (target.querySelector('h2')||target).setAttribute('tabindex','-1');(target.querySelector('h2')||target).focus({preventScroll:true});
  }
  async function close(){
    if(!host.open||closing||suppressClose)return;
    const rev=++revision,previous=current;closing=true;current=null;host.classList.add('closing');
    notify(previous);cancel();await motion(previous,true);if(rev!==revision)return;
    nativeClose();cancel();closing=false;host.classList.remove('closing');trigger.setAttribute('aria-expanded','false');trigger.focus({preventScroll:true});
  }
  for(const page of pages){
    if(page!==home){
      host.append(page);
      const bar=document.createElement('div');bar.className='panel-backbar';const back=document.createElement('button');back.textContent='‹ 返回 Setting';back.type='button';back.onclick=()=>open('settingsHome');bar.append(back);page.prepend(bar);
    }
    // Compatibility at this app's page boundary; no global native prototype changes.
    Object.defineProperty(page,'open',{get:()=>host.open&&current===page&&!closing});
    page.showModal=()=>open(page.id);page.close=()=>close();
  }
  window.HigherPanels={open,close,back:()=>open('settingsHome'),isActive:id=>current?.id===id&&host.open};
  trigger.onclick=()=>host.open?close():open();$('settingsClose').onclick=close;
  host.addEventListener('cancel',e=>{e.preventDefault();void close()});
  host.addEventListener('click',e=>{
    if(e.target===host){const r=host.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)void close();}
  });
  updateGalleryEntry();
  function account(info={}) {
    $('settingsAccount').textContent=info.user?.name || '扫码连接你的歌单';
  }
  document.addEventListener('higher:account',e=>account(e.detail));account(window.higherAccount);
})();
