const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');

function setup(initialGroups, activeTabs = []) {
  const groups = new Map(initialGroups.map((group) => [group.id, { ...group }]));
  const tabs = new Map(activeTabs.map((tab, index) => [tab.id, {
    active: true, pinned: false, index, groupId: -1, ...tab,
  }]));
  const storage = {};
  const joined = [];
  const moved = [];
  const retries = [];
  const event = (beforeEmit = () => {}) => {
    const listeners = [];
    return {
      addListener: (listener) => listeners.push(listener),
      emit: (...args) => {
        beforeEmit(...args);
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
      onActivated: event(({ tabId, windowId }) => {
        for (const tab of tabs.values()) {
          if (tab.windowId === windowId) tab.active = tab.id === tabId;
        }
      }),
      onCreated: event((tab) => {
        tabs.set(tab.id, { active: false, pinned: false, index: tabs.size, ...tab });
      }),
      onMoved: event(), onAttached: event(), onUpdated: event(),
      query: async (filter) => [...tabs.values()]
        .filter((tab) => Object.entries(filter).every(([key, value]) => tab[key] === value))
        .map((tab) => ({ ...tab })),
      get: async (id) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('Tab removed');
        return tab;
      },
      group: async (args) => {
        joined.push(JSON.parse(JSON.stringify(args)));
        tabs.get(args.tabIds).groupId = args.groupId;
      },
      move: async (id, { index }) => {
        const tab = tabs.get(id);
        const fromIndex = tab.index;
        for (const other of tabs.values()) {
          if (other.windowId !== tab.windowId || other.id === id) continue;
          if (other.index > fromIndex && other.index <= index) other.index--;
          if (other.index < fromIndex && other.index >= index) other.index++;
        }
        tab.index = index;
        moved.push({ id, index });
        void chrome.tabs.onMoved.emit(id, { windowId: tab.windowId, fromIndex, toIndex: index });
        return { ...tab };
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
  const context = vm.createContext({ chrome, setTimeout: (retry) => retries.push(retry) });
  vm.runInContext(source, context);
  return {
    chrome, groups, tabs, storage, joined, moved, retries,
    flush: () => vm.runInContext('serially(() => {})', context),
    order: (windowId = 1) => [...tabs.values()]
      .filter((tab) => tab.windowId === windowId)
      .sort((a, b) => a.index - b.index).map((tab) => tab.id),
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

const tab = (id, index, changes = {}) => ({
  id, index, windowId: 1, groupId: -1, active: false, pinned: false, ...changes,
});

test('switching tabs moves the active tab last within its own group', async () => {
  const app = setup([group(1), group(2)], [
    tab(10, 0, { groupId: 1 }), tab(11, 1, { groupId: 1 }),
    tab(12, 2, { groupId: 1 }), tab(20, 3, { groupId: 2 }),
    tab(30, 0, { windowId: 2, groupId: 1 }),
  ]);
  await app.chrome.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
  await app.flush();
  assert.deepEqual(app.order(), [11, 12, 10, 20]);
  assert.deepEqual(app.order(2), [30]);
  assert.equal(app.tabs.get(10).groupId, 1);
  assert.deepEqual(app.moved, [{ id: 10, index: 2 }]);
});

test('ungrouped active tabs move to the end of their window', async () => {
  const app = setup([group(1)], [
    tab(10, 0), tab(11, 1, { groupId: 1 }), tab(12, 2, { groupId: 1 }),
  ]);
  await app.chrome.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
  assert.deepEqual(app.order(), [11, 12, 10]);
  assert.equal(app.tabs.get(10).groupId, -1);
});

test('pinned active tabs stay pinned and move to the end of the pinned section', async () => {
  const app = setup([], [
    tab(10, 0, { pinned: true }), tab(11, 1, { pinned: true }), tab(12, 2),
  ]);
  await app.chrome.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
  assert.deepEqual(app.order(), [11, 10, 12]);
  assert.equal(app.tabs.get(10).pinned, true);
});

test('install and startup move the active tab last in each window', async () => {
  for (const name of ['onInstalled', 'onStartup']) {
    const app = setup([], [
      tab(10, 0, { active: true }), tab(11, 1),
      tab(20, 0, { windowId: 2, active: true }), tab(21, 1, { windowId: 2 }),
    ]);
    await app.chrome.runtime[name].emit();
    assert.deepEqual(app.order(), [11, 10]);
    assert.deepEqual(app.order(2), [21, 20]);
  }
});

test('background tabs join the group before its active tab is moved last', async () => {
  const app = setup([group(1)], [
    tab(10, 0, { active: true, groupId: 1 }),
  ]);
  await app.chrome.tabs.onCreated.emit(tab(11, 1));
  assert.deepEqual(app.joined, [{ groupId: 1, tabIds: 11 }]);
  assert.deepEqual(app.order(), [11, 10]);
  assert.equal(app.tabs.get(10).active, true);
});

test('foreground new tabs move last after being grouped in either event order', async () => {
  for (const activationFirst of [true, false]) {
    const created = tab(10, 0, { active: true });
    const app = setup([group(1)], [
      created, tab(11, 1, { groupId: 1 }), tab(12, 2, { groupId: 1 }),
    ]);
    const activate = () => app.chrome.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
    if (activationFirst) await activate();
    await app.chrome.tabs.onCreated.emit({ ...created, index: app.tabs.get(10).index });
    if (!activationFirst) await activate();
    assert.deepEqual(app.order(), [11, 12, 10]);
    assert.equal(app.tabs.get(10).groupId, 1);
  }
});

test('manual moves restore the active tab to last without a move event loop', async () => {
  const app = setup([], [tab(10, 1, { active: true }), tab(11, 0)]);
  await app.chrome.tabs.move(11, { index: 1 });
  await app.flush();
  assert.deepEqual(app.order(), [11, 10]);
  assert.deepEqual(app.moved, [{ id: 11, index: 1 }, { id: 10, index: 1 }]);
});

test('group membership and pin changes restore the active tab position', async () => {
  for (const changes of [{ groupId: 1 }, { pinned: false }]) {
    const app = setup([group(1)], [
      tab(10, 0, { active: true, ...changes }),
      tab(11, 1, changes),
    ]);
    await app.chrome.tabs.onUpdated.emit(10, changes, app.tabs.get(10));
    assert.deepEqual(app.order(), [11, 10]);
  }
});

test('attaching an active tab to another window moves it last there', async () => {
  const app = setup([], [tab(10, 0, { active: true }), tab(20, 1, { windowId: 2 })]);
  app.tabs.get(10).windowId = 2;
  await app.chrome.tabs.onAttached.emit(10, { newWindowId: 2, newPosition: 0 });
  assert.deepEqual(app.order(2), [20, 10]);
});

test('rapid activations reorder only the currently active tab and preserve source tracking', async () => {
  const app = setup([], [tab(10, 0), tab(11, 1), tab(12, 2)]);
  await Promise.all([
    app.chrome.tabs.onActivated.emit({ tabId: 10, windowId: 1 }),
    app.chrome.tabs.onActivated.emit({ tabId: 11, windowId: 1 }),
  ]);
  assert.deepEqual(app.order(), [10, 12, 11]);
  assert.deepEqual(app.moved, [{ id: 11, index: 2 }]);
  assert.equal(app.storage['window:1'].previous, 10);
  assert.equal(app.storage['window:1'].current, 11);
});

test('already last tabs and unrelated page updates do not trigger moves', async () => {
  const app = setup([], [tab(10, 0), tab(11, 1, { active: true })]);
  await app.chrome.tabs.onActivated.emit({ tabId: 11, windowId: 1 });
  app.tabs.get(10).active = true;
  app.tabs.get(11).active = false;
  await app.chrome.tabs.onUpdated.emit(10, { status: 'complete' }, app.tabs.get(10));
  assert.deepEqual(app.moved, []);
});

test('a move blocked by dragging retries using the latest active tab', async () => {
  const app = setup([], [tab(10, 0), tab(11, 1), tab(12, 2)]);
  const move = app.chrome.tabs.move;
  app.chrome.tabs.move = async () => {
    throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
  };
  await app.chrome.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
  assert.equal(app.retries.length, 1);
  app.chrome.tabs.move = move;
  app.tabs.get(10).active = false;
  app.tabs.get(11).active = true;
  await app.retries.shift()();
  assert.deepEqual(app.order(), [10, 12, 11]);
});

test('a drag retry tolerates a window being closed', async () => {
  const app = setup([], [tab(10, 0), tab(11, 1)]);
  app.chrome.tabs.move = async () => {
    throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
  };
  await app.chrome.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
  app.chrome.tabs.query = async () => { throw new Error('No window with id: 1.'); };
  await app.retries.shift()();
  assert.deepEqual(app.moved, []);
  assert.equal(app.retries.length, 0);
});

test('closing the active tab during a move does not break later events', async () => {
  const app = setup([], [tab(10, 0), tab(11, 1), tab(12, 2)]);
  const move = app.chrome.tabs.move;
  app.chrome.tabs.move = async () => {
    throw new Error('No tab with id: 10.');
  };
  await app.chrome.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
  app.chrome.tabs.move = move;
  await app.chrome.tabs.onActivated.emit({ tabId: 11, windowId: 1 });
  assert.deepEqual(app.order(), [10, 12, 11]);
});

test('unexpected browser failures are reported and the queue recovers', async () => {
  const app = setup([], [tab(10, 0), tab(11, 1)]);
  const move = app.chrome.tabs.move;
  app.chrome.tabs.move = async () => { throw new Error('Unexpected browser failure'); };
  await assert.rejects(
    app.chrome.tabs.onActivated.emit({ tabId: 10, windowId: 1 }),
    /Unexpected browser failure/,
  );
  app.chrome.tabs.move = move;
  await app.chrome.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
  assert.deepEqual(app.order(), [11, 10]);
  assert.equal(app.retries.length, 0);
});

test('install and startup tolerate having no current browser window', async () => {
  for (const name of ['onInstalled', 'onStartup']) {
    const app = setup([]);
    app.chrome.tabGroups.query = async () => { throw new Error('No current window'); };
    await app.chrome.runtime[name].emit();
    assert.deepEqual(app.joined, []);
    assert.deepEqual(app.moved, []);
    assert.equal(app.retries.length, 0);
  }
});

test('group events tolerate losing the current window while queued', async () => {
  const app = setup([group(1), group(2)]);
  const query = app.chrome.tabGroups.query;
  app.chrome.tabGroups.query = async () => { throw new Error('No current window'); };
  await app.chrome.tabGroups.onUpdated.emit(group(2));
  assert.deepEqual(app.expanded(1), [1, 2]);
  app.chrome.tabGroups.query = query;
  await app.chrome.tabGroups.onUpdated.emit(group(2));
  assert.deepEqual(app.expanded(1), [2]);
});

test('new tabs tolerate no current window and later tabs still join their group', async () => {
  const app = setup([group(1)]);
  const query = app.chrome.tabGroups.query;
  app.chrome.tabGroups.query = async () => { throw new Error('No current window'); };
  await app.chrome.tabs.onCreated.emit(tab(10, 0));
  assert.deepEqual(app.joined, []);
  app.chrome.tabGroups.query = query;
  await app.chrome.tabs.onCreated.emit(tab(11, 1));
  assert.deepEqual(app.joined, [{ groupId: 1, tabIds: 11 }]);
});

test('unrelated group query failures remain visible', async () => {
  const app = setup([]);
  app.chrome.tabGroups.query = async () => { throw new Error('Unexpected group query failure'); };
  await assert.rejects(app.chrome.runtime.onStartup.emit(), /Unexpected group query failure/);
});
