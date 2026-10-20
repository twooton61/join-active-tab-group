# join-active-tab-group

![New tabs join the expanded group](icons/icon128.png)

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

On install, extension reload, or browser startup, the extension collapses extra
expanded groups. It keeps the active tab's group expanded when possible; otherwise
it keeps the first expanded group it finds in that window.

There are no settings to configure. Disable the extension to return to the
browser's usual behavior.

## How it works

The extension uses Manifest V3 and a background service worker:

- `background.js` listens for new tabs and changes to tab groups. It groups new
  tabs and collapses peers when a group expands.
- `chrome.storage.session` remembers the active and previous tab in each window
  while the service worker sleeps. This helps choose a group if several are
  briefly expanded at once.
- `manifest.json` declares the service worker, permissions, and extension icons.
- `icon.svg` is the editable source for the PNG files in `icons/`.

## Permissions and privacy

The extension requests three permissions:

- `tabs` lets it query tabs and add new tabs to a group.
- `tabGroups` lets it find expanded groups and collapse the others.
- `storage` lets it remember tab IDs for the current browser session.

It has no content scripts, analytics, or network requests. It does not read page
contents or send browsing data anywhere.

## Development

Edit the files and reload the unpacked extension. Install Node.js to run the
automated tests. Use its built-in test runner:

```sh
node --test tests/background.test.cjs
```

The tests simulate browser events to cover group switching, startup, separate
windows, and new tabs. Also check the extension in Chrome or Brave after making
behavior changes.

To regenerate the icons after editing `icon.svg`, install `rsvg-convert` and run:

```sh
for size in 16 32 48 128; do
  rsvg-convert -w "$size" -h "$size" icon.svg -o "icons/icon${size}.png"
done
```
