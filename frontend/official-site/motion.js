'use strict';
const $ = s => document.querySelector(s), clamp = x => Math.min(1,Math.max(0,x));
const media = matchMedia('(prefers-reduced-motion: reduce)');
let reduced = media.matches, started = performance.now(), raf = 0, pointer = [-10000,-10000];
const section = $('#journey'), track = $('.track'), band = $('.principles');
let journeyDistance = 0, pinEnabled = false;
function layout(){
  document.documentElement.classList.toggle('reduced',reduced);
  pinEnabled = !reduced && innerWidth>900 && innerHeight>=700;
  section.classList.toggle('pinned',pinEnabled);
  journeyDistance = pinEnabled ? Math.max(0,track.scrollWidth-innerWidth) : 0;
  section.style.height = pinEnabled ? `${innerHeight+journeyDistance}px`:'auto';
  scenes.forEach(s=>s.resize());
  updateScroll();requestFrame();
}
function updateScroll(){
  const rect=band.getBoundingClientRect();
  const wipe=reduced?1:clamp((innerHeight-rect.top)/(innerHeight*.58));
  band.style.clipPath=`inset(0 ${100-wipe*100}% 0 0)`;
  const p=pinEnabled?clamp(-section.getBoundingClientRect().top/journeyDistance):0;
  track.style.transform=`translateX(${-p*journeyDistance}px)`;
  $('.progress i').style.transform=`scaleX(${Math.max(.05,p)})`;
}
// Original WebGL point renderer. The source site was studied, not included as a dependency.
const vertex = `
precision mediump float;
attribute vec2 aDisplacement;attribute vec3 aPosition;attribute vec3 aCloud;attribute float aSeed;
uniform float uTime,uProgress,uAspect,uSize,uMode,uScroll,uPointerActive;
uniform vec2 uPointer,uViewport;
varying float vShade;
vec3 turn(vec3 p,vec3 a){float c=cos(a.x),s=sin(a.x);p=vec3(p.x,p.y*c-p.z*s,p.y*s+p.z*c);c=cos(a.y);s=sin(a.y);p=vec3(p.x*c+p.z*s,p.y,-p.x*s+p.z*c);c=cos(a.z);s=sin(a.z);return vec3(p.x*c-p.y*s,p.x*s+p.y*c,p.z);}
void main(){
 vec3 p;float camera;
 if(uMode<.5){
 float k=smoothstep(0.,1.,uProgress);
 p=mix(aCloud,aPosition,k);
 p.xy+=(1.-k)*vec2(sin(uTime+aSeed*15.),cos(uTime*.7+aSeed*9.))*.45;
 float edge=smoothstep(1.7,3.8,length(p.xy));

 p=turn(p,vec3(.16+.20*sin(uTime*.42)+uScroll*.12,-.32+.24*sin(uTime*.35),.075*sin(uTime*.28)-uScroll*.06));
 p*=uAspect<.8?1.36:2.18;camera=uAspect<.8?17.5:14.5;
 }else{
 p=turn(aPosition,vec3(.25*sin(uTime*.3),1.1+.3*sin(uTime*.3),-uTime*.07));
 p*=2.65;p.y+=3.8;camera=11.8;
 }
 float depth=max(.5,camera-p.z);vec2 projected=p.xy*(2.246/depth);projected.x/=uAspect;
 if(uMode<.5)projected.x-=.07;
 vec2 screen=vec2((projected.x*.5+.5)*uViewport.x,(.5-projected.y*.5)*uViewport.y);
 projected+=vec2(aDisplacement.x/uViewport.x,-aDisplacement.y/uViewport.y)*2.;
 gl_Position=vec4(projected,clamp(depth/30.,0.,1.),1.);
 gl_PointSize=clamp((uMode<.5?30.:22.)/depth*uSize,1.,6.*uSize);
 vShade=uMode<.5?clamp(.47+p.z*.15,.18,.86):clamp(.4-p.z*.04,.18,.75);
}`;
const fragment=`precision mediump float;varying float vShade;uniform float uMode,uTheme;void main(){if(length(gl_PointCoord-.5)>.5)discard;float c=uMode<.5?mix(1.-vShade,vShade,uTheme):mix(.45,.72,vShade);gl_FragColor=vec4(vec3(c),1.);}`;
class PointScene{
 constructor(canvas,mode){
  this.canvas=canvas;this.mode=mode;this.visible=false;
  this.gl=canvas.getContext('webgl',{alpha:true,antialias:false,powerPreference:'low-power'});
  if(!this.gl){canvas.dataset.render='unavailable';return;}
  const gl=this.gl;
  function compile(type,src){const shader=gl.createShader(type);gl.shaderSource(shader,src);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));return shader;}
  this.program=gl.createProgram();gl.attachShader(this.program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(this.program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(this.program);if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(this.program));gl.useProgram(this.program);
  const points=[],cloud=[],seeds=[];let seed=19;
  const random=()=>{seed=(seed*16807)%2147483647;return(seed-1)/2147483646;};
  const push=(x,y,z)=>{points.push(x,y,z);cloud.push((random()-.5)*17,(random()-.5)*9,(random()-.5)*8);seeds.push(random());};
  if(mode===0){
   // Sparse points sampled on actual cylindrical, spherical and toroidal surfaces.
   const convert=([x,y])=>[(x-264)*.012,(244-y)*.012];
   const segments=[[[137,308],[210,239]],[[241,234],[272,254]],[[302,251],[398,151]],[[342,151],[407,146]],[[407,146],[405,211]]].map(pair=>pair.map(convert));
   const nodes=[[226,224],[287,266]].map(convert),radius=.38;
   const capsuleDistance=(x,y,z,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)));return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy,z)-(a===segments[0][0]?.5:radius);};
   const ringDistance=(x,y,z,c)=>Math.hypot(Math.hypot(x-c[0],y-c[1])-.31,z)-.23;
   const surface=(x,y,z)=>{
    if(nodes.some(c=>Math.hypot(x-c[0],y-c[1])<.115))return;
    const inside=segments.some(([a,b])=>capsuleDistance(x,y,z,a,b)<-.025)||nodes.some(c=>ringDistance(x,y,z,c)<-.025);
    if(!inside)push(x,y,z);
   };
   for(const [a,b] of segments){
    const radius=a===segments[0][0]?.5:.38;
    const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy),rows=Math.ceil(length/.105);
    for(let i=0;i<=rows;i++)for(let j=0;j<22;j++){
     const t=i/rows,angle=(j+(i%2)*.5)/22*Math.PI*2;
     surface(a[0]+dx*t-dy/length*Math.cos(angle)*radius,a[1]+dy*t+dx/length*Math.cos(angle)*radius,Math.sin(angle)*radius);
    }
    for(const c of [a,b])for(let i=1;i<12;i++){
     const latitude=i/12*Math.PI,n=Math.max(6,Math.round(22*Math.sin(latitude)));
     for(let j=0;j<n;j++){const angle=(j+(i%2)*.5)/n*Math.PI*2;surface(c[0]+radius*Math.sin(latitude)*Math.cos(angle),c[1]+radius*Math.sin(latitude)*Math.sin(angle),radius*Math.cos(latitude));}
    }
   }
   for(const c of nodes)for(let i=0;i<30;i++)for(let j=0;j<14;j++){
    const a=i/30*Math.PI*2,b=(j+(i%2)*.5)/14*Math.PI*2,minor=.23,r=.31+minor*Math.cos(b);
    surface(c[0]+r*Math.cos(a),c[1]+r*Math.sin(a),minor*Math.sin(b));
   }
  }else{
   for(let a=0;a<170;a++)for(let b=0;b<48;b++){const u=a/170*Math.PI*2,v=b/48*Math.PI*2;push((3+Math.cos(v))*Math.cos(u),(3+Math.cos(v))*Math.sin(u),Math.sin(v));}
  }
  this.count=seeds.length;this.positions=points;this.seeds=seeds;this.displacements=new Float32Array(this.count*2);this.velocities=new Float32Array(this.count*2);this.lastTime=null;
  const attr=(name,data,size)=>{const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);const loc=gl.getAttribLocation(this.program,name);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,0,0);};
  attr('aPosition',points,3);attr('aCloud',cloud,3);attr('aSeed',seeds,1);
  this.displacementBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.displacementBuffer);gl.bufferData(gl.ARRAY_BUFFER,this.displacements,gl.DYNAMIC_DRAW);const offsetLoc=gl.getAttribLocation(this.program,'aDisplacement');gl.enableVertexAttribArray(offsetLoc);gl.vertexAttribPointer(offsetLoc,2,gl.FLOAT,false,0,0);
  this.uniforms=Object.fromEntries(['Theme','Time','Progress','Aspect','Size','Mode','Scroll','PointerActive','Pointer','Viewport'].map(n=>[n,gl.getUniformLocation(this.program,'u'+n)]));
  gl.enable(gl.DEPTH_TEST);gl.clearColor(0,0,0,0);canvas.dataset.render='webgl';
  this.observer=new IntersectionObserver(entries=>{this.visible=entries[0].isIntersecting;requestFrame();},{threshold:0});this.observer.observe(canvas);
 }
 resize(){if(!this.gl)return;const r=this.canvas.getBoundingClientRect();this.w=r.width;this.h=r.height;this.dpr=Math.min(devicePixelRatio,innerWidth<700?1:1.5);this.canvas.width=Math.round(this.w*this.dpr);this.canvas.height=Math.round(this.h*this.dpr);this.gl.viewport(0,0,this.canvas.width,this.canvas.height);}
 updateSpring(time){
  if(this.mode!==0)return;
  const dt=Math.min(.025,Math.max(.001,this.lastTime===null?1/60:time-this.lastTime));this.lastTime=time;
  const progress=clamp(scrollY/this.h),ax=.16+.20*Math.sin(time*.42)+progress*.12,ay=-.32+.24*Math.sin(time*.35),az=.075*Math.sin(time*.28)-progress*.06;
  const cx=Math.cos(ax),sx=Math.sin(ax),cy=Math.cos(ay),sy=Math.sin(ay),cz=Math.cos(az),sz=Math.sin(az);
  const narrow=this.w/this.h<.8,scale=narrow?1.36:2.18,camera=narrow?17.5:14.5;
  const rect=this.canvas.getBoundingClientRect(),mx=pointer[0]-rect.left,my=pointer[1]-rect.top;
  const active=!reduced&&time>2.3&&mx>=0&&mx<=this.w&&my>=0&&my<=this.h;
  const radius=Math.min(240,this.w*.27)*.6;
  for(let i=0;i<this.count;i++){
   let x=this.positions[i*3],y=this.positions[i*3+1],z=this.positions[i*3+2];
   const y1=y*cx-z*sx,z1=y*sx+z*cx,x2=x*cy+z1*sy,z2=-x*sy+z1*cy;
   x=(x2*cz-y1*sz)*scale;y=(x2*sz+y1*cz)*scale;z=z2*scale;
   const depth=camera-z,px=(x*2.246/depth/(this.w/this.h)*.5+.5)*this.w-this.w*.035,py=(.5-y*2.246/depth*.5)*this.h;
   const dx=px-mx,dy=py-my,dist=Math.hypot(dx,dy),falloff=active?Math.pow(Math.max(0,1-dist/radius),1.4):0;
   const angle=Math.atan2(dy,dx)+(this.seeds[i]-.5)*.65;
   const force=falloff*(65+this.seeds[i]*80),targets=[Math.cos(angle)*force,Math.sin(angle)*force];
   for(let axis=0;axis<2;axis++){const j=i*2+axis;if(reduced){this.displacements[j]=0;this.velocities[j]=0;continue;}this.velocities[j]+=(targets[axis]-this.displacements[j])*46*dt;this.velocities[j]*=Math.exp(-10.5*dt);this.displacements[j]+=this.velocities[j]*dt;}
  }
  this.gl.bindBuffer(this.gl.ARRAY_BUFFER,this.displacementBuffer);this.gl.bufferSubData(this.gl.ARRAY_BUFFER,0,this.displacements);
 }
 draw(time){
  if(!this.gl||!this.visible)return;const gl=this.gl,u=this.uniforms;gl.useProgram(this.program);this.updateSpring(time);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  gl.uniform1f(u.Theme,document.documentElement.dataset.theme==='dark'?1:0);gl.uniform1f(u.Time,reduced?4:time);gl.uniform1f(u.Progress,reduced?1:clamp((time-.38)/1.9));gl.uniform1f(u.Aspect,this.w/this.h);gl.uniform1f(u.Size,this.dpr);gl.uniform1f(u.Mode,this.mode);gl.uniform1f(u.Scroll,clamp(scrollY/this.h));gl.uniform1f(u.PointerActive,reduced||this.mode!==0?0:1);gl.uniform2f(u.Pointer,...pointer);gl.uniform2f(u.Viewport,this.w,this.h);gl.drawArrays(gl.POINTS,0,this.count);
 }
}
const scenes=[new PointScene($('#field'),0),new PointScene($('#torus'),1)];
function frame(now){raf=0;if(document.hidden)return;scenes.forEach(s=>s.draw((now-started)/1000));if(!reduced&&scenes.some(s=>s.visible))raf=requestAnimationFrame(frame);}
function requestFrame(){if(!raf&&!document.hidden)raf=requestAnimationFrame(frame);}
addEventListener('resize',layout);addEventListener('scroll',()=>{updateScroll();requestFrame();},{passive:true});
addEventListener('pointermove',e=>{pointer=[e.clientX,e.clientY];requestFrame();},{passive:true});
document.addEventListener('pointerleave',()=>{pointer=[-10000,-10000];});
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else requestFrame();});
media.addEventListener('change',e=>{reduced=e.matches;layout();});
for(let i=0;i<49;i++){const el=document.createElement('i');el.style.setProperty('--n',String(5+Math.sin(i*.2)*15+Math.sin(i*.09)*8));$('.wave').append(el);}
const questions=['这家公司最近有哪些重要变化？','我的持仓是否过于集中？','今天有哪些市场消息值得关注？'];
const texts=['查看近期公告和财报，对照行业与股价表现，列出相关来源和仍需确认的信息。','查看单只股票和行业的持仓占比，结合风险偏好检查集中度。','汇总市场消息，查看事件时间、信息来源，以及与关注公司的关联。'];
let typing=0;
function selectMode(index,focus=false){
 cancelAnimationFrame(typing);const tabs=[...document.querySelectorAll('[role=tab]')];tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===index));tab.tabIndex=i===index?0:-1;});if(focus)tabs[index].focus();
 $('.raw').textContent=questions[index];
 $('#output-label').textContent=['查看公告与经营变化','检查持仓集中度','查看消息与关联公司'][index];
 $('#output').setAttribute('aria-labelledby',`tab-${index}`);$('#output').setAttribute('aria-busy','true');
 const start=performance.now(),text=texts[index];
 const type=now=>{const p=reduced?1:clamp((now-start)/1100);$('#typed').textContent=text.slice(0,Math.ceil(text.length*(1-Math.pow(1-p,3))));if(p<1)typing=requestAnimationFrame(type);else $('#output').setAttribute('aria-busy','false');};typing=requestAnimationFrame(type);
}
document.querySelectorAll('[role=tab]').forEach((tab,i)=>{tab.addEventListener('click',()=>selectMode(i));tab.addEventListener('keydown',e=>{let n=i;if(e.key==='ArrowRight'||e.key==='ArrowDown')n=(i+1)%3;else if(e.key==='ArrowLeft'||e.key==='ArrowUp')n=(i+2)%3;else if(e.key==='Home')n=0;else if(e.key==='End')n=2;else return;e.preventDefault();selectMode(n,true);});});
let played=false;new IntersectionObserver(entries=>{if(entries[0].isIntersecting&&!played){played=true;selectMode(0);}},{threshold:.35}).observe($('.voice'));
// Keep panel activation singular across hover, focus, touch and pointer transitions.
const panelGroup=$('.panels'),panels=[...document.querySelectorAll('.panel')];
let focusedPanel=null;
function activatePanel(panel){
 const enabled=innerWidth>=768,selected=enabled?panel:null;
 panelGroup.classList.toggle('has-active',!!selected);
 panels.forEach(p=>{p.classList.toggle('is-active',p===selected);p.setAttribute('aria-expanded',String(p===selected));});
}
panels.forEach(panel=>{
 panel.addEventListener('pointerenter',e=>{if(e.pointerType!=='touch')activatePanel(panel);});
 panel.addEventListener('focus',()=>{focusedPanel=panel.matches(':focus-visible')?panel:null;activatePanel(panel);});
 panel.addEventListener('blur',()=>{focusedPanel=null;});
 panel.addEventListener('click',()=>activatePanel(panel));
 panel.addEventListener('keydown',e=>{if(e.key==='Escape'){panel.blur();focusedPanel=null;activatePanel(null);}});
});
panelGroup.addEventListener('pointerleave',()=>activatePanel(focusedPanel));
panelGroup.addEventListener('focusout',e=>{if(!panelGroup.contains(e.relatedTarget)){focusedPanel=null;activatePanel(null);}});
addEventListener('resize',()=>activatePanel(null));
layout();

function syncTheme(){const dark=document.documentElement.dataset.theme==='dark';$('#theme-toggle').textContent=dark?'浅色模式':'深色模式';$('#theme-toggle').setAttribute('aria-pressed',String(dark));requestFrame();}
$('#theme-toggle').addEventListener('click',()=>{const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem('pa-home-theme',next);}catch{}syncTheme();});
syncTheme();

// Reveal a research state once it becomes readable; no decorative looping in this section.
const researchObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){entry.target.classList.add('is-in-view');researchObserver.unobserve(entry.target);}}},{threshold:.35});
document.querySelectorAll('.research-step').forEach(step=>researchObserver.observe(step));

// 年份在加载、跨日与标签页恢复时更新。
function updateCopyrightYear(){const year=document.getElementById('copyright-year');if(year)year.textContent=String(new Date().getFullYear());}
updateCopyrightYear();setInterval(updateCopyrightYear,60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)updateCopyrightYear();});

// 入口地址由构建环境注入；未配置时点击不改变页面。
document.querySelectorAll('.web-entry').forEach(entry=>{entry.addEventListener('click',()=>{const url=entry.dataset.webAppUrl;if(url)window.location.assign(url);});});
