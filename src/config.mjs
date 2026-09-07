import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
export const configPath=process.env.CHATGPT_BRIDGE_CONFIG || path.join(os.homedir(),'.config/codex-chatgpt-bridge/config.json');
export const defaults={version:1,enabled:true,model:{label:'6 Pro',family:'最新',effort:4,autoSelect:true},trigger:{mode:'manual',failedAttempts:2,architecture:true,conflictingEvidence:true},conversation:{mode:'per_task',openInNewTab:false},limits:{maxSendsPerTask:2,waitMinutes:15,maxPromptChars:50000},prompt:{placement:'new_chat',text:'你是 Codex 的独立技术顾问。请依据提供的代码、证据和约束提出建议，区分已知事实、推断与未知；优先指出反例、遗漏和可验证的下一步。不要假设你能访问本地仓库，也不要把建议描述为已验证结论。请用清晰的中文回答。'}};
export function validate(c){
 const fail=m=>{throw Error('配置无效：'+m)};
 if(!c||typeof c!=='object'||Array.isArray(c))fail('需要对象');
 const keys=(o,expected)=>{if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).sort().join()!=[...expected].sort().join())fail('字段缺失或存在未知字段')};
 keys(c,Object.keys(defaults)); if(c.version!==1)fail('版本不支持');
 const bool=(v,n)=>{if(typeof v!=='boolean')fail(n)};
 const int=(v,a,b,n)=>{if(!Number.isInteger(v)||v<a||v>b)fail(`${n}需为 ${a}–${b} 的整数`)};
 bool(c.enabled,'启用开关');
 for(const k of ['model','trigger','conversation','limits','prompt'])keys(c[k],Object.keys(defaults[k]));
 for(const k of ['label','family'])if(typeof c.model[k]!=='string'||!c.model[k].trim()||c.model[k].length>80)fail('模型名称');
 int(c.model.effort,0,10,'推理档位');bool(c.model.autoSelect,'自动选择模型');
 if(!['smart','always','manual'].includes(c.trigger.mode))fail('触发方式');
 int(c.trigger.failedAttempts,1,10,'失败尝试次数');bool(c.trigger.architecture,'架构判断');bool(c.trigger.conflictingEvidence,'证据冲突');
 if(!['per_task','always_new','reuse_recent'].includes(c.conversation.mode))fail('会话方式');bool(c.conversation.openInNewTab,'新标签页');
 int(c.limits.maxSendsPerTask,1,20,'每任务次数');int(c.limits.waitMinutes,1,60,'等待分钟');int(c.limits.maxPromptChars,1000,100000,'材料字符上限');
 if(!['new_chat','every_message'].includes(c.prompt.placement))fail('提示词插入方式');
 if(typeof c.prompt.text!=='string'||c.prompt.text.length>12000)fail('提示词需不超过 12000 字符');
 return structuredClone(c);
}
export const revision=c=>createHash('sha256').update(JSON.stringify(c)).digest('hex');
export async function loadConfig(){try{return validate(JSON.parse(await fs.readFile(configPath,'utf8')))}catch(e){if(e.code==='ENOENT')return structuredClone(defaults);throw e}}
export async function saveConfig(c,expected){
 c=validate(c);const current=await loadConfig();if(expected&&expected!==revision(current)){const e=Error('配置已在其他页面更新，请重新加载后再保存');e.statusCode=409;throw e}
 await fs.mkdir(path.dirname(configPath),{recursive:true,mode:0o700});
 await fs.writeFile(configPath+'.bak',JSON.stringify(current,null,2)+'\n',{mode:0o600});
 const tmp=configPath+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(c,null,2)+'\n',{mode:0o600});await fs.rename(tmp,configPath);return c;
}
export function decide(c,event,attempts=0,alreadySent=0){
 if(!c.enabled)return {shouldConsult:false,reason:'咨询已暂停'};
 if(alreadySent>=c.limits.maxSendsPerTask)return {shouldConsult:false,reason:'本任务已达到咨询次数上限'};
 if(event==='explicit')return {shouldConsult:true,reason:'用户明确要求咨询'};
 if(c.trigger.mode==='manual')return {shouldConsult:false,reason:'仅在明确要求时咨询'};
 if(c.trigger.mode==='always')return {shouldConsult:alreadySent===0,reason:alreadySent?'本任务已经咨询过':'每个新任务首次处理时咨询'};
 const yes=event==='failure'&&attempts>=c.trigger.failedAttempts||event==='architecture'&&c.trigger.architecture||event==='conflict'&&c.trigger.conflictingEvidence;
 return {shouldConsult:!!yes,reason:yes?'符合已启用的智能触发条件':'未达到智能触发条件'};
}
