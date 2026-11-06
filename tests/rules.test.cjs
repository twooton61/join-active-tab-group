const assert = require('node:assert/strict');
const test = require('node:test');
require('../rules.js');
const { compile, firstMatch } = globalThis.UrlRules;

test('project wildcard includes the root and descendants, not sibling projects', () => {
  const matches = compile('https://github.com/ThinkOodle/smart-path-rails/*');
  for (const suffix of ['', '/', '/issues/42', '?tab=readme', '/pull/42#discussion']) {
    assert.equal(matches(`https://github.com/ThinkOodle/smart-path-rails${suffix}`), true);
  }
  assert.equal(matches('https://github.com/ThinkOodle/smart-path-rails-other/issues'), false);
  assert.equal(matches('https://github.com/thinkoodle/smart-path-rails/issues'), false);
  assert.equal(matches('https://github.com.evil.com/ThinkOodle/smart-path-rails/'), false);
});

test('scheme, host, subdomains, and ports match explicitly', () => {
  const matches = compile('*://*.example.com/project/*');
  assert.equal(matches('http://example.com/project'), true);
  assert.equal(matches('https://api.example.com:8443/project/1'), true);
  assert.equal(matches('https://notexample.com/project/1'), false);
  assert.equal(matches('ftp://example.com/project/1'), false);
  assert.equal(compile('https://EXAMPLE.com/*')('https://example.com/'), true);
  assert.equal(compile('https://*/*')('https://elsewhere.com/'), true);
  assert.equal(compile('https://example.com:443/*')('https://example.com/'), true);
  assert.equal(compile('http://localhost:3000/*')('http://localhost:3001/'), false);
});

test('only asterisks are wildcards; URL queries and fragments are ignored', () => {
  const matches = compile('https://example.com/a+b/*/file.txt');
  assert.equal(matches('https://example.com/a+b/x/y/file.txt?foo=bar#fragment'), true);
  assert.equal(matches('https://example.com/ab/x/fileXtxt'), false);
  assert.equal(compile('https://example.com/file.*')('https://example.com/file.txt'), true);
  assert.equal(compile('https://example.com/.*')('https://example.com/project'), false);
});

test('extension rules match all extensions or one ID and path', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  const otherId = 'ponmlkjihgfedcbaponmlkjihgfedcba';
  const all = compile('chrome-extension://*/*');
  for (const host of [id, otherId]) {
    assert.equal(all(`chrome-extension://${host}/options.html?tab=rules#editor`), true);
  }
  const specific = compile(`chrome-extension://${id}/pages/*`);
  assert.equal(specific(`chrome-extension://${id}/pages`), true);
  assert.equal(specific(`chrome-extension://${id}/pages/options.html?tab=rules#editor`), true);
  assert.equal(specific(`chrome-extension://${otherId}/pages/options.html`), false);
  assert.equal(specific(`chrome-extension://${id}/other/options.html`), false);
  assert.equal(specific(`chrome-extension://${id}/Pages/options.html`), false);
  assert.equal(all(`https://${id}/options.html`), false);
  assert.equal(compile('*://*/*')(`chrome-extension://${id}/options.html`), false);
  for (const url of ['chrome://settings/', 'brave://settings/', 'file:///options.html', 'about:blank']) {
    assert.equal(all(url), false);
  }
  assert.equal(firstMatch([
    { groupName: 'Web', patterns: '*://*/*' },
    { groupName: 'Oodle', patterns: 'chrome-extension://*/*' },
  ], `chrome-extension://${id}/options.html`).groupName, 'Oodle');
});

test('extension rules require a path and an ID or wildcard without a port', () => {
  for (const pattern of ['chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'chrome-extension://example.com/*',
    'chrome-extension://*.abcdefghijklmnopabcdefghijklmnop/*',
    'chrome-extension://*:80/*', 'chrome-extension://*:*/options.html']) {
    assert.throws(() => compile(pattern), undefined, pattern);
  }
});

