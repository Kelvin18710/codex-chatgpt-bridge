#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { get, status, inspectExpression, classify, settings } from './bridge.mjs';
import { connect } from './cdp.mjs';
import {decide,configPath} from './config.mjs';
import {ensureModel} from './models.mjs';

const root = path.join(os.homedir(), '.local/state/codex-chatgpt-bridge');
const requests = path.join(root, 'requests');
const activePath = path.join(root, 'active.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const persistentUrl = url => /^https:\/\/chatgpt\.com\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url || '');
// contenteditable and rendered messages can expose paragraph breaks as two LF.
// Preserve indentation and all non-newline content while comparing UI text.
const normalize = s => s.replace(/\r/g, '').replace(/\n+/g, '\n').trim();
const safeId = s => { if (!s || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(s)) throw Error('id/task must be 1-80 letters, digits, underscore or hyphen'); return s; };
const recordPath = id => path.join(requests, safeId(id) + '.json');
async function read(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function atomic(file, data) { const tmp = file + '.tmp'; await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await fs.rename(tmp, file); }
async function save(r) {
  r.updatedAt = stamp();
  await atomic(recordPath(r.id), r);
  const md = `# Codex → ChatGPT 咨询 ${r.id}\n\n状态：${r.status}\n\n会话：${r.url || '尚未生成'}\n\n任务：${r.task}\n\n页面模型：${(r.modelAtSend || []).join(', ') || '尚未发送'}\n\n## 初始提示词\n\n${r.initialPrompt || '未附加'}\n\n## 问题\n\n${r.prompt}\n\n## 回答\n\n${r.answer || '尚未取得完整回答'}\n\n## 采纳与验证\n\n${r.assessment || '待 Codex 验证；不能将模型意见视为已证实结论。'}\n`;
  const mdPath = path.join(requests, r.id + '.md');
  await fs.writeFile(mdPath + '.tmp', md, { mode: 0o600 }); await fs.rename(mdPath + '.tmp', mdPath);
}
async function unlock(r) { const a = await read(activePath); if (a?.id === r.id) await fs.unlink(activePath); }
async function requireRecord(id) { const r = await read(recordPath(id)); if (!r) throw Error('Unknown request id'); return r; }
function output(r, extra = {}) {
  console.log(JSON.stringify({ ...r, recordFile: recordPath(r.id), markdownFile: path.join(requests, r.id + '.md'), ...extra }, null, 2));
}
async function tabs() { return (await get('/json/list')).filter(t => t.type === 'page' && /^https:\/\/chatgpt\.com(?:\/|$)/.test(t.url)); }
async function resolveTab(r) {
  const ts = await tabs();
  const exact = ts.find(t => t.id === r.tabId);
  if (exact && (!persistentUrl(r.url) || exact.url === r.url)) return exact;
  const matches = r.url ? ts.filter(t => t.url === r.url) : [];
  if (matches.length === 1) return matches[0];
  throw Error('Consultation tab is closed or navigated away; reopen the saved conversation URL and poll again. Do not resend.');
}
async function ready(c, destination, expectHistory = false) {
  let p;
  for (let i = 0; i < 40; i++) {
    p = await c.evaluate(snapshotExpression);
    if (p.url === destination && !['unknown', 'model_unknown'].includes(classify(p))) {
      if (classify(p) !== 'ready' || !expectHistory || p.messages.some(m => m.role === 'user')) return p;
    }
    await sleep(500);
  }
  return p;
}
const snapshotExpression = `(() => {
  const state = ${inspectExpression};
  return { ...state, messages: [...document.querySelectorAll('[data-message-author-role]')].map(e => {
    const turn = e.closest('[data-testid^="conversation-turn-"]') || e.closest('article');
    const content = e.querySelector('[data-testid="collapsible-user-message-content"]') || e;
    return { role: e.getAttribute('data-message-author-role'), text: content.innerText,
      finished: !!turn?.querySelector('[data-testid="copy-turn-action-button"]') };
  }) };
})()`;

async function pollOnce(r) {
  delete r.observation;
  const tab = await resolveTab(r); const c = await connect(tab.webSocketDebuggerUrl);
  try {
    const p = await c.evaluate(snapshotExpression);
    p.correctModel=p.modelLabels.includes(r.configSnapshot?.model.label || r.modelAtSend?.[0] || settings.model.label);
    if (p.login !== 'confirmed_by_ui' || !p.correctModel || p.temporaryDetected) {
      return { ...r, observation: `blocked: ${classify(p)}` };
    }
    const hits = p.messages.map((m, i) => m.role === 'user' && normalize(m.text) === normalize(r.wire) ? i : -1).filter(i => i >= 0);
    if (hits.length !== 1) return { ...r, observation: hits.length ? 'duplicate_message_detected' : 'message_not_visible_do_not_resend' };
    if (!persistentUrl(p.url)) return { ...r, observation: 'waiting_for_persistent_conversation_url' };
    r.url = p.url; r.tabId = tab.id; r.sentAt ||= stamp();
    const reply = p.messages[hits[0] + 1];
    if (reply?.role === 'assistant' && reply.text.trim() && reply.finished && !p.generating) {
      r.status = 'completed'; r.answer = reply.text; r.completedAt ||= stamp();
      r.modelAtRead = p.modelLabels; r.completionEvidence = 'assistant copy button present and no stop button';
      r.lastVerifiedAt = stamp(); await save(r); await unlock(r);
    } else { r.status = 'sent'; await save(r); }
    return r;
  } finally { c.close(); }
}

async function submit(opt, followup = false) {
  const id = safeId(opt.id);
  if (!opt.file) throw Error('--file is required');
  const prompt = (await fs.readFile(opt.file, 'utf8')).trim();
  if (!prompt || prompt.length > settings.limits.maxPromptChars) throw Error(`材料需为 1–${settings.limits.maxPromptChars} 字符`);
  let parent = followup ? await requireRecord(opt.parent) : null;
  if (parent && parent.status !== 'completed') throw Error('Parent must be completed before followup');
  const task = parent?.task || safeId(opt.task || id);
  const digest = createHash('sha256').update(JSON.stringify({ prompt, task, parent: parent?.id || null })).digest('hex');
  const existing = await read(recordPath(id));
  if (existing) {
    if (existing.digest !== digest) throw Error('Request id already exists with different content or task; nothing sent');
    output(existing, { reused: true, hint: 'Use poll; reusing an id never resends.' }); return;
  }
  if(!settings.enabled)throw Error('咨询已暂停，请先在管理页启用');
  if(opt.event){const decision=decide(settings,opt.event,Number(opt.attempts||0),0);if(!decision.shouldConsult)throw Error('触发规则未满足：'+decision.reason)}
  const active = await read(activePath);
  if (active) throw Error(`Browser reserved by ${active.id}; poll or explicitly release it first`);
  let count = 0;const completed=[];
  for (const f of await fs.readdir(requests)) {
    if (!f.endsWith('.json')) continue;
    const r = await read(path.join(requests, f));
    if (r.task === task && r.dispatchAttemptedAt) count++;
    if(r.status==='completed'&&r.url)completed.push(r);
  }
  if (count >= settings.limits.maxSendsPerTask) throw Error(`Task send limit reached (${settings.limits.maxSendsPerTask}); do not rename task to bypass the limit`);
  if(!parent&&settings.conversation.mode!=='always_new'){
    parent=completed.filter(r=>settings.conversation.mode==='reuse_recent'||r.task===task).sort((a,b)=>Date.parse(b.completedAt)-Date.parse(a.completedAt))[0]||null;
  }
  const s = await status();
  if (s.status !== 'ready' && !(s.status==='wrong_model'&&settings.model.autoSelect)) throw Error(`Browser not ready: ${s.status}`);
  const selected=s.pages.find(p=>p.id===s.selectedTabId);
  if(!selected||selected.generating||selected.draftPresent)throw Error('选定标签页正在使用中');
  let tab = (await tabs()).find(t => t.id === selected.id);
  const initialPrompt=(!parent||settings.prompt.placement==='every_message')?settings.prompt.text:'';
  const r = { id, task, taskName:opt['task-name'] || (followup?parent?.taskName:null) || task, parent: parent?.id || null, digest, prompt, initialPrompt, configSnapshot:settings, wire: `[Codex 咨询编号：${id}]\n${initialPrompt?initialPrompt+'\n\n':''}${prompt}`, status: 'preparing', createdAt: stamp(), tabId: tab.id };
  await save(r); await atomic(activePath, { id, createdAt: r.createdAt });
  if(!parent&&settings.conversation.openInNewTab){tab=await get('/json/new?https://chatgpt.com/',{method:'PUT'});r.tabId=tab.id;await save(r)}
  await atomic(path.join(root,'browser-target.json'),{id:tab.id});
  const c = await connect(tab.webSocketDebuggerUrl);
  try {
    // Reuse the dedicated tab; old conversations remain in ChatGPT history.
    const destination = parent?.url || 'https://chatgpt.com/';
    if (tab.url !== destination) {
      const nav = await c.call('Page.navigate', { url: destination });
      if (nav.errorText) throw Error(nav.errorText);
      await sleep(1000);
    }
    let p = await ready(c, destination, !!parent);
    if(p.login==='confirmed_by_ui'&&!p.correctModel){await ensureModel(c,settings.model);p=await ready(c,destination,!!parent)}
    if (p.url !== destination || classify(p) !== 'ready') throw Error(`Destination not ready: ${classify(p)}`);
    const history = await c.evaluate(snapshotExpression);
    const lastUser = history.messages.filter(m => m.role === 'user').at(-1);
    if (parent ? normalize(lastUser?.text || '') !== normalize(parent.wire) : history.messages.length !== 0) throw Error('Conversation changed; refusing to mix with another discussion');
    const focused = await c.evaluate(`(() => { const e=document.querySelector('#prompt-textarea'); if(!e || e.innerText.trim()) return false; e.focus(); return document.activeElement===e; })()`);
    if (!focused) throw Error('Editor is missing, busy, or contains a draft');
    await c.call('Input.insertText', { text: r.wire });
    r.status = 'filled'; await save(r);
    const actual = await c.evaluate(`document.querySelector('#prompt-textarea')?.innerText || ''`);
    p = await c.evaluate(inspectExpression);
    if (normalize(actual) !== normalize(r.wire) || p.login !== 'confirmed_by_ui' || !p.correctModel || p.generating || p.temporaryDetected) throw Error('Pre-send content/model check failed; nothing clicked');
    r.status = 'dispatching'; r.dispatchAttemptedAt = stamp(); r.modelAtSend = p.modelLabels;
    await save(r); // Persist BEFORE click: crash recovery must never blindly resend.
    const sent = await c.evaluate(`(() => { const e=document.querySelector('[data-testid="send-button"]'); if(!e || e.disabled) return false; e.click(); return true; })()`);
    if (!sent) throw Error('Send button unavailable; inspect page before recovery');
    r.status = 'sent'; r.sentAt = stamp(); await save(r);
    // The conversation URL can appear shortly after the click.
    for (let i = 0; i < 8; i++) {
      const url = await c.evaluate('location.href');
      if (persistentUrl(url)) { r.url = url; break; }
      await sleep(250);
    }
    await save(r); output(r);
  } catch (e) {
    r.lastError = e.message; await save(r);
    if(['sent','dispatching'].includes(r.status)){
      output(r,{observation:r.status==='sent'?'sent_confirmation_pending':'send_outcome_unknown',hint:'发送结果需通过原编号继续确认，不要重新发送。'});return;
    }
    throw Error(`${e.message}; request=${id}, status=${r.status}. Use poll; do not resend under a new id.`);
  } finally { c.close(); }
}

async function main() {
  const [command, ...args] = process.argv.slice(2); const opt = {};
  const allowed = { ask: ['id','file','task','task-name','event','attempts'], followup: ['id','file','parent'], poll: ['id','wait','refresh'], release: ['id'], assess: ['id','file'], status: [],policy:[],decision:['task','event','attempts'] };
  if (!Object.hasOwn(allowed,command)) throw Error('Commands: status, policy, decision, ask, followup, poll, assess, release');
  for (let i = 0; i < args.length; i++) {
    const k = args[i].slice(2);
    if (!args[i].startsWith('--') || !allowed[command].includes(k) || k in opt) throw Error(`Invalid option: ${args[i]}`);
    opt[k] = k === 'refresh' ? true : args[++i];
    if (opt[k] === undefined) throw Error(`Missing option value: ${k}`);
  }
  await fs.mkdir(requests, { recursive: true, mode: 0o700 });
  if(command==='policy'){console.log(JSON.stringify({config:settings,configPath},null,2));return}
  if(command==='decision'){
    if(!['request','explicit','failure','architecture','conflict'].includes(opt.event))throw Error('Unknown decision event');
    safeId(opt.task);let count=0;
    for(const f of await fs.readdir(requests)){if(!f.endsWith('.json'))continue;const r=await read(path.join(requests,f));if(r.task===opt.task&&r.dispatchAttemptedAt)count++}
    console.log(JSON.stringify({...decide(settings,opt.event,Number(opt.attempts||0),count),mode:settings.trigger.mode,sends:count,limits:settings.limits}));return;
  }
  if (command === 'status') { console.log(JSON.stringify({ ...await status(), active: await read(activePath) }, null, 2)); return; }
  if (command === 'ask' || command === 'followup') return submit(opt, command === 'followup');
  let r = await requireRecord(opt.id);
  if (command === 'assess') {
    if (r.status !== 'completed') throw Error('Cannot assess an incomplete answer');
    r.assessment = (await fs.readFile(opt.file, 'utf8')).trim(); await save(r); output(r); return;
  }
  if (command === 'release') {
    const s = await status();
    if (s.pages.some(p => p.generating)) throw Error('A response is still generating; wait or stop it in the browser first');
    if (r.status !== 'completed') { r.status = 'abandoned'; r.abandonedAt = stamp(); await save(r); }
    await unlock(r); output(r); return;
  }
  const wait = Number(opt.wait || 0);
  if (!Number.isFinite(wait) || wait < 0 || wait > 40) throw Error('--wait must be 0..40 seconds');
  if (r.status === 'completed' && !opt.refresh || r.status === 'abandoned') { output(r, { cached: true }); return; }
  const deadline = Date.now() + wait * 1000;
  do {
    r = await pollOnce(r);
    if (r.status === 'completed' && !r.observation) break;
    if (['blocked: login_required', 'blocked: wrong_model', 'blocked: temporary_chat', 'duplicate_message_detected'].includes(r.observation) || Date.now() >= deadline) break;
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
  } while (true);
  const minutes=r.configSnapshot?.limits.waitMinutes||settings.limits.waitMinutes;
  const overdue = r.status !== 'completed' && Date.now() - Date.parse(r.sentAt || r.createdAt) > minutes * 60000;
  output(r, { waitBudgetExceeded: overdue, ...(overdue ? { hint: `${minutes}-minute budget exceeded. Do not resend; report pending status and conversation URL.` } : {}) });
}
main().catch(e => { console.error(JSON.stringify({ error: e.message })); process.exitCode = 1; });
