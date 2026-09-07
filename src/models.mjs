import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {get,status,inspectExpression,settings} from './bridge.mjs';
import {connect} from './cdp.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function later(c,code){if(process.env.BRIDGE_MODEL_TRACE)console.error("action",code.slice(0,160));await c.evaluate(`setTimeout(()=>{${code}},100);true`);await sleep(400)}
async function open(c){
 if(await c.evaluate(`!!document.querySelector('[data-testid="composer-intelligence-picker-content"]')`))return;
 const point=await c.evaluate(`(()=>{const e=[...document.querySelectorAll('main button[aria-haspopup="menu"],form button[aria-haspopup="menu"]')].find(e=>e.classList.contains('__composer-pill') && e.innerText.trim());if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 if(!point)throw Error('无法找到网页模型按钮');
 for(const type of ['mousePressed','mouseReleased']){try{await c.call('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})}catch(e){if(!e.message.includes('timeout'))throw e}}
 await sleep(250);
 if(!await c.evaluate(`!!document.querySelector('[data-testid="composer-intelligence-picker-content"]')`))throw Error('无法打开网页模型菜单');
}
async function close(c){await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await c.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(200)}
async function picker(c){return c.evaluate(`({family:[...document.querySelectorAll('[role="menuitemradio"]')].find(e=>e.getAttribute('aria-checked')==='true')?.innerText.trim(),families:[...document.querySelectorAll('[role="menuitemradio"]')].filter(e=>e.getAttribute('aria-disabled')!=='true').map(e=>e.innerText.trim()),effort:Number(document.querySelector('[data-model-reasoning-effort-slider] [role="slider"]')?.getAttribute('aria-valuenow')),max:Number(document.querySelector('[data-model-reasoning-effort-slider] [role="slider"]')?.getAttribute('aria-valuemax'))})`)}
export async function selectUi(c,model){
 if(process.env.BRIDGE_MODEL_TRACE)console.error("select",model);await open(c);let p=await picker(c);
 if(p.family!==model.family){
  if(!p.families.includes(model.family))throw Error('网页没有此模型系列：'+model.family);
  await later(c,`document.querySelector('[role="menuitem"][aria-label="选择模型"]')?.click();`);
  await later(c,`[...document.querySelectorAll('[role="menuitemradio"]')].find(e=>e.innerText.trim()===${JSON.stringify(model.family)})?.click();`);
  await open(c);p=await picker(c);
  if(p.family!==model.family)throw Error('网页未切换到指定模型系列');
 }
 if(!Number.isInteger(p.effort)||model.effort>p.max)throw Error('网页推理档位无法识别');
 for(let i=0;i<12&&p.effort!==model.effort;i++){
  const key=p.effort<model.effort?'ArrowRight':'ArrowLeft';
  await later(c,`const e=document.querySelector('[role="menuitem"][aria-label="能力"]');e?.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},code:${JSON.stringify(key)},bubbles:true}));`);
  p=await picker(c);
 }
 if(p.effort!==model.effort)throw Error('无法应用指定推理档位');
 await close(c);
 const result=await c.evaluate(inspectExpression);
 if(!result.modelLabels.length)throw Error('无法确认切换后的模型');
 return {...model,label:result.modelLabels[0]};
}
export async function ensureModel(c,model){
 let p=await c.evaluate(inspectExpression);
 if(p.modelLabels.some(x=>x===model.label))return;
 if(!model.autoSelect)throw Error('网页模型不匹配，请手动选择 '+model.label);
 if(p.login!=='confirmed_by_ui'||p.generating||p.draftPresent)throw Error('当前页面不适合切换模型');
 const selected=await selectUi(c,model);
 if(selected.label!==model.label)throw Error(`网页实际模型为 ${selected.label}，与目标 ${model.label} 不同；没有发送消息`);
}
async function main(){
 const command=process.argv[2];if(!['scan','apply'].includes(command))throw Error('Expected scan or apply');
 const root=path.join(os.homedir(),'.local/state/codex-chatgpt-bridge');
 try{await fs.access(path.join(root,'active.json'));throw Error('有正在跟踪的咨询，请完成后再操作模型')}catch(e){if(e.code!=='ENOENT')throw e}
 const s=await status();const p=s.pages.find(p=>p.id===s.selectedTabId);
 if(!p||p.login!=='confirmed_by_ui'||p.generating||p.draftPresent)throw Error('请先准备一个已登录且没有草稿或进行中回答的 ChatGPT 标签页');
 const t=(await get('/json/list')).find(t=>t.id===p.id);const c=await connect(t.webSocketDebuggerUrl);
 try{
  await c.call('Page.bringToFront');
  if(command==='apply'){await ensureModel(c,{...settings.model,autoSelect:true});console.log(JSON.stringify({applied:true,model:settings.model.label}));return}
  await open(c);const original=await picker(c);const list=[];
  try{
   for(const family of original.families){
    // Enumerate the web UI, not an API model catalogue.
    for(const effort of [original.max]){
     try{const entry=await selectUi(c,{family,effort});if(!list.some(m=>m.label===entry.label))list.push(entry)}catch(e){list.push({family,effort,unavailable:true,detail:e.message});break}
    }
   }
  }finally{await selectUi(c,{family:original.family,effort:original.effort})}
  const result={checkedAt:new Date().toISOString(),models:list.filter(m=>!m.unavailable),unavailable:list.filter(m=>m.unavailable)};
  await fs.writeFile(path.join(root,'models.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await close(c).catch(()=>{});c.close()}
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({error:e.message}));process.exitCode=1});
