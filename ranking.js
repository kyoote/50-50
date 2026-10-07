(() => {
  'use strict';
  const ENDPOINT = ''; // Apps Script の公開 URL（末尾 /exec）
  const $ = id => document.getElementById(id);
  const labels = {japan: '日本', world: '世界', random: 'ランダム'};
  let mode = 'random', finished = null, bridge = null, ready = false, serial = 0, version = 0;
  const pending = new Map(), channel = crypto.randomUUID();
  let remote = null, remoteOrigin = '';
  let token = '';
  try {
    token = localStorage.getItem('5050-player') || crypto.randomUUID();
    localStorage.setItem('5050-player', token);
    $('ranking-name').value = localStorage.getItem('5050-name') || '';
  } catch (_) {}
  function request(action, data) {
    return new Promise((resolve, reject) => {
      if (!ready) return reject(new Error('接続できません。少し待ってから更新してください。'));
      const id = ++serial;
      const timer = setTimeout(() => {pending.delete(id); reject(new Error('通信がタイムアウトしました。もう一度お試しください。'));}, 20000);
      pending.set(id, {resolve, reject, timer});
      remote.postMessage({channel, id, action, data}, remoteOrigin);
    });
  }
  async function refresh() {
    const current = ++version;
    $('ranking-mode').textContent = labels[mode];
    $('ranking-list').replaceChildren();
    if (!ENDPOINT) { $('ranking-status').textContent = 'ランキングは準備中です'; return; }
    $('ranking-status').textContent = '読み込み中…';
    try {
      const rows = await request('list', {mode});
      if (current !== version) return;
      if (!Array.isArray(rows)) throw new Error('ランキングを読み込めませんでした。');
      $('ranking-status').textContent = rows.length ? '' : 'まだ記録がありません';
      rows.slice(0, 10).forEach((row, index) => {
        const li = document.createElement('li');
        for (const [tag, cls, text] of [['span', 'rank-place', index + 1], ['span', 'rank-name', row.name], ['strong', '', Number(row.score).toLocaleString('ja-JP')]]) {
          const el = document.createElement(tag); el.className = cls; el.textContent = text; li.append(el);
        }
        $('ranking-list').append(li);
      });
    } catch (error) { if (current === version) $('ranking-status').textContent = error.message; }
  }
  window.addEventListener('message', event => {
    if (!bridge || !/^https:\/\/(?:[a-z0-9-]+-)?script\.googleusercontent\.com$/.test(event.origin)) return;
    const data = event.data;
    if (!data || data.channel !== channel) return;
    if (data.ready && !ready) { remote = event.source; remoteOrigin = event.origin; ready = true; refresh(); return; }
    if (event.source !== remote) return;
    const item = pending.get(data.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    data.error ? item.reject(new Error(data.error)) : item.resolve(data.result);
  });
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {mode = button.dataset.mode; refresh();}));
  $('ranking-refresh').addEventListener('click', refresh);
  window.addEventListener('game-finished', event => {
    finished = {...event.detail};
    $('ranking-submit').disabled = !ENDPOINT || !token;
    $('ranking-save-status').textContent = !ENDPOINT ? 'ランキングは準備中です' : !token ? '登録にはブラウザーの保存機能を有効にしてください' : '';
  });
  $('ranking-form').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('ranking-name').value.trim();
    if (!finished || !name || !token) return;
    const record = {...finished};
    $('ranking-submit').disabled = true;
    $('ranking-save-status').textContent = '登録中…';
    try {
      await request('save', {...record, name, token});
      try {localStorage.setItem('5050-name', name);} catch (_) {}
      $('ranking-save-status').textContent = '自己ベストを登録しました';
      refresh();
    } catch (error) { $('ranking-save-status').textContent = error.message; }
    finally { $('ranking-submit').disabled = !ENDPOINT; }
  });
  $('ranking-refresh').disabled = !ENDPOINT;
  $('ranking-submit').disabled = true;
  refresh();
  if (ENDPOINT) {
    bridge = document.createElement('iframe'); bridge.hidden = true; bridge.title = 'ランキング接続'; bridge.src = ENDPOINT + '?channel=' + encodeURIComponent(channel);
    document.body.append(bridge);
    setTimeout(() => {if (!ready) $('ranking-status').textContent = '接続できませんでした。ページを再読み込みしてください。';}, 20000);
  }
})();
