const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../service-worker.js'), 'utf8');

function setup({ native = true, firefox = false, timeout = 12000 } = {}) {
  const data = {};
  const mutations = [];
  let tabs = [
    { id: 1, index: 0, windowId: 7, groupId: -1, title: 'Google 文档', url: 'https://docs.google.com/document/d/1' },
    { id: 2, index: 1, windowId: 7, groupId: -1, title: 'API docs', url: 'https://github.com/test/repo' },
    { id: 3, index: 2, windowId: 7, groupId: -1, title: '固定', url: 'https://example.com', pinned: true }
  ];
  let listener;
  const storage = {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])); },
    async set(value) { Object.assign(data, structuredClone(value)); },
    async remove(key) { delete data[key]; }
  };
  const api = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: storage, session: storage },
    tabs: {
      async query(query) { assert.deepEqual(JSON.parse(JSON.stringify(query)), { windowId: 7 }); return structuredClone(tabs); },
      async move(id, options) { mutations.push(['move', id, options]); },
      ...(native ? {
        async group(options) { mutations.push(['group', options]); return options.groupId ?? 10; },
        async ungroup(ids) { mutations.push(['ungroup', ids]); }
      } : {})
    },
    ...(native ? { tabGroups: {
      async query() { return [{ id: 99, title: '🗂️ 网页资料' }]; },
      async update(id, options) { mutations.push(['update', id, options]); }
    } } : {})
  };
  const context = vm.createContext({ [firefox ? 'browser' : 'chrome']: api, URL, AbortController, setTimeout, clearTimeout, console, fetch: async () => { throw new Error('Unexpected network'); } });
  vm.runInContext(source.replace('const MODEL_TIMEOUT_MS = 12000;', `const MODEL_TIMEOUT_MS = ${timeout};`), context);
  return {
    context, mutations, data, tabs,
    async send(type, extra = {}) {
      const message = { type, payload: { windowId: 7, ...extra } };
      if (firefox) return listener(message);
      return new Promise(resolve => listener(message, {}, resolve));
    },
    run(code) { return vm.runInContext(code, context); }
  };
}

test('local classification handles specific services and avoids URL substring false positives', () => {
  const h = setup();
  for (const [url, title, expected] of [
    ['https://docs.google.com/document/d/1', 'API 文档', '文档资料'],
    ['https://mail.google.com', '收件箱', '谷歌工具'],
    ['https://google.com/search?q=github', '搜索', '搜索资料'],
    ['https://youtube.com/watch?v=github-api', '开发', '视频内容'],
    ['https://linux.do/t/123', 'API docs', '技术社区'],
    ['https://chatgpt.com/c/123', '聊天', 'AI 工具'],
    ['https://example.com/report/12:34', '报告', '网页资料'],
    ['http://localhost:3000', '预览', '本地开发'],
    ['http://192.168.1.10:8080', 'NAS', '本地开发'],
    ['https://example.com/searching', '报告', '网页资料']
  ]) {
    assert.equal(h.run(`inferChineseTopic(${JSON.stringify({ url, title })})`), expected, url);
  }
});

test('malformed model groups are ignored; missing tabs remain covered', () => {
  const h = setup();
  const result = h.run('coerceUsefulGroups(normalizeGroups([null, {title:"开发",tabIds:"oops"}, {title:"开发",tabIds:[1,1,999]}, {title:"文档",tabIds:[1,2]}], [{id:1},{id:2},{id:3}]), [{id:1},{id:2},{id:3}])');
  assert.deepEqual(JSON.parse(JSON.stringify(result.flatMap(group => group.tabIds))), [1, 2, 3]);
  assert.equal(h.run('normalizeGroups({}, [{id:1}]).length'), 0);
});

test('generic existing group does not absorb unrelated topics, emoji-only group is skipped', () => {
  const h = setup();
  assert.equal(h.run('findMatchingExistingGroup({url:"https://github.com/a",title:"代码"},new Map([[1,{id:1,title:"🗂️ 网页资料"}],[2,{id:2,title:"🗂️"}]]))'), null);
});

