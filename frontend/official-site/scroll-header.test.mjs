import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nextHeaderState} from './scroll-header.mjs';

const sample=(state,y,options={})=>nextHeaderState(state,{y,maxY:4000,heroEnd:800,...options});
test('首屏显示，离开后累计微滚达到 24px 才隐藏，上滚 12px 唤回',()=>{
 let state=sample(undefined,790);
 for(let y=792;y<=822;y+=2)state=sample(state,y);
 assert.equal(state.hidden,false);
 state=sample(state,824);assert.equal(state.hidden,true);
 for(let y=822;y>=814;y-=2)state=sample(state,y);
 assert.equal(state.hidden,true);
 state=sample(state,812);assert.equal(state.hidden,false);
});
test('方向反转清空累计，静止帧不打断累计',()=>{
 let state=sample(undefined,1000);
 state=sample(state,1020);state=sample(state,1019);
 state=sample(state,1030);state=sample(state,1030);
 assert.equal(state.hidden,false);
 state=sample(state,1043);assert.equal(state.hidden,true);
});
test('顶部和底部回弹不伪造方向，返回首屏强制显示',()=>{
 let state=sample(sample(undefined,3900),4000);
 for(const y of [4040,4020,4000]){state=sample(state,y);assert.equal(state.hidden,true);}
 state=sample(state,3988);assert.equal(state.hidden,false);
 state=sample(state,800);assert.equal(state.hidden,false);
 for(const y of [-40,-10,0,20]){state=sample(state,y);assert.equal(state.hidden,false);}
});
test('焦点与减少动态锁定显示，释放后重新累计',()=>{
 for(const option of ['focused','reduced']){
  let state=sample(sample(undefined,1000),1024);assert.equal(state.hidden,true);
  state=sample(state,1050,{[option]:true});assert.equal(state.hidden,false);
  state=sample(state,1080,{[option]:true});assert.equal(state.hidden,false);
  state=sample(state,1081);assert.equal(state.hidden,false);
  state=sample(state,1104);assert.equal(state.hidden,true);
 }
});
test('resize/恢复重置位置与累计，文档缩短不当成用户上滚',()=>{
 let state=sample(sample(undefined,1000),1024);
 state=sample(state,900,{reset:true});assert.equal(state.hidden,false);
 state=sample(state,924);assert.equal(state.hidden,true);
 state=sample(state,600,{maxY:600,heroEnd:500});assert.equal(state.hidden,true);
 state=sample(state,600,{heroEnd:900,reset:true});assert.equal(state.hidden,false);
});
