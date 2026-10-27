// A new ungrouped tab joins the expanded (not collapsed) group in its window.
// If several groups are expanded, it joins the group of the tab that was
// active before it appeared, when that group is one of them.
// The active tab per window lives in session storage, so it survives the
// service worker going to sleep.

// Keep at most one group expanded in each window.
const latestExpansion = new Map();

// Serialize storage updates so overlapping events do not overwrite each other.
let queue = Promise.resolve();
const serially = (task) => (queue = queue.then(task, task));

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
chrome.tabGroups.onMoved.addListener(onGroupExpanded);

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

chrome.tabs.onCreated.addListener((tab) =>
  serially(async () => {
    // Brave sets openerTabId even for links from other apps, so check the group instead.
    if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;
    const group = await pickGroup(tab);
    if (!group) return;
    await chrome.tabs.group({ groupId: group.id, tabIds: tab.id });
  }),
);
