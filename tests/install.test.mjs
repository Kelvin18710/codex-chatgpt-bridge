import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const run=(home,...args)=>execFileSync(process.execPath,[path.join(root,'scripts/install.mjs'),'--home',home,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
test('install/upgrade/uninstall in a path with spaces preserves user data and AGENTS',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bridge install '));
 try{
 const agents=path.join(home,'.codex/AGENTS.md');await fs.mkdir(path.dirname(agents),{recursive:true});await fs.writeFile(agents,'# Personal rules\nKeep my work.\n');
 run(home);const config=path.join(home,'.config/codex-chatgpt-bridge/config.json');let c=JSON.parse(await fs.readFile(config));assert.equal(c.trigger.mode,'manual');assert.equal(await fs.readFile(agents,'utf8'),'# Personal rules\nKeep my work.\n');
 c.limits.maxSendsPerTask=7;await fs.writeFile(config,JSON.stringify(c));run(home,'--enable-auto');run(home,'--enable-auto');assert.equal((await fs.readFile(agents,'utf8')).split('<!-- codex-chatgpt-bridge:start -->').length,2);assert.equal(JSON.parse(await fs.readFile(config)).limits.maxSendsPerTask,7);
 const app=path.join(home,'.local/share/codex-chatgpt-bridge');const output=execFileSync(process.execPath,[path.join(app,'consult.mjs'),'policy'],{encoding:'utf8',env:{...process.env,CHATGPT_BRIDGE_CONFIG:config}});assert.equal(JSON.parse(output).config.limits.maxSendsPerTask,7);
 run(home,'--uninstall');assert.deepEqual(JSON.parse(await fs.readFile(config)),c);assert.equal(await fs.readFile(agents,'utf8'),'# Personal rules\nKeep my work.\n');await assert.rejects(fs.stat(app),{code:'ENOENT'});
 }finally{await fs.rm(home,{recursive:true,force:true})}
});
test('opt-in fresh install enables smart mode',async()=>{const home=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-auto-'));try{run(home,'--enable-auto');assert.equal(JSON.parse(await fs.readFile(path.join(home,'.config/codex-chatgpt-bridge/config.json'))).trigger.mode,'smart')}finally{await fs.rm(home,{recursive:true,force:true})}});
test('unmanaged application and unrelated launchers are not overwritten',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-collision-'));
 try{
 const app=path.join(home,'.local/share/codex-chatgpt-bridge');await fs.mkdir(app,{recursive:true});const file=path.join(app,'bridge.mjs');await fs.writeFile(file,'personal version');assert.throws(()=>run(home));assert.equal(await fs.readFile(file,'utf8'),'personal version');await fs.rm(app,{recursive:true});
 const bin=path.join(home,'.local/bin');await fs.mkdir(bin,{recursive:true});await fs.writeFile(path.join(bin,'chatgpt-pro-start'),'personal script');assert.throws(()=>run(home));assert.equal(await fs.readFile(path.join(bin,'chatgpt-pro-start'),'utf8'),'personal script');
 }finally{await fs.rm(home,{recursive:true,force:true})}
});
