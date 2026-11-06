// Shared by the service worker and Options page. No third-party dependencies.
globalThis.UrlRules = (() => {
  function compile(pattern) {
    // A scheme-wide wildcard is a convenient shorthand for every host and path.
    const normalized = pattern.endsWith('://*') ? `${pattern}/*` : pattern;
    const parts = /^(https?|chrome-extension|chrome|brave|\*):\/\/([^/]+)(\/[^?#]*)$/.exec(normalized);
    if (!parts) throw new Error('Use http://, https://, *://, chrome-extension://, chrome://, or brave://, a host, and a path (e.g. /*).');
    const [, scheme, authority, path] = parts;
    const hostParts = /^(\*|(?:\*\.)?[^:*\s]+)(?::(\*|\d+))?$/.exec(authority);
    if (!hostParts) throw new Error('Use an exact host, *.example.com, or *.');
    const host = hostParts[1].toLowerCase();
    const baseHost = host.startsWith('*.') ? host.slice(2) : host;
    const internal = scheme === 'chrome' || scheme === 'brave';
    if (internal && (hostParts[2] || host.startsWith('*.'))) {
      throw new Error('Use an exact page name or * without a port for browser-internal pages.');
    }
    if (scheme === 'chrome-extension' && (hostParts[2] || (host !== '*' && !/^[a-p]{32}$/.test(host)))) {
      throw new Error('Use an extension ID or * without a port for chrome-extension://.');
    }
    if (baseHost !== '*') {
      let parsed;
      try { parsed = new URL(`https://${baseHost}/`); } catch { /* handled below */ }
      if (!parsed || parsed.hostname !== baseHost || parsed.username || parsed.password) {
        throw new Error('Enter a valid hostname.');
      }
    }
    const port = hostParts[2];
    if (port && port !== '*' && Number(port) > 65535) throw new Error('Port must be 0 through 65535.');
    const escaped = path.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    const pathRegex = new RegExp(`^${escaped}$`);
    const root = path.endsWith('/*') ? path.slice(0, -2) : null;
    return (value) => {
      let url;
      try { url = new URL(value); } catch { return false; }
      // Keep *:// limited to web pages so existing catch-all rules do not
      // start matching extension or browser-internal pages after an update.
      // Brave may expose its internal URLs with Chrome's scheme in tab events.
      if (internal) {
        if (!['chrome:', 'brave:'].includes(url.protocol)) return false;
      } else if (scheme === '*' ? !['http:', 'https:'].includes(url.protocol) : url.protocol !== `${scheme}:`) return false;
      const hostname = url.hostname.toLowerCase();
      if (host !== '*' && hostname !== baseHost && !(host.startsWith('*.') && hostname.endsWith(`.${baseHost}`))) return false;
      const actualPort = url.port || (url.protocol === 'https:' ? '443' : '80');
      if (port && port !== '*' && Number(port) !== Number(actualPort)) return false;
      return pathRegex.test(url.pathname) || url.pathname === root;
    };
  }

  function parsePatterns(text) {
    return text.split(/\r?\n/).map((text, index) => {
      const trimmed = text.trim();
      const enabled = !trimmed.startsWith('#');
      return { pattern: (enabled ? trimmed : trimmed.slice(1)).trim(), enabled, line: index + 1 };
    }).filter((entry) => entry.pattern);
  }

  // Older versions stored one rule per URL or duplicate group sections. Merge
  // consecutive entries for
  // the same group so migration never changes priority between overlapping URLs.
  function toGroups(rules) {
    if (!Array.isArray(rules)) return [];
    const groups = [];
    for (const rule of rules) {
      if (!rule || typeof rule.groupName !== 'string') continue;
      const patterns = typeof rule.patterns === 'string' ? rule.patterns
        : typeof rule.pattern === 'string' ? `${rule.enabled === false ? '# ' : ''}${rule.pattern}` : null;
      if (patterns === null) continue;
      const previous = groups.at(-1);
      if (previous && previous.groupName.trim() === rule.groupName.trim()) {
        previous.patterns += `${previous.patterns && patterns ? '\n' : ''}${patterns}`;
      } else {
        groups.push({ id: rule.id, groupName: rule.groupName, patterns });
      }
    }
    return groups;
  }

  function firstMatch(rules, url) {
    if (!Array.isArray(rules)) return undefined;
    for (const rule of rules) {
      if (!rule || rule.enabled === false || typeof rule.groupName !== 'string' || !rule.groupName.trim()) continue;
      try {
        const patterns = typeof rule.patterns === 'string'
          ? parsePatterns(rule.patterns) : [{ pattern: rule.pattern, enabled: true }];
        for (const entry of patterns) {
          if (!entry.enabled) continue;
          try {
            if (compile(entry.pattern)(url)) return { ...rule, pattern: entry.pattern, groupName: rule.groupName.trim() };
          } catch { /* Skip invalid lines without hiding later valid patterns. */ }
        }
      } catch { /* Ignore invalid rules from older versions or other devices. */ }
    }
  }
  return { compile, firstMatch, parsePatterns, toGroups };
})();
