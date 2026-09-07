export async function connect(url) {
  const u = new URL(url);
  if (u.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.port !== '9222') throw Error('Unexpected debugger address');
  const ws = new WebSocket(u);
  const pending = new Map();
  let seq = 0;
  const fail = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Debugger disconnected')); } pending.clear(); };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error('Debugger connect timeout')); }, 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(Error('Debugger connect failed')); };
  });
  ws.onclose = fail;
  ws.onerror = fail;
  ws.onmessage = e => {
    const r = JSON.parse(e.data); const p = pending.get(r.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(r.id);
    r.error ? p.reject(Error(JSON.stringify(r.error))) : p.resolve(r.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 7000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    call,
    async evaluate(expression) {
      const r = await call('Runtime.evaluate', { expression, returnByValue: true });
      if (r.exceptionDetails) throw Error('Page evaluation failed');
      return r.result.value;
    },
    close() { fail(); ws.close(); }
  };
}
