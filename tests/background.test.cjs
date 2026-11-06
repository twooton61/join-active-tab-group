const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');

function setup(initialGroups, activeTabs = [], { editFailures = 0, holdSettling = false, rules = [], session = {} } = {}) {
  const groups = new Map(initialGroups.map((group) => [group.id, { ...group }]));
  const tabs = new Map(activeTabs.map((tab) => [tab.id, { ...tab }]));
  const storage = { ...session };
  const synced = { urlRules: rules };
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
    storage: { sync: {
      get: async (key) => ({ [key]: synced[key] }),
      set: async (entries) => Object.assign(synced, entries),
    }, session: {
      get: async (key) => ({ [key]: storage[key] }),
      set: async (entries) => Object.assign(storage, entries),
      remove: async (key) => { delete storage[key]; },
    } },
    tabs: {
      onActivated: event(), onCreated: event((tab) => tabs.set(tab.id, { ...tab })),
      onUpdated: event((id, changes) => {
        const tab = tabs.get(id);
        if (changes.url !== undefined) delete tab.pendingUrl;
        Object.assign(tab, changes);
      }),
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
        const groupId = args.groupId ?? Math.max(0, ...groups.keys()) + 1;
        if (!groups.has(groupId)) {
          groups.set(groupId, { id: groupId, windowId: args.createProperties.windowId, collapsed: false });
          void chrome.tabGroups.onCreated.emit({ ...groups.get(groupId) });
        }
        tabs.get(args.tabIds).groupId = groupId;
        void chrome.tabs.onUpdated.emit(args.tabIds, { groupId });
        return groupId;
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
    action: { onClicked: event() },
    runtime: { onInstalled: event(), onStartup: event(), openOptionsPage: async () => {} },
    windows: { onRemoved: event() },
  };
  const context = vm.createContext({
    chrome, URL,
    importScripts: () => vm.runInContext(fs.readFileSync(require.resolve('../rules.js'), 'utf8'), context),
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
    chrome, groups, tabs, joined, errors, settling, synced,
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

test('saved groups restored after tab creation keep all their tabs', async () => {
  // Also cover a saved group containing just one tab and a collapsed group.
  for (const count of [1, 3]) {
    for (const collapsed of [false, true]) {
      const app = setup([group(1)], [], { holdSettling: true });
      const pending = Array.from({ length: count }, (_, index) =>
        app.chrome.tabs.onCreated.emit({ id: 10 + index, windowId: 1, groupId: -1 }));
      await new Promise(setImmediate);
      assert.deepEqual(app.joined, []);
      assert.equal(app.settling.length, count);

      // The browser creates the group and assigns membership in a later turn.
      app.groups.set(2, group(2, 1, collapsed));
      for (let index = 0; index < count; index++) app.tabs.get(10 + index).groupId = 2;
      await app.chrome.tabGroups.onCreated.emit(group(2, 1, collapsed));
      for (const resume of app.settling) resume();
      await Promise.all(pending);

      assert.deepEqual(app.joined, []);
      assert.equal(app.groups.has(2), true);
      assert.deepEqual(app.expanded(1), collapsed ? [1] : [2]);
      assert.deepEqual(app.errors, []);
    }
  }
});

test('group assignment cancels pending placement even if the tab is later ungrouped', async () => {
  const app = setup([group(1)], [], { holdSettling: true });
  const pending = app.chrome.tabs.onCreated.emit({ id: 10, windowId: 1, groupId: -1 });
  await app.chrome.tabs.onUpdated.emit(10, { groupId: 2 });
  await app.chrome.tabs.onUpdated.emit(10, { groupId: -1 });
  app.settling[0]();
  await pending;
  assert.deepEqual(app.joined, []);
  assert.deepEqual(app.errors, []);
});

test('a saved group restored during a tab-edit retry keeps both groups', async () => {
  const app = setup([group(1, 1, false)], [], { holdSettling: true });
  const original = app.chrome.tabs.group;
  let attempts = 0;
  app.chrome.tabs.group = async (args) => {
    if (attempts++ === 0) {
      // The browser finishes restoring SmartPath while Oodle's attempted
      // edit is locked. The retry must not take SmartPath's restored tab.
      app.groups.set(2, group(2));
      await app.chrome.tabs.onUpdated.emit(10, { groupId: 2 });
      void app.chrome.tabGroups.onCreated.emit(group(2));
      throw new Error('Tabs cannot be edited right now');
    }
    return original(args);
  };
  const pending = app.chrome.tabs.onCreated.emit({ id: 10, windowId: 1, groupId: -1 });
  app.settling[0]();
  await pending;
  // Drain the queued group-created handler.
  await app.chrome.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
  assert.deepEqual([...app.groups.keys()], [1, 2]);
  assert.equal(app.tabs.get(10).groupId, 2);
  assert.deepEqual(app.expanded(1), [2]);
  assert.deepEqual(app.joined, []);
  assert.equal(attempts, 1);
  assert.deepEqual(app.errors, []);
});

test('ordinary new tabs settle without blocking group switching or activation', async () => {
  const app = setup([group(1), group(2, 1, true)], [], { holdSettling: true });
  const pending = app.chrome.tabs.onCreated.emit({ id: 10, windowId: 1, groupId: -1 });
  await new Promise(setImmediate);
  assert.deepEqual(app.joined, []);
  assert.equal(app.settling.length, 1);
  app.groups.get(2).collapsed = false;
  await app.chrome.tabGroups.onUpdated.emit(group(2));
  await app.chrome.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
  assert.deepEqual(app.expanded(1), [2]);
  app.settling[0]();
  await pending;
  assert.deepEqual(app.joined, [{ groupId: 2, tabIds: 10 }]);
});

test('membership assigned while choosing a destination is respected', async () => {
  const app = setup([group(1)]);
  const original = app.chrome.tabGroups.query;
  app.chrome.tabGroups.query = async (filter) => {
    const result = await original(filter);
    app.tabs.get(10).groupId = 2;
    return result;
  };
  await app.chrome.tabs.onCreated.emit({ id: 10, windowId: 1, groupId: -1 });
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

test('queued new tabs respect closing, pinning, and manual group changes', async () => {
  for (const change of ['closed', 'pinned', 'grouped']) {
    const app = setup([group(1)]);
    const pending = app.chrome.tabs.onCreated.emit({ id: 10, windowId: 1, groupId: -1 });
    if (change === 'closed') app.tabs.delete(10);
    if (change === 'pinned') app.tabs.get(10).pinned = true;
    if (change === 'grouped') app.tabs.get(10).groupId = 2;
    await pending;
    assert.deepEqual(app.joined, []);
    assert.deepEqual(app.errors, []);
  }
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

const rule = (pattern = 'https://example.com/project/*', groupName = 'Project') =>
  ({ id: 'test', pattern, groupName, enabled: true });
const named = (id, title, windowId = 1, collapsed = true) => ({ ...group(id, windowId, collapsed), title });
const newTab = (url, extra = {}) => ({ id: 10, windowId: 1, groupId: -1, url, ...extra });
const drain = (app) => app.chrome.tabs.onActivated.emit({ tabId: 10, windowId: 1 });

test('new links inheriting the opener group follow explicit URL rules', async () => {
  const source = newTab('https://app.basecamp.com/3091894/buckets/45782624/messages/1', { id: 9, groupId: 1 });
  const app = setup([named(1, 'SmartPath', 1, false), named(2, 'Miami')], [source], {
    rules: [rule('https://*.basecamp.com/3091894/*/46017775/*', 'Miami')],
  });
  await app.chrome.tabs.onCreated.emit(newTab(
    'https://app.basecamp.com/3091894/buckets/46017775/messages/1042181965',
    { groupId: 1, openerTabId: 9, active: true },
  ));
  await drain(app);
  assert.equal(app.tabs.get(10).groupId, 2);
  assert.deepEqual(app.expanded(1), [2]);
  assert.deepEqual(app.errors, []);
});

test('inherited tabs keep their group without a rule and respect manual moves during settling', async () => {
  for (const manual of [false, true]) {
    const app = setup([named(1, 'SmartPath', 1, false), named(2, 'Miami'), named(3, 'Manual')], [
      newTab('https://source.com/', { id: 9, groupId: 1 }),
    ], { rules: [rule('https://destination.com/*', 'Miami')], holdSettling: true });
    const pending = app.chrome.tabs.onCreated.emit(newTab(manual ? 'https://destination.com/' : 'https://unmatched.com/', {
      groupId: 1, openerTabId: 9,
    }));
    if (manual) await app.chrome.tabs.onUpdated.emit(10, { groupId: 3 });
    app.settling[0]();
    await pending;
    assert.deepEqual(app.joined, []);
    assert.equal(app.tabs.get(10).groupId, manual ? 3 : 1);
  }
});

test('a blank inherited tab follows its rule when the link URL arrives after settling', async () => {
  const app = setup([named(1, 'SmartPath', 1, false), named(2, 'Miami')], [
    newTab('https://source.com/', { id: 9, groupId: 1 }),
  ], { rules: [rule('https://destination.com/*', 'Miami')] });
  await app.chrome.tabs.onCreated.emit(newTab('', { groupId: 1, openerTabId: 9 }));
  await app.chrome.tabs.onUpdated.emit(10, { url: 'https://destination.com/' });
  assert.equal(app.tabs.get(10).groupId, 2);
  assert.deepEqual(app.errors, []);
});

test('an existing SmartPath tab moves to Miami when Basecamp sidebar navigation changes its URL', async () => {
  const app = setup([named(1, 'SmartPath', 1, false), named(2, 'Miami')], [newTab(
    'https://app.basecamp.com/3091894/buckets/45782624/messages/1',
    { groupId: 1, active: true },
  )], { rules: [
    rule('https://*.basecamp.com/3091894/*/45782624/*', 'SmartPath'),
    rule('https://*.basecamp.com/3091894/*/46017775/*', 'Miami'),
  ] });
  await app.chrome.tabs.onUpdated.emit(10, {
    url: 'https://app.basecamp.com/3091894/buckets/46017775/messages/1048236643#__recording_10484507933',
  });
  await drain(app);
  assert.deepEqual(app.joined, [{ groupId: 2, tabIds: 10 }]);
  assert.deepEqual(app.expanded(1), [2]);
  await app.chrome.tabs.onUpdated.emit(10, {
    url: 'https://app.basecamp.com/3091894/buckets/45782624/messages/2',
  });
  await drain(app);
  assert.equal(app.tabs.get(10).groupId, 1);
  assert.deepEqual(app.expanded(1), [1]);
  assert.deepEqual(app.errors, []);
});

test('restored grouped tabs ignore their initial URL notifications but follow later navigation', async () => {
  const url = 'https://example.com/project/42';
  for (const initial of [url, '']) {
    const app = setup([group(1), named(2, 'Project')], [], { rules: [rule()] });
    await app.chrome.tabs.onCreated.emit(newTab(initial, { groupId: 1 }));
    await app.chrome.tabs.onUpdated.emit(10, { url });
    assert.equal(app.tabs.get(10).groupId, 1);
    assert.deepEqual(app.joined, []);
    await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/project/43' });
    assert.equal(app.tabs.get(10).groupId, 2);
    assert.deepEqual(app.errors, []);
  }
});

test('a saved group assigned during settling keeps a URL that arrives after settling', async () => {
  const app = setup([group(1), named(2, 'Project')], [], { rules: [rule()], holdSettling: true });
  const pending = app.chrome.tabs.onCreated.emit(newTab(''));
  await app.chrome.tabs.onUpdated.emit(10, { groupId: 1 });
  app.settling[0]();
  await pending;
  await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/project/42' });
  assert.deepEqual(app.joined, []);
  assert.equal(app.tabs.get(10).groupId, 1);
  await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/project/43' });
  assert.equal(app.tabs.get(10).groupId, 2);
});

test('later navigation keeps pinned tabs and unmatched URLs in place', async () => {
  for (const pinned of [false, true]) {
    const app = setup([group(1), named(2, 'Project')], [], { rules: [rule()] });
    await app.chrome.tabs.onCreated.emit(newTab('https://unrelated.com/', { groupId: 1, pinned }));
    await app.chrome.tabs.onUpdated.emit(10, { url: 'https://unmatched.com/' });
    assert.equal(app.tabs.get(10).groupId, 1);
    await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/project/42' });
    assert.equal(app.tabs.get(10).groupId, pinned ? 1 : 2);
    assert.deepEqual(app.errors, []);
  }
});

test('manual placement stays put until navigation changes the URL', async () => {
  const app = setup([group(1), named(2, 'Project'), named(3, 'Manual')], [], { rules: [rule()] });
  const url = 'https://example.com/project/42';
  await app.chrome.tabs.onCreated.emit(newTab(url));
  await app.chrome.tabs.onUpdated.emit(10, { groupId: 3 });
  await app.chrome.tabs.onUpdated.emit(10, { url });
  assert.equal(app.tabs.get(10).groupId, 3);
  await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/project/43' });
  assert.equal(app.tabs.get(10).groupId, 2);
});

test('navigation routing retries a locked tab edit without losing the destination URL', async () => {
  const app = setup([group(1), named(2, 'Project')], [newTab('https://unrelated.com/', { groupId: 1 })], {
    rules: [rule()], editFailures: 2,
    session: { 'navigation:10': { url: 'https://unrelated.com/' } },
  });
  await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/project/42' });
  assert.deepEqual(app.joined, [{ groupId: 2, tabIds: 10 }]);
  assert.deepEqual(app.errors, []);
});

test('later navigation respects a manual move while its lookup is waiting', async () => {
  const app = setup([group(1), named(2, 'Project'), named(3, 'Manual')], [newTab('https://unrelated.com/', { groupId: 1 })], {
    rules: [rule()],
  });
  const query = app.chrome.tabGroups.query;
  app.chrome.tabGroups.query = async (filter) => {
    const result = await query(filter);
    void app.chrome.tabs.onUpdated.emit(10, { groupId: 3 });
    void app.chrome.tabs.onUpdated.emit(10, { groupId: 1 });
    return result;
  };
  await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/project/42' });
  assert.deepEqual(app.joined, []);
  assert.equal(app.tabs.get(10).groupId, 1);
});

test('extension pages route to Oodle on creation, including pending URLs', async () => {
  const url = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html';
  for (const extra of [{ url }, { url: '', pendingUrl: url }]) {
    const app = setup([group(1), named(2, 'Oodle')], [], {
      rules: [rule('*://*/*', 'Web'), rule('chrome-extension://*/*', 'Oodle')],
    });
    await app.chrome.tabs.onCreated.emit(newTab('', { ...extra, active: true }));
    await drain(app);
    assert.equal(app.tabs.get(10).groupId, 2);
    assert.deepEqual(app.expanded(1), [2]);
    assert.deepEqual(app.errors, []);
  }
});

test('browser pages route on creation, pending URL, and first navigation with either alias', async () => {
  for (const scheme of ['brave', 'chrome']) {
    for (const mode of ['direct', 'pending', 'blank']) {
      const url = `${scheme}://extensions/`;
      const app = setup([group(1), named(2, 'Oodle')], [], {
        rules: [rule('*://*/*', 'Web'), rule('brave://extensions/*', 'Oodle')],
      });
      await app.chrome.tabs.onCreated.emit(newTab(mode === 'direct' ? url : 'about:blank', {
        active: true, ...(mode === 'pending' ? { pendingUrl: url } : {}),
      }));
      if (mode === 'blank') {
        // A placeholder update must not consume the first real navigation.
        await app.chrome.tabs.onUpdated.emit(10, { url: `${scheme}://newtab/` });
        await app.chrome.tabs.onUpdated.emit(10, { url });
      }
      await drain(app);
      assert.equal(app.tabs.get(10).groupId, 2);
      assert.deepEqual(app.expanded(1), [2]);
      await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/' });
      assert.equal(app.groups.get(app.tabs.get(10).groupId).title, 'Web');
      assert.deepEqual(app.errors, []);
    }
  }
});

test('browser-page routing respects pinned and grouped tabs', async () => {
  for (const extra of [{ pinned: true }, { groupId: 1 }]) {
    const app = setup([group(1), named(2, 'Oodle')], [], {
      rules: [rule('brave://extensions/*', 'Oodle')],
    });
    await app.chrome.tabs.onCreated.emit(newTab('chrome://extensions/', extra));
    assert.deepEqual(app.joined, []);
  }
});

test('the exact Oodle shorthand rules route new and initially blank tabs', async () => {
  for (const url of ['brave://extensions', 'chrome://settings/',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html']) {
    for (const blank of [false, true]) {
      const app = setup([group(1), named(2, 'Oodle')], [], {
        rules: [{ groupName: 'Oodle', patterns: 'brave://*\nchrome-extension://*' }],
      });
      await app.chrome.tabs.onCreated.emit(newTab(blank ? 'about:blank' : url));
      if (blank) await app.chrome.tabs.onUpdated.emit(10, { url });
      await drain(app);
      assert.equal(app.tabs.get(10).groupId, 2, `${url}, blank=${blank}`);
      assert.deepEqual(app.errors, []);
    }
  }
});

test('blank tabs respect manual placement, then follow rules on later navigation', async () => {
  for (const expanded of [true, false]) {
    for (const manual of [false, true]) {
      const app = setup([group(1, 1, !expanded), named(2, 'Oodle'), named(3, 'Manual'), named(4, 'Web')], [], {
        rules: [rule('chrome-extension://*/*', 'Oodle'), rule('https://example.com/*', 'Web')],
      });
      await app.chrome.tabs.onCreated.emit(newTab('about:blank'));
      if (manual) await app.chrome.tabs.onUpdated.emit(10, { groupId: 3 });
      await app.chrome.tabs.onUpdated.emit(10, {
        url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html',
      });
      assert.equal(app.tabs.get(10).groupId, manual ? 3 : 2);
      await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/' });
      assert.equal(app.tabs.get(10).groupId, 4);
      assert.deepEqual(app.errors, []);
    }
  }
});

test('URL rules override the expanded group and reuse a same-window named group', async () => {
  const app = setup([group(1), named(2, 'Project'), named(3, 'Project', 2)], [], { rules: [rule()] });
  await app.chrome.tabs.onCreated.emit(newTab('https://example.com/project/42', { active: true }));
  await drain(app);
  assert.deepEqual(app.joined, [{ groupId: 2, tabIds: 10 }]);
  assert.deepEqual(app.expanded(1), [2]);
  assert.equal(app.groups.get(3).collapsed, true);
});

test('background tabs do not expand a collapsed destination', async () => {
  const app = setup([group(1), named(2, 'Project')], [], { rules: [rule()] });
  await app.chrome.tabs.onCreated.emit(newTab('https://example.com/project/42', { active: false }));
  await drain(app);
  assert.equal(app.tabs.get(10).groupId, 2);
  assert.deepEqual(app.expanded(1), [1]);
});

test('missing groups are created and named in the tab window, even if a name exists elsewhere', async () => {
  const app = setup([group(1), named(2, 'Project', 2)], [], { rules: [rule()] });
  await app.chrome.tabs.onCreated.emit(newTab('https://example.com/project', { active: true }));
  await drain(app);
  const created = app.groups.get(app.tabs.get(10).groupId);
  assert.equal(created.title, 'Project');
  assert.equal(created.windowId, 1);
  assert.deepEqual(app.expanded(1), [created.id]);
  assert.deepEqual(app.errors, []);
});

test('new background groups are collapsed and creation naming tolerates edit locks', async () => {
  const app = setup([group(1)], [], { rules: [rule()] });
  const update = app.chrome.tabGroups.update;
  let calls = 0;
  app.chrome.tabGroups.update = async (...args) => {
    if (calls++ === 0) throw new Error('Tabs cannot be edited right now');
    return update(...args);
  };
  await app.chrome.tabs.onCreated.emit(newTab('https://example.com/project/1'));
  await drain(app);
  assert.equal(app.joined.length, 1);
  assert.equal(app.groups.get(2).title, 'Project');
  assert.deepEqual(app.expanded(1), [1]);
  assert.deepEqual(app.errors, []);
});

test('new tabs use the first enabled rule and read settings on each placement', async () => {
  const app = setup([group(1), named(2, 'Project'), named(3, 'Other')], [], {
    rules: [{ ...rule(), enabled: false }, rule('*://*/*', 'Other'), rule()],
  });
  await app.chrome.tabs.onCreated.emit(newTab('https://example.com/project/1'));
  assert.equal(app.tabs.get(10).groupId, 3);
  app.synced.urlRules = [rule()];
  await app.chrome.tabs.onCreated.emit(newTab('https://example.com/project/2', { id: 11 }));
  assert.equal(app.tabs.get(11).groupId, 2);
});

test('unmatched URLs retain expanded-group behavior and pendingUrl can route immediately', async () => {
  const app = setup([group(1), named(2, 'Project')], [], { rules: [rule()] });
  await app.chrome.tabs.onCreated.emit(newTab('https://unrelated.com/'));
  assert.equal(app.tabs.get(10).groupId, 1);
  await app.chrome.tabs.onCreated.emit(newTab('', { id: 11, pendingUrl: 'https://example.com/project/42' }));
  assert.equal(app.tabs.get(11).groupId, 2);
});

test('blank tabs and later navigation follow the matching URL rules', async () => {
  for (const expanded of [true, false]) {
    const app = setup([group(1, 1, !expanded), named(2, 'Project'), named(3, 'Other')], [], {
      rules: [rule(), rule('https://other.com/*', 'Other')],
    });
    await app.chrome.tabs.onCreated.emit(newTab('chrome://newtab/'));
    assert.equal(app.tabs.get(10).groupId, expanded ? 1 : -1);
    await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/project/42' });
    assert.equal(app.tabs.get(10).groupId, 2);
    await app.chrome.tabs.onUpdated.emit(10, { url: 'https://other.com/' });
    assert.equal(app.tabs.get(10).groupId, 3);
  }
});

test('an unmatched navigation does not prevent a later matching navigation', async () => {
  const app = setup([group(1), named(2, 'Project')], [], { rules: [rule()] });
  await app.chrome.tabs.onCreated.emit(newTab('about:blank'));
  await app.chrome.tabs.onUpdated.emit(10, { url: 'https://unrelated.com/' });
  await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/project/42' });
  assert.equal(app.tabs.get(10).groupId, 2);
});

test('manual placement and pinning cancel deferred routing, including move-away-and-back', async () => {
  for (const action of ['group', 'ungroup', 'pin', 'away-and-back']) {
    const app = setup([group(1), named(2, 'Project'), named(3, 'Manual')], [], { rules: [rule()] });
    await app.chrome.tabs.onCreated.emit(newTab('chrome://newtab/'));
    if (action === 'pin') await app.chrome.tabs.onUpdated.emit(10, { pinned: true });
    else {
      await app.chrome.tabs.onUpdated.emit(10, { groupId: action === 'ungroup' ? -1 : 3 });
      if (action === 'away-and-back') await app.chrome.tabs.onUpdated.emit(10, { groupId: 1 });
    }
    const count = app.joined.length;
    await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/project/42' });
    assert.equal(app.joined.length, count, action);
  }
});

test('rules leave restored, already grouped, and pinned tabs alone', async () => {
  for (const extra of [{ groupId: 1 }, { pinned: true }]) {
    const app = setup([group(1), named(2, 'Project')], [], { rules: [rule()] });
    await app.chrome.tabs.onCreated.emit(newTab('https://example.com/project/42', extra));
    assert.deepEqual(app.joined, []);
  }
  const app = setup([group(1), named(2, 'Project')], [], { holdSettling: true, rules: [rule()] });
  const pending = app.chrome.tabs.onCreated.emit(newTab('https://example.com/project/42'));
  await app.chrome.tabs.onUpdated.emit(10, { groupId: 1 });
  app.settling[0]();
  await pending;
  assert.deepEqual(app.joined, []);
});

test('a URL arriving during settling uses its rule rather than the expanded group', async () => {
  const app = setup([group(1), named(2, 'Project')], [], { holdSettling: true, rules: [rule()] });
  const pending = app.chrome.tabs.onCreated.emit(newTab(''));
  await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/project/42' });
  app.settling[0]();
  await pending;
  assert.equal(app.tabs.get(10).groupId, 2);
});

test('a destination changing during lookup is matched again', async () => {
  const app = setup([group(1), named(2, 'Project')], [], { rules: [rule()] });
  const query = app.chrome.tabGroups.query;
  let changed = false;
  app.chrome.tabGroups.query = async (filter) => {
    const result = await query(filter);
    if (!changed) {
      changed = true;
      app.tabs.get(10).url = 'https://example.com/project/42';
    }
    return result;
  };
  await app.chrome.tabs.onCreated.emit(newTab('about:blank'));
  assert.equal(app.tabs.get(10).groupId, 2);
});

test('manual move-away-and-back during deferred lookup cancels placement', async () => {
  const app = setup([group(1), named(2, 'Project'), named(3, 'Manual')], [], { rules: [rule()] });
  await app.chrome.tabs.onCreated.emit(newTab('about:blank'));
  await drain(app);
  const query = app.chrome.tabGroups.query;
  app.chrome.tabGroups.query = async (filter) => {
    const result = await query(filter);
    void app.chrome.tabs.onUpdated.emit(10, { groupId: 3 });
    void app.chrome.tabs.onUpdated.emit(10, { groupId: 1 });
    return result;
  };
  await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/project/42' });
  assert.equal(app.tabs.get(10).groupId, 1);
});


test('deferred routing survives service-worker memory being discarded', async () => {
  // A fresh worker receives an update for a tab created by its predecessor.
  const app = setup([group(1), named(2, 'Project')], [newTab('about:blank', { groupId: 1 })], {
    rules: [rule()], session: { 'route:10': { groupId: 1 } },
  });
  await app.chrome.tabs.onUpdated.emit(10, { url: 'https://example.com/project/42' });
  assert.equal(app.tabs.get(10).groupId, 2);
});

test('grouped settings route each active line and ignore commented lines', async () => {
  const app = setup([group(1), named(2, 'Project')], [], { rules: [
    { id: 'project', groupName: 'Project', patterns: '# https://paused.com/*\nhttps://example.com/*\nhttps://second.com/*' },
  ] });
  for (const [id, url, expected] of [[10, 'https://paused.com/', 1], [11, 'https://example.com/', 2], [12, 'https://second.com/', 2]]) {
    await app.chrome.tabs.onCreated.emit(newTab(url, { id }));
    assert.equal(app.tabs.get(id).groupId, expected);
  }
});
