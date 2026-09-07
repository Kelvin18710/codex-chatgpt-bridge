#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {loadConfig} from './config.mjs';
export const settings=await loadConfig();

const base = 'http://127.0.0.1:9222';
const stateDir = path.join(os.homedir(), '.local/state/codex-chatgpt-bridge');
const profile = path.join(os.homedir(), '.local/share/codex-chatgpt-edge');
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function get(endpoint, options = {}) {
  const r = await fetch(base + endpoint, { ...options, signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Read only UI state. Do not read cookies, account names, or conversation bodies.
export const inspectExpression = `(() => {
  const visible = e => !!e && e.getClientRects().length > 0;
  const buttons = [...document.querySelectorAll('button,[role="button"],a')].filter(visible);
  const login = buttons.some(e => /^(登录|登入|Log in|Sign in)$/i.test(e.innerText.trim()));
  const account = [...document.querySelectorAll('[data-testid="accounts-profile-button"]')].some(visible);
  const editor = document.querySelector('#prompt-textarea');
  const menus = [...document.querySelectorAll('main button[aria-haspopup="menu"],form button[aria-haspopup="menu"],header button[aria-haspopup="menu"]')].filter(visible);
  const normalize = s => s.replace(/\\s+/g, ' ').trim();
  const modelLabels = [...new Set(menus.filter(e=>e.classList.contains('__composer-pill') || /^(?:GPT[- ]?)?\\d/.test(e.innerText.trim())).map(e => normalize(e.innerText)).filter(s=>s && s.length < 80))];
  const correctModel = modelLabels.some(s => s.toLowerCase() === ${JSON.stringify(settings.model.label.toLowerCase())});
  const temporary = buttons.some(e => /^(临时聊天|Temporary Chat)$/i.test((e.innerText || e.getAttribute('aria-label') || '').trim()) && (e.getAttribute('aria-pressed') === 'true' || e.getAttribute('data-state') === 'on')) || new URL(location.href).searchParams.get('temporary-chat') === 'true';
  return {
    url: location.href,
    login: login ? 'required' : account && visible(editor) ? 'confirmed_by_ui' : 'unknown',
    accountMenuVisible: account, editorVisible: visible(editor), modelLabels, correctModel,
    generating: visible(document.querySelector('[data-testid="stop-button"]')),
    draftPresent: !!editor?.innerText.trim(), temporaryDetected: temporary
  };
})()`;

async function inspect(tab) {
  const u = new URL(tab.webSocketDebuggerUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.port !== '9222') throw new Error('Unexpected debugger address');
  const ws = new WebSocket(u);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Page inspection timed out')), 6000);
      const fail = e => { clearTimeout(timer); reject(e); };
      ws.onerror = () => fail(new Error('Debugger connection failed'));
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: inspectExpression, returnByValue: true } }));
      ws.onmessage = e => {
        const r = JSON.parse(e.data);
        if (r.id !== 1) return;
        clearTimeout(timer);
        if (r.error || r.result?.exceptionDetails) reject(new Error('Page inspection failed'));
        else resolve(r.result.result.value);
      };
    });
  } finally { ws.close(); }
}

export function classify(page) {
  if (page.login === 'required') return 'login_required';
  if (page.login !== 'confirmed_by_ui') return 'unknown';
  if (page.temporaryDetected) return 'temporary_chat';
  if (!page.correctModel) return page.modelLabels.length ? 'wrong_model' : 'model_unknown';
  if (page.generating) return 'busy';
  if (page.draftPresent) return 'draft_present';
  return 'ready';
}

