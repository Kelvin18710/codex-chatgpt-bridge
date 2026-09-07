import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';
const url='http://127.0.0.1:9230',dir=path.dirname(fileURLToPath(import.meta.url)),state=path.join(os.homedir(),'.local/state/codex-chatgpt-bridge');
async function running(){try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1500)});return (await r.json()).app==='codex-chatgpt-bridge'}catch{return false}}
if(!await running()){await fs.mkdir(state,{recursive:true});const log=await fs.open(path.join(state,'manager.log'),'a',0o600);const p=spawn(process.execPath,[path.join(dir,'server.mjs')],{detached:true,stdio:['ignore',log.fd,log.fd]});await new Promise((r,j)=>{p.once('spawn',r);p.once('error',j)});p.unref();await log.close();for(let i=0;i<20&&!await running();i++)await new Promise(r=>setTimeout(r,250));if(!await running())throw Error('管理页启动失败，请查看 manager.log')}
console.log(url);
if(!process.argv.includes('--no-open')){
 try{const list=await(await fetch('http://127.0.0.1:9222/json/list',{signal:AbortSignal.timeout(1500)})).json();const existing=list.find(t=>t.type==='page'&&t.url.startsWith(url));if(existing)await fetch('http://127.0.0.1:9222/json/activate/'+existing.id);else await fetch('http://127.0.0.1:9222/json/new?'+encodeURIComponent(url),{method:'PUT'});}catch{const p=spawn('xdg-open',[url],{detached:true,stdio:'ignore'});p.on('error',e=>console.error(e.message));p.unref()}
}
