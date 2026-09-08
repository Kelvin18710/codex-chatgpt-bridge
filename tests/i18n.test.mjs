import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {messages, translate} from '../src/web/i18n.js';
test('English catalog covers shipped Chinese text and accessibility attributes',async()=>{
 const html=await fs.readFile(new URL('../src/web/index.html',import.meta.url),'utf8');
 const texts=[...html.matchAll(/>([^<>]+)</g)].map(m=>m[1].trim());
 texts.push(...[...html.matchAll(/(?:placeholder|aria-label|title)="([^"]+)"/g)].map(m=>m[1]));
 const missing=texts.filter(s=>/[\u4e00-\u9fff]/.test(s)&&s!=='中文'&&!Object.hasOwn(messages,s));assert.deepEqual(missing,[]);
});
test('dynamic UI strings have translations',async()=>{
 const js=await fs.readFile(new URL('../src/web/app.js',import.meta.url),'utf8');
 for(const m of js.matchAll(/\bt\('([^']+)'/g))assert.ok(Object.hasOwn(messages,m[1]),m[1]);
});
test('interpolation and round trip keep values intact',()=>{
 assert.equal(translate('en','{count} 条 / {minutes} 分钟',{count:3,minutes:20}),'3 messages / 20 min');
 assert.equal(translate('zh-CN','Save settings'),'保存设置');
 assert.equal(translate('en','网页：{model} · {login}{active}',{model:'用户模型',login:'Signed in',active:''}),'ChatGPT: 用户模型 · Signed in');
 assert.equal(translate('en','Unrecognized literal'),'Unrecognized literal');
});
