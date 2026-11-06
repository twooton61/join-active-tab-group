importScripts('rules.js');

chrome.action.onClicked.addListener(() =>
  chrome.runtime.openOptionsPage().catch((error) => console.error('tab-tether:', error)),
);

// A new ungrouped tab joins the expanded (not collapsed) group in its window.
// If several groups are expanded, it joins the group of the tab that was
// active before it appeared, when that group is one of them.
// The active tab per window lives in session storage, so it survives the
// service worker going to sleep.

// Keep at most one group expanded in each window.
const latestExpansion = new Map();

// Serialize storage updates so overlapping events do not overwrite each other.
let queue = Promise.resolve();
async function retryTabEdits(task) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      // Brave/Chrome temporarily lock tab edits during tab-strip interactions.
      // Retry the whole task so it checks the latest tab and group state again.
      if (!error.message?.includes('Tabs cannot be edited right now') || attempt >= 10) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
const serially = (task) => (queue = queue
  .then(() => retryTabEdits(task))
  .catch((error) => console.error('tab-tether:', error)));

const key = (windowId) => `window:${windowId}`;
const routeKey = (tabId) => `route:${tabId}`;
const navigationKey = (tabId) => `navigation:${tabId}`;
const destination = (tab) => tab.pendingUrl || tab.url || '';
const isRoutableUrl = (url) => /^(https?|chrome-extension|chrome|brave):\/\//.test(url);
const isWaitingUrl = (url) => !url || /^(about:blank|chrome:\/\/newtab\/|brave:\/\/newtab\/)$/.test(url);

async function collapseOtherGroups(group, isCurrent = () => true) {
  // Events may be queued while a group is collapsed or removed.
  const current = await chrome.tabGroups.get(group.id).catch(() => null);
  if (!current || current.collapsed) return;
  const expanded = await chrome.tabGroups.query({ windowId: current.windowId, collapsed: false });
  for (const other of expanded) {
    if (!isCurrent()) return;
    if (other.id !== current.id) {
      await chrome.tabGroups.update(other.id, { collapsed: true });
    }
  }
}

function onGroupExpanded(group) {
  if (group.collapsed) return;
  const request = {};
  latestExpansion.set(group.windowId, request);
  return serially(() =>
    collapseOtherGroups(group, () => latestExpansion.get(group.windowId) === request),
  );
}

chrome.tabGroups.onUpdated.addListener(onGroupExpanded);
chrome.tabGroups.onCreated.addListener(onGroupExpanded);
// Position changes are not expansions. In particular, tab-strip changes when
// closing tabs must not make another group collapse the one being used.

async function readEntry(windowId) {
  const stored = await chrome.storage.session.get(key(windowId));
  return stored[key(windowId)] ?? {};
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) =>
  serially(async () => {
    const entry = await readEntry(windowId);
    if (entry.current === tabId) return;
    await chrome.storage.session.set({
      [key(windowId)]: { previous: entry.current, current: tabId },
    });
  }),
);

// Seed the record with each window's active tab, so the first external link
// after install or browser start has a source tab.
async function seed() {
  const active = await chrome.tabs.query({ active: true });
  await chrome.storage.session.set(
    Object.fromEntries(active.map((tab) => [key(tab.windowId), { current: tab.id }])),
  );
  const expanded = await chrome.tabGroups.query({ collapsed: false });
  const windowIds = new Set(expanded.map((group) => group.windowId));
  for (const windowId of windowIds) {
    const groups = expanded.filter((group) => group.windowId === windowId);
    const activeTab = active.find((tab) => tab.windowId === windowId);
    const keep = groups.find((group) => group.id === activeTab?.groupId) ?? groups[0];
    await collapseOtherGroups(keep);
  }
}
chrome.runtime.onInstalled.addListener(() => serially(seed));
chrome.runtime.onStartup.addListener(() => serially(seed));

chrome.windows.onRemoved.addListener((windowId) =>
  serially(() => {
    latestExpansion.delete(windowId);
    return chrome.storage.session.remove(key(windowId));
  }),
);

async function pickGroup(tab) {
  const expanded = await chrome.tabGroups.query({ windowId: tab.windowId, collapsed: false });
  if (expanded.length <= 1) return expanded[0];

  const entry = await readEntry(tab.windowId);
  const sourceId = entry.current === tab.id ? entry.previous : entry.current;
  const source = sourceId === undefined ? null : await chrome.tabs.get(sourceId).catch(() => null);
  return expanded.find((group) => group.id === source?.groupId);
}

