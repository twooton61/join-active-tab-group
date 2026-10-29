const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');

function setup(initialGroups, activeTabs = [], { editFailures = 0, holdSettling = false } = {}) {
  const groups = new Map(initialGroups.map((group) => [group.id, { ...group }]));
  const tabs = new Map(activeTabs.map((tab) => [tab.id, { ...tab }]));
  const storage = {};
  const joined = [];
  const errors = [];
  const settling = [];
  const edit = () => {
    if (editFailures-- > 0) {
      throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
    }
  };
  const event = (before = () => {}) => {
    const listeners = [];
    return {
      addListener: (listener) => listeners.push(listener),
      emit: (...args) => {
        before(...args);
        return Promise.all(listeners.map((listener) => listener(...args)));
      },
    };
  };
  const chrome = {
    storage: { session: {
      get: async (key) => ({ [key]: storage[key] }),
      set: async (entries) => Object.assign(storage, entries),
      remove: async (key) => { delete storage[key]; },
    } },
    tabs: {
      onActivated: event(), onCreated: event((tab) => tabs.set(tab.id, { ...tab })),
      onUpdated: event((id, changes) => Object.assign(tabs.get(id), changes)),
      onRemoved: event((id) => tabs.delete(id)),
      query: async () => activeTabs,
      get: async (id) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('Tab removed');
        return tab;
      },
      group: async (args) => {
        edit();
        joined.push(JSON.parse(JSON.stringify(args)));
      },
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
        edit();
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
  const context = vm.createContext({
    chrome,
    setTimeout: (callback, delay) => {
      if (holdSettling && delay === 500) {
        settling.push(callback);
        return;
      }
      return setTimeout(callback, 0);
    },
    console: { error: (...args) => errors.push(args) },
  });
  vm.runInContext(source, context);
  return {
    chrome, groups, tabs, joined, errors, settling,
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

test('creating an expanded group collapses its peers', async () => {
  const app = setup([group(1), group(2)]);
  await app.chrome.tabGroups.onCreated.emit(group(2));
  assert.deepEqual(app.expanded(1), [2]);
});

test('group position changes leave expansion states alone', async () => {
  // Even if multiple groups are expanded, rearranging the tab strip does not
  // express an intent to switch groups.
  const app = setup([group(1), group(2), group(3, 1, true), group(4, 2)]);
  for (const moved of [group(2), group(3, 1, true), group(1)]) {
    await app.chrome.tabGroups.onMoved.emit(moved);
  }
  assert.deepEqual(app.expanded(1), [1, 2]);
  assert.deepEqual(app.expanded(2), [4]);
  assert.deepEqual(app.errors, []);
});

test('group movement cannot supersede an expansion waiting for a tab edit', async () => {
  const app = setup([group(1), group(2)], [], { editFailures: 1 });
  const expansion = app.chrome.tabGroups.onUpdated.emit(group(2));
  await new Promise(setImmediate);
  await app.chrome.tabGroups.onMoved.emit(group(1));
  await expansion;
  assert.deepEqual(app.expanded(1), [2]);
  assert.deepEqual(app.errors, []);
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

test('auto collapse retries while Brave temporarily blocks tab edits', async () => {
  const app = setup([group(1), group(2)], [], { editFailures: 2 });
  await app.chrome.tabGroups.onUpdated.emit(group(2));
  assert.deepEqual(app.expanded(1), [2]);
  assert.deepEqual(app.errors, []);
});

test('new tab grouping retries while Brave temporarily blocks tab edits', async () => {
  const app = setup([group(1)], [], { editFailures: 2 });
  await app.chrome.tabs.onCreated.emit({ id: 10, windowId: 1, groupId: -1 });
  assert.deepEqual(app.joined, [{ groupId: 1, tabIds: 10 }]);
  assert.deepEqual(app.errors, []);
});

test('exhausted retries report the error and let later events run', async () => {
  const app = setup([group(1), group(2)], [], { editFailures: 11 });
  await app.chrome.tabGroups.onUpdated.emit(group(2));
  assert.equal(app.errors.length, 1);
  await app.chrome.tabGroups.onUpdated.emit(group(2));
  assert.deepEqual(app.expanded(1), [2]);
});

test('a newer group expansion supersedes a retry waiting for the tab strip', async () => {
  const app = setup([group(1), group(2), group(3)], [], { editFailures: 1 });
  const first = app.chrome.tabGroups.onUpdated.emit(group(2));
  // Let the first edit fail and reach its retry timer.
  await new Promise(setImmediate);
  const second = app.chrome.tabGroups.onUpdated.emit(group(3));
  await Promise.all([first, second]);
  assert.deepEqual(app.expanded(1), [3]);
  assert.deepEqual(app.errors, []);
});

test('unrelated edit errors are reported once without blocking subsequent events', async () => {
  const app = setup([group(1)]);
  const original = app.chrome.tabs.group;
  let attempts = 0;
  app.chrome.tabs.group = async () => {
    attempts++;
    throw new Error('No group with id: 1.');
  };
  await app.chrome.tabs.onCreated.emit({ id: 10, windowId: 1, groupId: -1 });
  assert.equal(attempts, 1);
  assert.equal(app.errors.length, 1);
  app.chrome.tabs.group = original;
  await app.chrome.tabs.onCreated.emit({ id: 11, windowId: 1, groupId: -1 });
  assert.deepEqual(app.joined, [{ groupId: 1, tabIds: 11 }]);
});
