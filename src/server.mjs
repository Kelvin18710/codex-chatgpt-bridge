import {fileURLToPath} from 'node:url';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadConfig,saveConfig,defaults,revision,configPath,validate} from './config.mjs';
const exec=promisify(execFile),dir=path.dirname(fileURLToPath(import.meta.url)),state=path.join(os.homedir(),'.local/state/codex-chatgpt-bridge'),port=9230,token=randomUUID();
const cli=path.join(os.homedir(),'.local/bin/chatgpt-pro-consult');
await fs.mkdir(path.join(state,'requests'),{recursive:true,mode:0o700});
await fs.mkdir(path.join(state,'inputs'),{recursive:true,mode:0o700});
async function jsonFile(p,fallback){try{return JSON.parse(await fs.readFile(p,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}}
const safeId=id=>{if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id))throw Error('无效的记录编号');return id};
async function command(executable,args,timeout=55000){
 try{const {stdout}=await exec(executable,args,{timeout,maxBuffer:2e6});return stdout.trim()?JSON.parse(stdout):{ok:true}}
 catch(e){let message=e.stderr?.trim()||e.message;try{message=JSON.parse(message).error||message}catch{};const err=Error(e.code===75?'另一项操作正在进行，请稍后再试':message);err.statusCode=409;throw err}
}
const run=args=>command(cli,args);
async function entries(){
 const archive=await jsonFile(path.join(state,'archived.json'),[]),result=[];
 for(const file of await fs.readdir(path.join(state,'requests'))){if(!file.endsWith('.json'))continue;const r=await jsonFile(path.join(state,'requests',file));result.push({id:r.id,task:r.task,taskName:r.taskName||r.task,status:r.status,title:r.prompt?.split('\n').find(Boolean)?.slice(0,100)||r.id,createdAt:r.createdAt,updatedAt:r.updatedAt,model:r.modelAtSend?.join(' / ')||r.configSnapshot?.model.label||'',url:r.url,archived:archive.includes(r.id)})}
 return result.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
}
let configQueue=Promise.resolve();
function saveSerial(c,rev){const p=configQueue.then(()=>saveConfig(c,rev));configQueue=p.catch(()=>{});return p}
async function body(req){let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>600000)throw Error('内容过长')}return JSON.parse(data||'{}')}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 const send=(data,code=200)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data))};
 try{
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)){send({error:'Host rejected'},403);return}
  const url=new URL(req.url,`http://127.0.0.1:${port}`),p=url.pathname;
  if(req.headers['sec-fetch-site']==='cross-site'){send({error:'Cross-site request rejected'},403);return}
  if(req.method!=='GET'){
   if(req.method!=='POST'){send({error:'Method not allowed'},405);return}
   if(req.headers['x-bridge-token']!==token||req.headers.origin&&!['http://127.0.0.1:9230','http://localhost:9230'].includes(req.headers.origin)){send({error:'请刷新管理页后重试'},403);return}
  }
  if(req.method==='GET'){
   if(p==='/api/health'){send({app:'codex-chatgpt-bridge',version:2});return}
   if(p==='/api/bootstrap'){const config=await loadConfig();send({config,revision:revision(config),defaults,configPath,token,models:await jsonFile(path.join(state,'models.json'),{models:[{label:'6 Pro',family:'最新',effort:4}]})});return}
   if(p==='/api/status'){send(await run(['status']));return}
   if(p==='/api/history'){send(await entries());return}
   const match=p.match(/^\/api\/requests\/([^/]+)(\/export)?$/);
   if(match){const id=safeId(match[1]),r=await jsonFile(path.join(state,'requests',id+'.json'),null);if(!r){send({error:'记录不存在'},404);return}if(match[2]){const ext=url.searchParams.get('format')==='md'?'md':'json';res.writeHead(200,{'Content-Type':ext==='md'?'text/markdown; charset=utf-8':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="${id}.${ext}"`});res.end(await fs.readFile(path.join(state,'requests',id+'.'+ext)));return}send(r);return}
   const files={'/':'index.html','/app.js':'app.js','/i18n.js':'i18n.js','/style.css':'style.css'};
   if(files[p]){res.writeHead(200,{'Content-Type':p.endsWith('.js')?'text/javascript; charset=utf-8':p.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});res.end(await fs.readFile(path.join(dir,'web',files[p])));return}
  }else{
   const b=await body(req);
   if(p==='/api/config/validate'){send({config:validate(b.config)});return}
   if(p==='/api/config'){const config=await saveSerial(b.config,b.revision);send({config,revision:revision(config)});return}
   if(p==='/api/browser/start'){try{send(await command(path.join(os.homedir(),'.local/bin/chatgpt-pro-start'),['--json']))}catch(e){const s=await run(['status']);send({...s,notice:e.message})}return}
   if(p==='/api/models/scan'||p==='/api/models/apply'){send(await command('/usr/bin/flock',['-n','-E','75',path.join(state,'consult.lock'),process.execPath,path.join(dir,'models.mjs'),p.endsWith('scan')?'scan':'apply'],150000));return}
   if(p==='/api/browser/bind'){const current=await run(['status']);if(!current.pages.some(x=>x.id===b.id))throw Error('标签页不存在');if(current.active)throw Error('请先完成当前咨询');await fs.writeFile(path.join(state,'browser-target.json'),JSON.stringify({id:b.id}));send({ok:true});return}
   if(p==='/api/consult'){
    if(typeof b.prompt!=='string'||!b.prompt.trim())throw Error('请填写咨询问题');
    const id=safeId(b.id),file=path.join(state,'inputs',id+'.md');
    // Keep failed submissions retryable with the same id; CLI checks the digest.
    await fs.writeFile(file,b.prompt,{mode:0o600});
    const name=typeof b.task==='string'?b.task.trim():'';if(name.length>120)throw Error('任务名称不超过 120 个字符');
    const task=!name?id:/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)?name:'task-'+createHash('sha256').update(name).digest('hex').slice(0,20);
    const args=b.parent?['followup','--parent',safeId(b.parent),'--id',id,'--file',file]:['ask','--id',id,'--task',task,'--task-name',name||'临时咨询','--event','explicit','--file',file];
    send(await run(args));return;
   }
   if(p==='/api/poll'){send(await run(['poll','--id',safeId(b.id),'--wait','0',...(b.refresh?['--refresh']:[])]));return}
   if(p==='/api/release'){send(await run(['release','--id',safeId(b.id)]));return}
   if(p==='/api/archive'){
    const id=safeId(b.id);if(!await jsonFile(path.join(state,'requests',id+'.json'),null))throw Error('记录不存在');
    const active=await jsonFile(path.join(state,'active.json'),null);if(active?.id===id)throw Error('请先结束对此咨询的跟踪');
    let ids=await jsonFile(path.join(state,'archived.json'),[]);ids=b.archived?[...new Set([...ids,id])]:ids.filter(x=>x!==id);await fs.writeFile(path.join(state,'archived.json'),JSON.stringify(ids));send({ok:true});return;
   }
  }
  send({error:'Not found'},404);
 }catch(e){send({error:e.message},e.statusCode||400)}
});
server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:9230'));
server.on('error',e=>{console.error(e.message);process.exitCode=1});