// Chrome may emit onCreated before assigning restored tabs to their saved
// group. Let that operation settle before considering an ungrouped tab ours.
// Wait outside the queue so group and activation events can still run.
const NEW_TAB_SETTLE_MS = 500;
const pendingTabs = new Set();
const placementVersions = new Map();
// Once the browser or user has assigned a group, this is no longer our tab
// to place, even if it becomes ungrouped again before a queued edit runs.
// Remember each tab's URL so initial restore notifications and duplicate URL
// events do not move saved groups. Later navigation can follow explicit rules.
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.groupId !== undefined || changes.pinned !== undefined) {
    placementVersions.set(tabId, (placementVersions.get(tabId) ?? 0) + 1);
  }
  const assignedDuringPlacement = pendingTabs.has(tabId)
    && changes.groupId !== undefined && changes.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE;
  if (assignedDuringPlacement) {
    pendingTabs.delete(tabId);
  }
  if (changes.url === undefined && changes.groupId === undefined && changes.pinned === undefined) return;
  const version = placementVersions.get(tabId);
  const update = serially(async () => {
    const entry = (await chrome.storage.session.get(routeKey(tabId)))[routeKey(tabId)];
    const previous = (await chrome.storage.session.get(navigationKey(tabId)))[navigationKey(tabId)];
    const manuallyPlaced = entry && (changes.pinned
      || (changes.groupId !== undefined && changes.groupId !== entry.groupId));
    if (manuallyPlaced) {
      await chrome.storage.session.remove(routeKey(tabId));
    }
    if (changes.url === undefined) {
      // A restored or manually placed blank tab keeps its initial destination.
      if (((assignedDuringPlacement && !entry) || manuallyPlaced) && isWaitingUrl(previous?.url)) {
        await chrome.storage.session.set({ [navigationKey(tabId)]: { ...previous, ignoreFirstUrl: true } });
      }
      return;
    }
    const next = {
      url: changes.url,
      ignoreFirstUrl: isWaitingUrl(changes.url) && Boolean(previous?.ignoreFirstUrl),
    };
    if (!changes.url || !isRoutableUrl(changes.url) || isWaitingUrl(changes.url)
      || pendingTabs.has(tabId) || (previous?.ignoreFirstUrl && !entry) || previous?.url === changes.url || manuallyPlaced) {
      await chrome.storage.session.set({ [navigationKey(tabId)]: next });
      return;
    }
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (current && !current.pinned) {
      await placeTab(current, () => placementVersions.get(tabId) === version, current.groupId, false);
    }
    await chrome.storage.session.remove(routeKey(tabId));
    // Record success after tab edits, so a locked tab strip can retry this URL.
    await chrome.storage.session.set({ [navigationKey(tabId)]: next });
  });
  if (changes.url) return update;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  pendingTabs.delete(tabId);
  placementVersions.delete(tabId);
  return serially(async () => {
    await chrome.storage.session.remove(routeKey(tabId));
    await chrome.storage.session.remove(navigationKey(tabId));
  });
});

async function placeTab(tab, isCurrent, expectedGroupId, fallback = true) {
  const version = placementVersions.get(tab.id);
  const url = destination(tab);
  const { urlRules = [] } = await chrome.storage.sync.get('urlRules');
  const rule = UrlRules.firstMatch(urlRules, url);
  const groups = rule ? await chrome.tabGroups.query({ windowId: tab.windowId }) : [];
  const group = rule
    ? groups.find((candidate) => candidate.title === rule.groupName)
    : fallback ? await pickGroup(tab) : null;
  // Picking a destination uses async APIs; respect changes during it too.
  const latest = await chrome.tabs.get(tab.id).catch(() => null);
  if (!isCurrent() || !latest || latest.pinned || latest.groupId !== expectedGroupId || placementVersions.get(tab.id) !== version) return;
  if (destination(latest) !== url || latest.windowId !== tab.windowId) {
    return placeTab(latest, isCurrent, expectedGroupId, fallback);
  }
  if (isWaitingUrl(url)) {
    await chrome.storage.session.set({ [routeKey(tab.id)]: { groupId: group?.id ?? expectedGroupId } });
  }
  if (!group && !rule) return;
  let groupId = group?.id;
  if (groupId === undefined) {
    groupId = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: tab.windowId } });
    // Once creation succeeds, retry naming separately to avoid creating an
    // extra group if the tab strip temporarily locks between these edits.
    await retryTabEdits(() => chrome.tabGroups.update(groupId, { title: rule.groupName, collapsed: !latest.active }));
  } else if (latest.groupId !== groupId) {
    await chrome.tabs.group({ groupId, tabIds: tab.id });
  }
  if (rule && latest.active) {
    await retryTabEdits(() => chrome.tabGroups.update(groupId, { collapsed: false }));
  }
}

chrome.tabs.onCreated.addListener(async (tab) => {
  const url = destination(tab);
  const recorded = serially(() => chrome.storage.session.set({ [navigationKey(tab.id)]: {
    url,
    ignoreFirstUrl: tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && isWaitingUrl(url),
  } }));
  // A link opened from a grouped tab can inherit that group before onCreated.
  // Keep tabs without an opener protected, including reopened saved groups.
  if (tab.pinned || (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && tab.openerTabId === undefined)) return recorded;
  pendingTabs.add(tab.id);
  try {
    await new Promise((resolve) => setTimeout(resolve, NEW_TAB_SETTLE_MS));
    return await serially(async () => {
      if (!pendingTabs.has(tab.id)) return;
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (!current || current.pinned || current.groupId !== tab.groupId) return;
      const inherited = tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE;
      if (inherited) {
        const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
        if (!opener || opener.windowId !== current.windowId || opener.groupId !== current.groupId) return;
      }
      await placeTab(current, () => pendingTabs.has(tab.id), tab.groupId, !inherited);
    });
  } finally {
    pendingTabs.delete(tab.id);
  }
});