export async function status() {
  let version;
  try { version = await get('/json/version'); }
  catch (e) {
    const refused = e.cause?.code === 'ECONNREFUSED';
    return { status: refused ? 'not_running' : 'connection_error', pages: [], detail: refused ? undefined : e.message };
  }
  if (!/^Edg\//.test(version.Browser || '')) return { status: 'port_conflict', pages: [] };
  let tabs;
  try { tabs=(await get('/json/list')).filter(t => t.type === 'page' && /^https:\/\/chatgpt\.com(?:\/|$)/.test(t.url)); }
  catch(e) { return {status:'connection_error',pages:[],detail:e.message}; }
  const pages = [];
  for (const tab of tabs) {
    try { const page = await inspect(tab); pages.push({ id: tab.id, ...page, status: classify(page) }); }
    catch (e) { pages.push({ id: tab.id, status: 'unknown', detail: e.message }); }
  }
  let selected;
  try { const preferred=JSON.parse(await fs.readFile(path.join(stateDir,'browser-target.json'),'utf8'));selected=pages.find(p=>p.id===preferred.id); } catch(e) { if(e.code!=='ENOENT') throw e; }
  selected ||= pages.length===1?pages[0]:undefined;
  return { browser: version.Browser, expectedModel:settings.model.label, selectedTabId:selected?.id, status: pages.length === 0 ? 'no_chatgpt_tab' : selected ? selected.status : 'multiple_tabs', pages };
}

const labels = {
  ready: `已就绪：页面已登录，模型为 ${settings.model.label}，输入框为空。`,
  not_running: '专用 Edge 未运行。请运行 chatgpt-pro-start。',
  connection_error: '调试端口连接异常；没有重复启动浏览器。',
  port_conflict: '9222 端口不是可识别的 Edge；请检查端口占用。',
  no_chatgpt_tab: 'Edge 已运行，但未发现 ChatGPT 页面。',
  login_required: '需要登录：请在专用 Edge 窗口完成 ChatGPT 登录。',
  unknown: '无法确认登录状态：可能仍在加载、需要验证，或页面结构已变化。',
  wrong_model: `模型不匹配：请在聊天模型菜单选择 ${settings.model.label}，或在管理页应用模型。`,
  model_unknown: '无法确认模型：请打开普通聊天并检查模型菜单。',
  temporary_chat: '检测到临时聊天：请关闭临时聊天，以便保留历史。',
  busy: '已登录且模型正确，但当前正在生成回答；请等待完成。',
  draft_present: '已登录且模型正确，但输入框有草稿；请先处理草稿。',
  multiple_tabs: '存在多个 ChatGPT 标签页；请只保留一个用于自动咨询的标签页。'
};

async function main() {
  const args = process.argv.slice(2);
  const command = args.find(a => !a.startsWith('--')) || 'status';
  if (!['start', 'status'].includes(command) || args.some(a => a.startsWith('--') && a !== '--json')) throw new Error('用法：bridge.mjs start|status [--json]');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  let s = await status();
  if (command === 'start') {
    for(let i=0;i<6&&s.status==='connection_error';i++){await sleep(300);s=await status()}
    if (s.status === 'not_running') {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error('请从 Linux 图形桌面的终端或桌面启动图标运行；当前没有桌面显示环境。');
      await fs.mkdir(profile, { recursive: true, mode: 0o700 });
      const log = await fs.open(path.join(stateDir, 'edge.log'), 'a', 0o600);
      try {
        const child = spawn('/usr/bin/microsoft-edge', [
          `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1',
          '--remote-debugging-port=9222', '--no-first-run', '--no-default-browser-check', 'https://chatgpt.com/'
        ], { detached: true, stdio: ['ignore', log.fd, log.fd] });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
      } finally { await log.close(); }
      for (let i = 0; i < 20; i++) { await sleep(500); s = await status(); if (s.status !== 'not_running') break; }
    }
    if (s.status === 'no_chatgpt_tab') { await get('/json/new?https://chatgpt.com/', { method: 'PUT' }); s = await status(); }
    for (let i = 0; i < 10 && ['unknown', 'model_unknown'].includes(s.status); i++) { await sleep(1000); s = await status(); }
  }
  const result = { checkedAt: new Date().toISOString(), ...s };
  await fs.writeFile(path.join(stateDir, 'last-status.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(labels[s.status] || s.status);
    for (const page of s.pages) {
      console.log(`  ${page.url || page.id}`);
      console.log(`  ${labels[page.status] || page.status}`);
      if (page.modelLabels?.length) console.log(`  页面模型：${page.modelLabels.join(', ')}`);
    }
    console.log('\n本次仅检查状态，没有发送消息。浏览器可以最小化。');
  }
  process.exitCode = s.status === 'ready' ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(`检查失败：${e.message}`); process.exitCode = 1; });
}
