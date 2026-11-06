const list = document.querySelector('#rules');
const editor = document.querySelector('#editor');
const status = document.querySelector('#status');
let dirty = false;

function message(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}
function readRules() {
  return [...list.children].map((row) => ({
    id: row.dataset.id,
    patterns: row.querySelector('[name=patterns]').value,
    groupName: row.querySelector('[name=groupName]').value.trim(),
  }));
}
function testUrl() {
  const value = document.querySelector('#test-url').value.trim();
  const result = document.querySelector('#test-result');
  if (!value) { result.textContent = ''; return; }
  const rule = UrlRules.firstMatch(readRules(), value);
  result.textContent = rule ? `Matches “${rule.groupName}” (${rule.pattern}).` : 'No matching rule. Uses the expanded group.';
}
function changed() {
  dirty = true;
  message('Unsaved changes.');
  refresh();
}
function refresh() {
  [...list.children].forEach((row, index) => {
    row.setAttribute('aria-label', `Group ${index + 1}`);
    row.querySelector('[data-action=up]').disabled = index === 0;
    row.querySelector('[data-action=down]').disabled = index === list.children.length - 1;
  });
  document.querySelector('#empty').hidden = list.children.length > 0;
  testUrl();
}
function addRule(rule = {}) {
  const row = document.querySelector('#rule-template').content.firstElementChild.cloneNode(true);
  row.dataset.id = rule.id || crypto.randomUUID();
  row.querySelector('[name=patterns]').value = rule.patterns || '';
  row.querySelector('[name=groupName]').value = rule.groupName || '';
  row.addEventListener('input', (event) => {
    event.target.setCustomValidity('');
    changed();
  });
  row.addEventListener('click', (event) => {
    const action = event.target.dataset.action;
    if (action === 'delete') row.remove();
    if (action === 'up' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
    if (action === 'down' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
    if (action) changed();
  });
  list.append(row);
  return row;
}
document.querySelector('#add').addEventListener('click', () => {
  const row = addRule();
  changed();
  row.querySelector('[name=groupName]').focus();
});
document.querySelector('#test-url').addEventListener('input', testUrl);
document.querySelector('#settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const rules = readRules();
  for (let index = 0; index < rules.length; index++) {
    const row = list.children[index];
    const name = row.querySelector('[name=groupName]');
    if (!rules[index].groupName) {
      name.setCustomValidity('Enter a group name.');
      name.reportValidity();
      return;
    }
    const input = row.querySelector('[name=patterns]');
    for (const entry of UrlRules.parsePatterns(rules[index].patterns)) {
      if (!entry.enabled) continue;
      try {
        UrlRules.compile(entry.pattern);
      } catch (error) {
        input.setCustomValidity(`Line ${entry.line}: ${error.message}`);
        input.reportValidity();
        return;
      }
    }
  }
  editor.disabled = true;
  try {
    await chrome.storage.sync.set({ urlRules: rules });
    dirty = false;
    message('Rules saved. Changes apply to new tabs immediately.');
  } catch (error) {
    message(`Could not save rules: ${error.message}. Your edits are still here.`, true);
  } finally {
    editor.disabled = false;
  }
});
window.addEventListener('beforeunload', (event) => {
  if (dirty) { event.preventDefault(); event.returnValue = ''; }
});
(async () => {
  try {
    const { urlRules = [] } = await chrome.storage.sync.get('urlRules');
    UrlRules.toGroups(urlRules).forEach(addRule);
    refresh();
    editor.disabled = false;
    message('');
  } catch (error) {
    message(`Could not load rules: ${error.message}. Reload this page to try again.`, true);
  }
})();
