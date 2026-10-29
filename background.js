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
  .catch((error) => console.error('join-active-tab-group:', error)));

const key = (windowId) => `window:${windowId}`;

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
// Once the browser or user has assigned a group, this is no longer our tab
// to place, even if it becomes ungrouped again before a queued edit runs.
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.groupId !== undefined && changes.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    pendingTabs.delete(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => pendingTabs.delete(tabId));

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.pinned || tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;
  pendingTabs.add(tab.id);
  try {
    await new Promise((resolve) => setTimeout(resolve, NEW_TAB_SETTLE_MS));
    return await serially(async () => {
      if (!pendingTabs.has(tab.id)) return;
      // A tab may have closed, been pinned, or joined a group while waiting.
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      // Brave sets openerTabId even for links from other apps, so check the group instead.
      if (!current || current.pinned || current.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;
      const group = await pickGroup(current);
      if (!group) return;
      // Picking a group uses async APIs; respect membership changes during it too.
      const latest = await chrome.tabs.get(tab.id).catch(() => null);
      if (!pendingTabs.has(tab.id) || !latest || latest.pinned || latest.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;
      await chrome.tabs.group({ groupId: group.id, tabIds: current.id });
    });
  } finally {
    pendingTabs.delete(tab.id);
  }
});
