# Tab Tether

![Tab Tether neon pixel kraken](icons/icon128.png)

A tiny Chrome and Brave extension that puts new tabs in your expanded tab group
and keeps just one group expanded per window.

Keep your current task together as you browse:

- New tabs join the expanded group, whether you use a keyboard shortcut, a browser
  menu, or a link from another app.
- Expanding a group collapses the other groups in that window. Their tabs stay open.
- Each browser window keeps its own expanded group.

## Zero dependencies

Plain JavaScript and the browser's extension APIs. No npm packages, build
step, bundler, or runtime downloads. The folder you clone is the folder you load.
Please keep contributions free of third-party runtime dependencies.

## Install (unpacked)

Load the extension directly from this folder:

1. Clone this repo or download and extract its ZIP archive.
2. Open `chrome://extensions` in Chrome or `brave://extensions` in Brave.
3. Toggle **Developer mode** on.
4. Click **Load unpacked** and select this folder.

After pulling an update, click **Reload** on the extension's card on that same page.

## Using tab groups

Right-click a tab and choose **Add tab to new group** to create your first group.
Click the group's label to expand or collapse it. New tabs join whichever group
you leave expanded in that window.

You can keep every group collapsed. With no expanded group, the extension leaves
new tabs ungrouped. Tabs that already belong to a group keep their membership.
New tabs wait half a second before joining, giving the browser time to assign
tabs reopened from saved groups to their original group.
Once a pending tab is assigned to a group, the extension leaves its placement
alone, including while retrying a temporarily blocked tab edit. Reopening a
saved group keeps it separate from the group you were using.

On install, extension reload, or browser startup, the extension collapses extra
expanded groups. It keeps the active tab's group expanded when possible; otherwise
it keeps the first expanded group it finds in that window.

## URL rules

Click the extension icon to manage URL rules. You can also right-click it and choose **Options**.
Add a group name and list one URL wildcard per line, then click **Save changes**.
Start a line with `#` to disable it; remove `#` to enable it again. Blank lines
are ignored. You can edit or delete groups and move them up or down. The first
matching uncommented line wins, reading groups from top to bottom.
Existing rules are loaded into this layout without changing their priority. The URL checker previews matches, including unsaved edits.

For example:

| URL pattern | Group name |
| --- | --- |
| `https://github.com/ThinkOodle/smart-path-rails/*` | SmartPath |
| `https://app.basecamp.com/3091894/*` | SmartPath |
| `https://3.basecamp.com/3091894/*` | Miami |

Patterns use `*` for any text, including slashes, rather than regex `.*`.
Use `http://`, `https://`, or `*://` for either web scheme. Hosts can be exact,
`*.example.com` (including the bare domain), or `*` for any host. Ports are
optional; omitting a port matches any port. Paths are case-sensitive; hosts
are not. Queries and fragments are ignored. A trailing `/*` also includes
the root path: `/project/*` matches `/project` and its descendants, but not
`/project-other`.

Extension pages are supported with `chrome-extension://*/*` for all extensions,
or `chrome-extension://<extension-id>/*` for one extension. Extension rules also
support path wildcards. The `*://` scheme still matches only HTTP and HTTPS.
Browser-internal pages are supported too: use `brave://extensions/*` or
`chrome://settings/*`, for example. The `brave://` and `chrome://` schemes match
each other, including when Brave reports a page using Chrome's scheme. Use an
exact page name or `*` for all browser pages. Ports are not supported for browser
or extension pages. File URLs cannot be rule targets.
Scheme-wide shortcuts such as `brave://*` and `chrome-extension://*` are accepted
and mean the same as `brave://*/*` and `chrome-extension://*/*`.

A matching rule takes priority over the expanded group. Group names are
case-sensitive. The extension reuses the first group with that name in the
tab's window, or creates one there. A routed active tab expands its group;
a routed background tab leaves an existing group's expansion state alone,
and newly created background groups are collapsed.

Blank and new-tab pages first use the expanded group, then can be routed on
their first web, extension, or browser-page navigation. Later navigation does not move tabs. Pinned tabs,
already grouped tabs, restored groups, and tabs you manually move stay put.
Saving rules does not rearrange existing tabs.

Rules use `chrome.storage.sync`, persist across restarts, and sync when your
browser and account settings enable extension sync. Chrome and Brave keep
separate settings. Save errors, including sync storage limits, appear on the
Options page and leave your edits available to correct or retry.

Disable the extension to return to the browser's usual behavior.

## How it works

The extension uses Manifest V3 and a background service worker:

- `background.js` listens for new tabs and changes to tab groups. It groups new
  tabs and collapses peers when a group expands.
- `chrome.storage.session` remembers the active and previous tab in each window
  while the service worker sleeps. This helps choose a group if several are
  briefly expanded at once.
- `rules.js` shares URL-pattern validation and matching with the Options page.
- `options.html`, `options.css`, and `options.js` provide the rule editor.
- `manifest.json` declares the service worker, permissions, and extension icons.
- `icon.svg` is the editable source for the PNG files in `icons/`.

## Permissions and privacy

The extension requests three permissions:

- `tabs` lets it query tabs and add new tabs to a group.
- `tabGroups` lets it find expanded groups and collapse the others.
- `storage` lets it remember tab IDs for the current browser session and save
  URL rules in browser sync storage. Rules may be synced by your browser.

It has no content scripts, analytics, or network requests. It does not read page
contents or send browsing data anywhere.

## Development

Edit the files and reload the unpacked extension. Install Node.js to run the
automated tests. Use its built-in test runner:

```sh
node --test tests/*.test.cjs
```

The tests simulate browser events to cover group switching, startup, separate
windows, and new tabs. Also check the extension in Chrome or Brave after making
behavior changes.

The manifest's `key` preserves the existing unpacked extension ID when the
checkout moves, keeping its saved rules and browser preferences connected.

To regenerate the icons after editing `icon.svg`, install `rsvg-convert` and run:

```sh
for size in 16 32 48 128; do
  rsvg-convert -w "$size" -h "$size" icon.svg -o "icons/icon${size}.png"
done
```