test('scheme-wide shortcuts validate and match the exact multiline Oodle rules', () => {
  const patterns = 'brave://*\nchrome-extension://*';
  for (const entry of UrlRules.parsePatterns(patterns)) {
    assert.doesNotThrow(() => compile(entry.pattern));
  }
  const rules = [{ groupName: 'Oodle', patterns }];
  for (const url of ['brave://extensions', 'chrome://extensions/', 'brave://settings/privacy',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html?tab=rules#editor']) {
    assert.equal(firstMatch(rules, url).groupName, 'Oodle', url);
  }
  for (const url of ['https://example.com/', 'file:///options.html', 'about:blank']) {
    assert.equal(firstMatch(rules, url), undefined, url);
  }
  for (const scheme of ['http', 'https', '*', 'chrome', 'brave', 'chrome-extension']) {
    const short = compile(`${scheme}://*`);
    const full = compile(`${scheme}://*/*`);
    for (const url of ['http://example.com/a', 'https://example.com/b', 'chrome://extensions',
      'brave://settings/', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html']) {
      assert.equal(short(url), full(url), `${scheme}: ${url}`);
    }
  }
  assert.throws(() => compile('ftp://*'));
});

test('browser-page rules match Chrome and Brave aliases, roots, and paths', () => {
  for (const scheme of ['chrome', 'brave']) {
    const matches = compile(`${scheme}://extensions/*`);
    for (const actual of ['chrome', 'brave']) {
      for (const suffix of ['', '/', '/shortcuts', '?id=example', '/shortcuts#keys']) {
        assert.equal(matches(`${actual}://extensions${suffix}`), true);
      }
      assert.equal(matches(`${actual}://settings/`), false);
      assert.equal(matches(`${actual}://extensions-other/`), false);
      assert.equal(compile(`${scheme}://settings/privacy/*`)(`${actual}://settings/privacy`), true);
      assert.equal(compile(`${scheme}://*/*`)(`${actual}://settings/`), true);
      assert.equal(compile('*://*/*')(`${actual}://extensions/`), false);
    }
    for (const url of ['https://extensions/', 'file:///extensions/',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html']) {
      assert.equal(matches(url), false);
    }
    for (const pattern of [`${scheme}://extensions`, `${scheme}://extensions:80/*`,
      `${scheme}://*.extensions/*`]) {
      assert.throws(() => compile(pattern), undefined, pattern);
    }
  }
});

test('invalid patterns produce validation errors', () => {
  for (const pattern of ['', 'example.com/*', 'ftp://example.com/*', 'https://exa*mple.com/*',
    'https://example.com', 'https://user@example.com/*',
    'https://example.com:99999/*', 'https://example.com/*?q=x']) {
    assert.throws(() => compile(pattern), undefined, pattern);
  }
});

test('first enabled valid match wins and corrupt rules are ignored', () => {
  const rules = [
    { pattern: 'bad', groupName: 'Invalid' },
    { pattern: 'https://example.com/*', groupName: 'Disabled', enabled: false },
    { pattern: 'https://example.com/*', groupName: '  Project  ', enabled: true },
    { pattern: '*://*/*', groupName: 'Fallback', enabled: true },
  ];
  assert.equal(firstMatch(rules, 'https://example.com/a').groupName, 'Project');
  assert.equal(firstMatch(rules.reverse(), 'https://example.com/a').groupName, 'Fallback');
  assert.equal(firstMatch({}, 'https://example.com/'), undefined);
});

test('multiline patterns ignore blanks and disable lines with a leading #', () => {
  const patterns = '\n https://example.com/one/*\r\n  # https://example.com/two/*\n# notes\n\n';
  assert.deepEqual(UrlRules.parsePatterns(patterns), [
    { pattern: 'https://example.com/one/*', enabled: true, line: 2 },
    { pattern: 'https://example.com/two/*', enabled: false, line: 3 },
    { pattern: 'notes', enabled: false, line: 4 },
  ]);
  const rules = [{ groupName: 'Project', patterns }];
  assert.equal(firstMatch(rules, 'https://example.com/one/42').groupName, 'Project');
  assert.equal(firstMatch(rules, 'https://example.com/two/42'), undefined);
});

test('groups and lines are evaluated in displayed order', () => {
  const rules = [
    { groupName: 'First', patterns: '# https://example.com/*\nhttps://example.com/specific/*' },
    { groupName: 'Second', patterns: 'https://example.com/*\nhttps://elsewhere.com/*' },
  ];
  assert.equal(firstMatch(rules, 'https://example.com/specific/42').groupName, 'First');
  assert.equal(firstMatch(rules, 'https://example.com/other').groupName, 'Second');
  assert.equal(firstMatch(rules, 'https://elsewhere.com/').groupName, 'Second');
});

test('legacy migration combines adjacent names and preserves disabled URLs', () => {
  const rules = [
    { id: 'a', groupName: 'SmartPath', pattern: 'https://github.com/project/*' },
    { id: 'b', groupName: 'SmartPath', pattern: 'https://app.basecamp.com/3091894/*', enabled: false },
    { id: 'c', groupName: 'Miami', pattern: 'https://3.basecamp.com/3091894/*' },
  ];
  assert.deepEqual(UrlRules.toGroups(rules), [
    { id: 'a', groupName: 'SmartPath', patterns: 'https://github.com/project/*\n# https://app.basecamp.com/3091894/*' },
    { id: 'c', groupName: 'Miami', patterns: 'https://3.basecamp.com/3091894/*' },
  ]);
});

test('migration preserves overlapping priorities when group names are interleaved', () => {
  const legacy = [
    { groupName: 'A', pattern: 'https://example.com/special/*' },
    { groupName: 'B', pattern: 'https://example.com/*' },
    { groupName: 'A', pattern: 'https://*/*' },
  ];
  const migrated = UrlRules.toGroups(legacy);
  assert.equal(migrated.length, 3);
  for (const url of ['https://example.com/special/1', 'https://example.com/other', 'https://other.com/']) {
    assert.equal(firstMatch(migrated, url).groupName, firstMatch(legacy, url).groupName);
  }
});

test('saved group text retains comments, whitespace, and blank lines on reload', () => {
  const rules = [{ id: 'a', groupName: 'Project', patterns: '# Notes\n\n https://example.com/*\n' }];
  assert.deepEqual(UrlRules.toGroups(rules), rules);
});


test('previously saved duplicate group sections combine into one textarea', () => {
  const groups = [
    { id: 'a', groupName: 'SmartPath', patterns: 'https://github.com/project/*' },
    { id: 'b', groupName: 'SmartPath', patterns: '# disabled\nhttps://app.basecamp.com/3091894/*' },
    { id: 'c', groupName: 'Miami', patterns: 'https://miamioh.edu/*' },
  ];
  const merged = UrlRules.toGroups(groups);
  assert.deepEqual(merged, [
    { id: 'a', groupName: 'SmartPath', patterns: 'https://github.com/project/*\n# disabled\nhttps://app.basecamp.com/3091894/*' },
    groups[2],
  ]);
  assert.deepEqual(UrlRules.toGroups(merged), merged);
});

test('mixed legacy and grouped entries with the same name combine', () => {
  assert.deepEqual(UrlRules.toGroups([
    { id: 'a', groupName: 'SmartPath', patterns: 'https://example.com/*' },
    { id: 'b', groupName: ' SmartPath ', pattern: 'https://other.com/*', enabled: false },
  ]), [{ id: 'a', groupName: 'SmartPath', patterns: 'https://example.com/*\n# https://other.com/*' }]);
});
