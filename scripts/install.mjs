#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defaults} from '../src/config.mjs';
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('node scripts/install.mjs [--home DIR] [--enable-auto] [--uninstall]\nDefault: manual consultation. --enable-auto installs a managed AGENTS block and enables smart mode on first install. Uninstall preserves config, history and browser login.');process.exit(0)}
let home=os.homedir();
for(let i=0;i<args.length;i++){if(args[i]==='--home'){if(!args[i+1]||args[i+1].startsWith('--'))throw Error('--home requires a directory');home=path.resolve(args[++i])}else if(!['--enable-auto','--uninstall'].includes(args[i]))throw Error('Unknown option: '+args[i])}
if(Number(process.versions.node.split('.')[0])<22)throw Error('Node.js 22+ required');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const app=path.join(home,'.local/share/codex-chatgpt-bridge'),bin=path.join(home,'.local/bin'),codex=path.join(home,'.codex'),skill=path.join(codex,'skills/chatgpt-pro-consult'),agents=path.join(codex,'AGENTS.md'),config=path.join(home,'.config/codex-chatgpt-bridge/config.json');
const begin='<!-- codex-chatgpt-bridge:start -->',end='<!-- codex-chatgpt-bridge:end -->';
const names=['start','status','consult','manager'].map(n=>'chatgpt-pro-'+n);
async function read(p){try{return await fs.readFile(p,'utf8')}catch(e){if(e.code==='ENOENT')return '';throw e}}
function strip(text){const a=text.indexOf(begin),b=text.indexOf(end);if(a<0&&b<0)return text;if(a<0||b<a||text.indexOf(begin,a+begin.length)>=0)throw Error('Malformed managed AGENTS block');return text.slice(0,a)+text.slice(b+end.length)}
const previous=await read(agents),without=strip(previous);
const desktop=path.join(home,'.local/share/applications/chatgpt-pro-manager.desktop');
if(args.includes('--uninstall')){
 for(const n of names){const p=path.join(bin,n);if((await read(p)).includes('codex-chatgpt-bridge'))await fs.rm(p)}
 // Only remove directories carrying our ownership marker.
 for(const dir of [app,skill])if(await read(path.join(dir,'.bridge-installed')))await fs.rm(dir,{recursive:true});
 if((await read(desktop)).includes('codex-chatgpt-bridge'))await fs.rm(desktop);
 if(previous!==without)await fs.writeFile(agents,without);
 console.log('Uninstalled. Configuration, requests and dedicated Edge profile preserved.');process.exit(0);
}
// Reject ownership conflicts before changing any existing installation.
if(await read(path.join(app,'bridge.mjs'))&&!await read(path.join(app,'.bridge-installed')))throw Error('Existing unmanaged application found; back it up before installing: '+app);
for(const n of names){const text=await read(path.join(bin,n));if(text&&!text.includes('codex-chatgpt-bridge'))throw Error('Existing unrelated launcher: '+path.join(bin,n))}
await fs.mkdir(bin,{recursive:true});await fs.mkdir(codex,{recursive:true});
// Preserve a pre-existing skill instead of silently replacing personal instructions.
if(await read(path.join(skill,'SKILL.md'))&&!await read(path.join(skill,'.bridge-installed')))throw Error('Existing unmanaged skill found; move it aside before installing: '+skill);
await fs.mkdir(app,{recursive:true});
await fs.cp(path.join(root,'src'),app,{recursive:true});
await fs.copyFile(path.join(root,'docs/usage.zh-CN.md'),path.join(app,'README.md'));
await fs.writeFile(path.join(app,'.bridge-installed'),'codex-chatgpt-bridge\n');
for(const n of names){await fs.copyFile(path.join(root,'bin',n),path.join(bin,n));await fs.chmod(path.join(bin,n),0o755)}
await fs.cp(path.join(root,'skills/chatgpt-pro-consult'),skill,{recursive:true});await fs.writeFile(path.join(skill,'.bridge-installed'),'codex-chatgpt-bridge\n');
await fs.mkdir(path.dirname(config),{recursive:true,mode:0o700});
const initial=structuredClone(defaults);if(args.includes('--enable-auto'))initial.trigger.mode='smart';
try{await fs.writeFile(config,JSON.stringify(initial,null,2)+'\n',{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e}
if(args.includes('--enable-auto')){
 const block=`${begin}\nAt the start of each new user task, run ~/.local/bin/chatgpt-pro-consult policy and apply ~/.codex/skills/chatgpt-pro-consult/SKILL.md. The user opted into consulting their ChatGPT web account according to this policy. Respect pause and manual mode; always means once per new task, not once per tool call. Only share focused relevant material, never credentials or unrelated data. Verify advice locally. Newer user restrictions take precedence.\n${end}`;
 if(previous&&!await read(agents+'.before-chatgpt-bridge'))await fs.writeFile(agents+'.before-chatgpt-bridge',previous,{mode:0o600});
 await fs.writeFile(agents,without+(without&&!without.endsWith('\n')?'\n':'')+block);
}
await fs.mkdir(path.dirname(desktop),{recursive:true});
// Desktop Exec quoting differs from shell quoting.
const quoted='"'+path.join(bin,'chatgpt-pro-manager').replace(/[\\"`$]/g,'\\$&').replace(/%/g,'%%')+'"';
await fs.writeFile(desktop,`[Desktop Entry]\nType=Application\nName=ChatGPT 咨询管理\nComment=codex-chatgpt-bridge local consultation manager\nExec=${quoted}\nIcon=applications-internet\nTerminal=false\nCategories=Development;\n`);
console.log('Installed: '+app+'\nRun: '+path.join(bin,'chatgpt-pro-manager')+'\nExisting settings are preserved. Restart Codex to discover the skill.');