for (const firefox of [false, true]) {
  test(`${firefox ? 'Firefox' : 'Chrome'} preview makes no mutations, applies once, stores result`, async () => {
    const h = setup({ firefox });
    const preview = await h.send('PREVIEW_TABS');
    assert.equal(preview.ok, true);
    assert.equal(preview.preview, true);
    assert.equal(preview.groups.length, 2);
    assert.equal(h.mutations.length, 0);
    h.context.fetch = () => { throw new Error('Preview must not call model again'); };
    const applied = await h.send('APPLY_PREVIEW', { useAi: true, apiKey: 'test' });
    assert.equal(applied.ok, true);
    assert.equal(applied.groups.reduce((sum, group) => sum + group.count, 0), 2);
    assert.ok(h.data['lastResult:7'].savedAt);
    assert.ok(!h.data['preview:7']);
    const count = h.mutations.length;
    assert.equal((await h.send('APPLY_PREVIEW')).ok, false);
    assert.equal(h.mutations.length, count);
  });
}

test('changed and expired previews reject before any mutation', async () => {
  const h = setup();
  await h.send('PREVIEW_TABS');
  h.tabs[0].groupId = 22;
  assert.match((await h.send('APPLY_PREVIEW')).error, /已变化/);
  assert.equal(h.mutations.length, 0);
  h.tabs[0].groupId = -1;
  h.data['preview:7'].createdAt -= 6 * 60 * 1000;
  assert.match((await h.send('APPLY_PREVIEW')).error, /过期/);
});

test('all mode preview does not ungroup until applied; pinned tabs excluded', async () => {
  const h = setup();
  h.tabs[0].groupId = 99;
  await h.send('PREVIEW_TABS', { organizeMode: 'all' });
  assert.equal(h.mutations.length, 0);
  await h.send('APPLY_PREVIEW', { organizeMode: 'all' });
  assert.equal(h.mutations[0][0], 'ungroup');
  const ids = h.mutations.filter(m => m[0] === 'group').flatMap(m => m[1].tabIds);
  assert.deepEqual(ids, [1, 2]);
});

test('Vivaldi uses moves and preserves tabs without groupId', async () => {
  const h = setup({ native: false });
  for (const tab of h.tabs) delete tab.groupId;
  const preview = await h.send('PREVIEW_TABS');
  assert.equal(preview.source, 'vivaldi');
  assert.equal(h.mutations.length, 0);
  const applied = await h.send('APPLY_PREVIEW');
  assert.equal(applied.source, 'vivaldi');
  assert.deepEqual(h.mutations.map(m => m[1]), [1, 2]);
});

test('missing groupId on native browser remains eligible', async () => {
  const h = setup();
  for (const tab of h.tabs) delete tab.groupId;
  assert.equal((await h.send('PREVIEW_TABS')).groups.length, 2);
});

test('concurrent requests are rejected per window; lock releases after completion', async () => {
  const h = setup();
  let release;
  h.context.fetch = () => new Promise(resolve => { release = () => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"groups":[]}' } }] }) }); });
  const first = h.send('PREVIEW_TABS', { useAi: true, apiKey: 'test' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match((await h.send('ORGANIZE_TABS')).error, /正在整理/);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await h.send('PREVIEW_TABS')).ok, true);
});

test('slow response body is aborted and falls back to local groups', async () => {
  const h = setup({ timeout: 40 });
  h.context.fetch = async (_url, { signal }) => ({ ok: true, status: 200,
    text: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' })))) });
  const result = await h.send('PREVIEW_TABS', { useAi: true, apiKey: 'test' });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'local');
  assert.match(result.warning, /超过/);
});

test('JSON format retry shares the original time budget', async () => {
  const h = setup({ timeout: 80 });
  let calls = 0;
  h.context.fetch = async (_url, { signal }) => {
    calls++;
    if (calls === 1) {
      await new Promise(resolve => setTimeout(resolve, 45));
      return { ok: false, status: 400, text: async () => 'unsupported format' };
    }
    return { ok: true, status: 200, text: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' })))) };
  };
  const started = Date.now();
  const result = await h.send('PREVIEW_TABS', { useAi: true, apiKey: 'test' });
  assert.equal(calls, 2);
  assert.equal(result.source, 'local');
  assert.ok(Date.now() - started < 125);
});

test('tabs changed during model generation stop direct organize before mutation', async () => {
  const h = setup();
  h.context.fetch = async () => {
    h.tabs[0].pinned = true;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"groups":[{"title":"文档","tabIds":[1,2]}]}' } }] }) };
  };
  const result = await h.send('ORGANIZE_TABS', { useAi: true, apiKey: 'test' });
  assert.equal(result.ok, false);
  assert.match(result.error, /已变化/);
  assert.equal(h.mutations.length, 0);
});
