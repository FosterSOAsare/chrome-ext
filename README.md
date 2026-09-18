# Chrome Extensions — Getting Started

A build-first guide for someone who already knows JavaScript and the DOM.

Everything here is **Manifest V3**. Manifest V2 is dead — Chrome stopped running it
in 2024/25 and the Web Store finished removing MV2 extensions on 31 August 2026. If
a tutorial you find mentions `background.page`, `browser_action`, or blocking
`webRequest`, close the tab.

---

## 1. What an extension actually is

Not one program. A small set of **separate JavaScript environments** that share an
origin (`chrome-extension://<your-id>/`) and can only talk by passing messages:

```
        ┌──────────────────────────────────────────────────┐
        │  chrome-extension://<your-id>/                   │
        │                                                  │
        │   service worker        popup.html               │
        │   (no DOM, dies         (dies when closed)       │
        │    when idle)                                    │
        └───────────▲──────────────────────────────────────┘
                    │  chrome.runtime.sendMessage
                    │
        ┌───────────▼──────────────┐
        │  content script          │   runs in the web page's tab,
        │  (page DOM, own JS heap) │   but a separate JS heap
        └──────────────────────────┘
                    │  DOM only
        ┌───────────▼──────────────┐
        │  the page's own scripts  │   invisible to your content script
        └──────────────────────────┘
```

Four rules fall out of that picture, and most beginner bugs break one of them:

1. **The service worker has no DOM.** No `document`, no `window`, no `alert`.
2. **The service worker is not persistent.** It starts on an event and Chrome kills
   it ~30 seconds after it goes idle. Module-level variables do not survive. State
   lives in `chrome.storage`.
3. **A content script shares the page's DOM but not its JavaScript.** You can read
   and change elements; you cannot see the page's `window.myAppState`.
4. **A content script has almost no `chrome.*` access** — just `runtime`, `storage`,
   `i18n`, `dom`. Tabs, cookies, downloads: ask the service worker by message.

What this buys you over a web page: cross-origin `fetch` without CORS, a toolbar
button, other sites' cookies, the tab list, global keyboard shortcuts, and code that
runs on every page the user visits. That power is why permissions and store review
are strict.

---

## 2. Your first extension

Three files in an empty folder. It counts the images on whatever page you're on.

**`manifest.json`** — the only required file. Strict JSON: no comments, no trailing
commas.

```json
{
  "manifest_version": 3,
  "name": "Page stats",
  "version": "1.0.0",
  "description": "Counts images on the current page.",
  "action": { "default_popup": "popup.html" },
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["storage", "activeTab", "scripting"]
}
```

**`popup.html`** — a normal web page that exists only while the popup is open. Note
there is no inline `<script>` and no `onclick=`: extension pages run under a strict
CSP that forbids both.

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { width: 220px; padding: 14px; font: 13px system-ui, sans-serif; }
      .big { font-size: 28px; font-weight: 600; }
    </style>
  </head>
  <body>
    <div class="big" id="count">…</div>
    <div id="detail">counting…</div>
    <!-- type="module" so popup.js can use top-level await -->
    <script type="module" src="popup.js"></script>
  </body>
</html>
```

**`popup.js`**

```js
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

if (!/^https?:/.test(tab.url ?? '')) {
  document.getElementById('detail').textContent = 'Not a normal web page.';
} else {
  // Injected on demand. This needs no host permissions — "activeTab" grants
  // temporary access to the tab the user just invoked us on, with no scary
  // install warning. The function is stringified and re-parsed inside the page,
  // so it cannot close over anything in this file; pass data via `args`.
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({ images: document.images.length, links: document.links.length }),
  });

  document.getElementById('count').textContent = result.images;
  document.getElementById('detail').textContent = `images · ${result.links} links`;
}
```

**`background.js`** — the service worker. Every listener must be registered
synchronously at the top level, or a cold start will miss the event.

```js
chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log('[page-stats] installed:', reason);
});
```

### Load it

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick your folder
4. Pin it: the puzzle-piece icon in the toolbar → pin

Click the icon on any normal web page.

### The dev loop

- Edit a file → `chrome://extensions` → click the **reload** ⟳ on your card.
- Content-script changes also need the **web page** reloaded. Manifest changes
  always need the extension reloaded. Popup changes need only the popup reopened.
- A red **Errors** button appears on the card when something throws. Check it — a
  syntax error in the service worker otherwise fails completely silently.
- Click the **service worker** link on the card to open its console. Careful: having
  that inspector open *keeps the worker alive*, which hides a whole class of
  lifecycle bugs.

---

## 3. Where to go next

The topics that come next, roughly in the order they stop being optional:

- **Architecture** — the contexts in detail, messaging patterns, and the
  service-worker lifecycle rules that break people
- **Manifest & permissions** — every key that matters; `activeTab` vs
  `host_permissions`, optional permissions, keeping install warnings small
- **Content scripts** — match patterns, `run_at`, isolated vs MAIN world, surviving
  SPA navigation, shadow-DOM UI
- **UI surfaces** — options page, side panel, context menus, keyboard commands,
  notifications, offscreen documents
- **Data & network** — `chrome.storage` quotas, CORS from the worker,
  `declarativeNetRequest` (the MV3 replacement for blocking `webRequest`)
- **Tooling** — Vite/CRXJS or WXT, TypeScript, hot reload, testing
- **Publishing** — the Web Store, review, privacy disclosures, staged rollout

## Reference

- [Chrome for Developers — Extensions](https://developer.chrome.com/docs/extensions)
- [API reference](https://developer.chrome.com/docs/extensions/reference/api)
- [Sample extensions](https://github.com/GoogleChrome/chrome-extensions-samples)
- [MDN — Browser extensions](https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions)
