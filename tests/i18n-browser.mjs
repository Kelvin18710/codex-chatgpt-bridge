// Optional browser acceptance. Uses synthetic API fixtures, never ChatGPT messages.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {connect} from '../src/cdp.mjs';
import {defaults,revision,validate} from '../src/config.mjs';
const root=path.resolve(import.meta.dirname,'..');
let config=structuredClone(defaults);config.prompt.text='Identify gaps, distinguish evidence from assumptions, and suggest verifiable next steps. Answer in English.';
const record={id:'demo-review',task:'design-review',taskName:'保存设置',title:'保存设置',prompt:'保存设置',answer:'咨询已启用',assessment:'偏好设置',status:'completed',createdAt:'2026-09-08T08:00:00Z',model:'6 Pro',archived:false,configSnapshot:config};
const writes=[];
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');let value;
  if(url.pathname==='/api/bootstrap')value={config,revision:revision(config),defaults,configPath:'~/.config/codex-chatgpt-bridge/config.json',token:'fixture-token',models:{models:[config.model]}};
  else if(url.pathname==='/api/status')value={status:'ready',selectedTabId:'fixture-tab',active:null,pages:[{id:'fixture-tab',modelLabels:['6 Pro'],login:'confirmed_by_ui',url:'https://chatgpt.com/'}]};
  else if(url.pathname==='/api/history')value=[record];
  else if(url.pathname==='/api/requests/demo-review')value=record;
  else if(url.pathname==='/api/config'&&req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);config=validate(data.config);writes.push(config);value={config,revision:revision(config)}}
  else if(url.pathname.startsWith('/api/')){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:'请先完成当前咨询'}));return}
  else{const files={'/':'index.html','/app.js':'app.js','/i18n.js':'i18n.js','/style.css':'style.css'};if(!files[url.pathname]){res.writeHead(404);res.end();return}res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(path.join(root,'src/web',files[url.pathname])));return}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
 }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}))}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port;
let tab,c;const checks=[];
async function check(name,fn){await fn();checks.push(name);console.log('PASS',name)}
async function wait(expr){for(let i=0;i<60;i++){if(await c.evaluate(expr))return;await new Promise(r=>setTimeout(r,100))}throw Error('Timed out: '+expr)}
const lang=async value=>{await c.evaluate(`document.querySelector('#language').value=${JSON.stringify(value)};document.querySelector('#language').dispatchEvent(new Event('change'))`);await wait(`document.documentElement.lang===${JSON.stringify(value)}`)};
try{
 tab=await(await fetch('http://127.0.0.1:9222/json/new?'+encodeURIComponent(url),{method:'PUT'})).json();c=await connect(tab.webSocketDebuggerUrl);
 await c.call('Runtime.enable');await c.call('Page.enable');await wait(`document.querySelector('#model')?.options.length===1`);
 await check('English static text, status and accessible labels',async()=>{await lang('en');await wait(`document.querySelector('#connection').textContent==='Ready'`);assert.equal(await c.evaluate(`document.querySelector('h1').textContent`),'Advice, on your terms');assert.equal(await c.evaluate(`document.querySelector('#search').getAttribute('aria-label')`),'Search consultation history')});
 await check('switching preserves unsaved settings and question drafts without writes',async()=>{await c.evaluate(`document.querySelector('#initial-prompt').value='保存设置';document.querySelector('#initial-prompt').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#question').value='咨询已启用';document.querySelector('#task').value='中文任务'`);await lang('zh-CN');await lang('en');assert.deepEqual(await c.evaluate(`['initial-prompt','question','task'].map(id=>document.getElementById(id).value)`),['保存设置','咨询已启用','中文任务']);assert.equal(await c.evaluate(`document.querySelector('#save-state').textContent`),'Unsaved changes');assert.equal(writes.length,0)});
 await check('English save persists original content and updates toast',async()=>{await c.evaluate(`document.querySelector('#settings-form').requestSubmit()`);await wait(`document.querySelector('#save-state').textContent==='All changes saved'`);assert.equal(writes.length,1);assert.equal(config.prompt.text,'保存设置');assert.equal(await c.evaluate(`document.querySelector('#toast').textContent`),'Settings saved for your next consultation')});
 await check('language persists after reload and action buttons can switch again',async()=>{await c.call('Page.reload');await new Promise(r=>setTimeout(r,500));await wait(`document.querySelector('#model')?.options.length===1`);assert.equal(await c.evaluate('document.documentElement.lang'),'en');await c.evaluate(`document.querySelector('#refresh').click()`);await wait(`!document.querySelector('#refresh').disabled`);await lang('zh-CN');assert.equal(await c.evaluate(`document.querySelector('#refresh').textContent`),'↻ 检查连接');await lang('en')});
 await check('history and detail translate labels without translating user records',async()=>{await c.evaluate(`location.hash='history'`);await wait(`document.querySelector('.history-row')`);assert.equal(await c.evaluate(`document.querySelector('.record-title').textContent`),'保存设置');assert.equal(await c.evaluate(`document.querySelector('.status-pill').textContent`),'Completed');await c.evaluate(`document.querySelector('.history-row').click()`);await wait(`document.querySelector('#detail').open`);assert.deepEqual(await c.evaluate(`['detail-question','detail-answer','detail-assessment'].map(id=>document.getElementById(id).textContent)`),['保存设置','咨询已启用','偏好设置']);assert.equal(await c.evaluate(`document.querySelector('#detail-archive').textContent`),'Archive');await c.evaluate(`document.querySelector('#close-detail').click()`)});
 await check('API errors have English user-facing text',async()=>{await c.evaluate(`location.hash='settings';document.querySelector('#apply-model').click()`);await wait(`!document.querySelector('#apply-model').disabled`);assert.equal(await c.evaluate(`document.querySelector('#toast').textContent`),'Complete the current consultation first')});
 // Stage neutral example content for documentation screenshots, never real user data.
 await c.evaluate(`document.querySelector('#initial-prompt').value='Identify gaps, distinguish evidence from assumptions, and suggest verifiable next steps. Answer in English.';document.querySelector('[name=trigger][value=smart]').click();document.querySelector('#settings-form').requestSubmit()`);await wait(`document.querySelector('#save-state').textContent==='All changes saved'`);await c.evaluate(`document.querySelector('#toast').hidden=true;document.querySelector('#notice').hidden=true;scrollTo(0,0)`);
 await check('English and Chinese layouts fit desktop and mobile',async()=>{for(const locale of ['en','zh-CN']){await lang(locale);for(const width of [1440,390]){await c.call('Emulation.setDeviceMetricsOverride',{width,height:width===1440?1060:844,deviceScaleFactor:1,mobile:width===390});await new Promise(r=>setTimeout(r,150));assert.equal(await c.evaluate('document.documentElement.scrollWidth>innerWidth'),false,locale+' '+width);if(width===1440){const shot=await c.call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,'docs',locale==='en'?'settings.en.png':'settings.png'),Buffer.from(shot.data,'base64'))}}}});
 console.log(JSON.stringify({passed:checks.length,chatgptSends:0}));
}finally{if(c)c.close();if(tab)await fetch('http://127.0.0.1:9222/json/close/'+tab.id);await new Promise(r=>server.close(r))}
