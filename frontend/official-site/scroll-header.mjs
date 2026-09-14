/** 只累计有效滚动范围内、首屏以外的同向位移；布局重算不视为滚动。 */
export function nextHeaderState(previous,{y,maxY,heroEnd,focused=false,reduced=false,reset=false}){
 const position=Math.max(0,Math.min(y,Math.max(0,maxY)));
 const state={y:position,direction:0,distance:0,hidden:false};
 if(!previous||reset||position<=heroEnd||focused||reduced)return state;
 const last=Math.max(0,Math.min(previous.y,Math.max(0,maxY)));
 const delta=position-Math.max(last,heroEnd);
 if(!delta)return {...previous,y:position};
 const direction=Math.sign(delta);
 const distance=(direction===previous.direction?previous.distance:0)+Math.abs(delta);
 const hidden=direction>0?(distance>=24||previous.hidden):(distance<12&&previous.hidden);
 return {y:position,direction,distance:Math.min(distance,24),hidden};
}

// 与粒子渲染独立初始化；装饰动效不可阻断导航增强。
if(typeof document!=='undefined'){
 const header=document.querySelector('body > header');
 const hero=document.querySelector('#top');
 const media=matchMedia('(prefers-reduced-motion: reduce)');
 let state,frame=0;
 function update(reset=false){
  state=nextHeaderState(state,{
   y:scrollY,maxY:document.documentElement.scrollHeight-innerHeight,
   heroEnd:hero.offsetTop+hero.offsetHeight,
   focused:header.contains(document.activeElement)&&document.activeElement.matches(':focus-visible'),reduced:media.matches,reset
  });
  header.classList.toggle('is-hidden',state.hidden);
  // 导航下缘开始覆盖正文时加实底色，避免浅色区段透过深色导航。
  header.classList.toggle('over-content',state.y+header.offsetHeight>=hero.offsetTop+hero.offsetHeight);
 }
 function schedule(){
  if(!frame)frame=requestAnimationFrame(()=>{frame=0;update();});
 }
 function measure(){
  document.documentElement.style.setProperty('--site-header-offset',`${header.offsetHeight+12}px`);
  update(true);
 }
 header.classList.add('scroll-header');
 header.addEventListener('focusin',()=>update(true));
 header.addEventListener('focusout',schedule);
 // 输入方式改变而焦点元素未变时，也同步键盘保护。
 document.addEventListener('keydown',schedule);
 document.addEventListener('pointerdown',schedule,{passive:true});
 addEventListener('scroll',schedule,{passive:true});
 addEventListener('resize',measure);
 addEventListener('pageshow',measure);
 media.addEventListener('change',measure);
 new ResizeObserver(measure).observe(header);
 measure();
}
