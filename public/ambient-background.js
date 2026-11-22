(() => {
  function palette(pixels) {
    const bins = new Map();
    for(let i=0;i<pixels.length;i+=4) {
      const [r,g,b,a] = pixels.slice(i,i+4);
      if(a<128 || Math.max(r,g,b)<25 || Math.min(r,g,b)>235) continue;
      const key=[r>>5,g>>5,b>>5].join(',');
      const v=bins.get(key)||{n:0,r:0,g:0,b:0};v.n++;v.r+=r;v.g+=g;v.b+=b;bins.set(key,v);
    }
    const sorted=[...bins.values()].sort((a,b)=>b.n-a.n);
    const first=sorted[0]; if(!first) return ['#44464a','#27292c'];
    const rgb=v=>[v.r/v.n,v.g/v.n,v.b/v.n];const one=rgb(first);
    const second=sorted.find(v=>rgb(v).reduce((s,c,i)=>s+(c-one[i])**2,0)>5000)||first;
    const color=v=>'rgb('+rgb(v).map(c=>Math.round(c*.42+10)).join(',')+')';
    return [color(first),color(second)];
  }
  function mist(colors) { return `radial-gradient(ellipse at 74% 32%, ${colors[0]}, transparent 67%), radial-gradient(ellipse at 26% 76%, ${colors[1]}, transparent 65%), linear-gradient(#13191e,#151719)`; }
  globalThis.HigherAmbient = { palette, mist };
})();
