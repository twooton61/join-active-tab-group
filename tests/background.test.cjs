const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');

function setup(initialGroups, activeTabs = []) {
  const groups = new Map(initialGroups.map((group) => [group.id, { ...group }]));
  const storage = {};
  const joined = [];
  const event = () => {
    const listeners = [];
    return {
      addListener: (listener) => listeners.push(listener),
      emit: (...args) => Promise.all(listeners.map((listener) => listener(...args))),
    };
  };
  const chrome = {
    storage: { session: {
      get: async (key) => ({ [key]: storage[key] }),
      set: async (entries) => Object.assign(storage, entries),
      remove: async (key) => { delete storage[key]; },
    } },
    tabs: {
      onActivated: event(), onCreated: event(),
      query: async () => activeTabs,
      get: async (id) => {
        const tab = activeTabs.find((tab) => tab.id === id);
        if (!tab) throw new Error('Tab removed');
        return tab;
      },
      group: async (args) => { joined.push(JSON.parse(JSON.stringify(args))); },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      onUpdated: event(), onCreated: event(), onMoved: event(),
      get: async (id) => {
        if (!groups.has(id)) throw new Error('Group removed');
        return { ...groups.get(id) };
      },
      query: async (filter) => [...groups.values()]
        .filter((group) => Object.entries(filter).every(([key, value]) => group[key] === value))
        .map((group) => ({ ...group })),
      update: async (id, changes) => {
        const group = groups.get(id);
        Object.assign(group, changes);
        // Browser events are dispatched without waiting for listener promises.
        void chrome.tabGroups.onUpdated.emit({ ...group });
        return { ...group };
      },
    },
    runtime: { onInstalled: event(), onStartup: event() },
    windows: { onRemoved: event() },
  };
  const context = vm.createContext({ chrome });
  vm.runInContext(source, context);
  return {
    chrome, groups, joined,
    expanded: (windowId) => [...groups.values()]
      .filter((group) => group.windowId === windowId && !group.collapsed).map((group) => group.id),
  };
}

const group = (id, windowId = 1, collapsed = false) => ({ id, windowId, collapsed });

test('expanding a group collapses peers only in its own window', async () => {
  const app = setup([group(1), group(2), group(3, 2)]);
  await app.chrome.tabGroups.onUpdated.emit(group(2));
  assert.deepEqual(app.expanded(1), [2]);
  assert.deepEqual(app.expanded(2), [3]);
});

test('creating or moving an expanded group collapses its peers', async () => {
  for (const name of ['onCreated', 'onMoved']) {
    const app = setup([group(1), group(2)]);
    await app.chrome.tabGroups[name].emit(group(2));
    assert.deepEqual(app.expanded(1), [2]);
  }
});

test('rapid expansions keep the most recently expanded group', async () => {
  const app = setup([group(1), group(2), group(3)]);
  await Promise.all([
    app.chrome.tabGroups.onUpdated.emit(group(2)),
    app.chrome.tabGroups.onUpdated.emit(group(3)),
  ]);
  assert.deepEqual(app.expanded(1), [3]);
});

test('collapsed and removed groups do not collapse other groups', async () => {
  const app = setup([group(1), group(2, 1, true)]);
  await app.chrome.tabGroups.onUpdated.emit(group(2, 1, true));
  await app.chrome.tabGroups.onUpdated.emit(group(99));
  assert.deepEqual(app.expanded(1), [1]);
  app.groups.get(1).collapsed = true;
  await app.chrome.tabGroups.onUpdated.emit(group(1, 1, true));
  assert.deepEqual(app.expanded(1), []);
});

test('stale expansion events do not reopen a group that is now collapsed', async () => {
  const app = setup([group(1), group(2, 1, true)]);
  await app.chrome.tabGroups.onUpdated.emit(group(2));
  assert.deepEqual(app.expanded(1), [1]);
});

test('install and startup normalize windows, preferring the active tab group', async () => {
  for (const name of ['onInstalled', 'onStartup']) {
    const app = setup(
      [group(1), group(2), group(3, 2), group(4, 2), group(5, 3, true)],
      [{ id: 10, windowId: 1, groupId: 2 }, { id: 20, windowId: 2, groupId: -1 }],
    );
    await app.chrome.runtime[name].emit();
    assert.deepEqual(app.expanded(1), [2]);
    assert.deepEqual(app.expanded(2), [3]);
    assert.deepEqual(app.expanded(3), []);
  }
});

test('new tabs join the sole expanded group after switching groups', async () => {
  for (const url of ['chrome://newtab/', 'brave://newtab/', 'https://example.com', '']) {
    const app = setup([group(1), group(2)]);
    await app.chrome.tabGroups.onUpdated.emit(group(2));
    await app.chrome.tabs.onCreated.emit({ id: 10, windowId: 1, groupId: -1, url });
    assert.deepEqual(app.joined, [{ groupId: 2, tabIds: 10 }]);
  }
});

test('already grouped tabs and tabs in windows without an expanded group stay put', async () => {
  const app = setup([group(1), group(2, 2, true)]);
  await app.chrome.tabs.onCreated.emit({ id: 10, windowId: 1, groupId: 1 });
  await app.chrome.tabs.onCreated.emit({ id: 11, windowId: 2, groupId: -1 });
  assert.deepEqual(app.joined, []);
});
