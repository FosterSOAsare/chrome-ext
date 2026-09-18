// SELECTION BUBBLE — all the behaviour, as one class.
//
// Same trick as ui.js: the manifest injects this file before content.js, and all
// content-script files in a frame share one global scope. So `class
// SelectionBubble` declared here is visible to content.js without any import.
//
// Nothing runs when this file loads. It only *defines* the class — content.js
// decides when to create one and start it.

class SelectionBubble {
  /**
   * @param {string} template  HTML for the shadow root (UI_HTML, from ui.js)
   */
  constructor(template) {
    this.template = template;

    // DOM handles, filled in by mount()
    this.host = null;
    this.wrap = null;
    this.trigger = null;
    this.card = null;
    this.result = null;
    this.quote = null;

    // State
    this.state = 'hidden';    // 'hidden' | 'collapsed' | 'expanded'
    this.text = '';           // the currently selected text, kept for read-aloud
    this.anchor = null;       // last selection rect, in viewport coordinates
    this.holdOpen = false;    // a click landed on our own UI
    this.frameQueued = false; // a reposition is already scheduled for next frame

    this.gap = 10;            // px between the selection and the UI
  }

  // ---------------------------------------------------------------- lifecycle

  /** Attach the page listeners. Call once. */
  start() {
    document.addEventListener('mouseup', this.handleMouseUp, true);
    document.addEventListener('mousedown', this.handleMouseDown, true);
    document.addEventListener('keyup', this.handleKeyUp, true);
    document.addEventListener('keydown', this.handleKeyDown, true);
    document.addEventListener('scroll', this.handleReposition, { capture: true, passive: true });
    window.addEventListener('resize', this.handleReposition, { passive: true });
  }

  /**
   * Detach everything and remove the UI from the page.
   */
  stop() {
    document.removeEventListener('mouseup', this.handleMouseUp, true);
    document.removeEventListener('mousedown', this.handleMouseDown, true);
    document.removeEventListener('keyup', this.handleKeyUp, true);
    document.removeEventListener('keydown', this.handleKeyDown, true);
    document.removeEventListener('scroll', this.handleReposition, { capture: true });
    window.removeEventListener('resize', this.handleReposition);
    this.host?.remove();
    this.host = null;
    this.state = 'hidden';
  }

  // --------------------------------------------------------------------- DOM

  /** Build the shadow-root UI on first use. Idempotent. */
  mount() {
    if (this.host) return;

    this.host = document.createElement('div');
    // `all: initial` on the host stops the page's CSS cascading in. Fixed
    // positioning lets us use viewport coordinates straight from
    // getBoundingClientRect(). 2147483647 is the maximum z-index.
    this.host.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647; display: none;';

    // A closed shadow root: the page's stylesheets can't leak in, and the page's
    // scripts can't walk into our UI via host.shadowRoot.
    const root = this.host.attachShadow({ mode: 'closed' });
    root.innerHTML = this.template;

    this.wrap = root.querySelector('.wrap');
    this.trigger = root.querySelector('.trigger');
    this.card = root.querySelector('.card');
    this.quote = root.querySelector('.quote');
    this.speakBtn = root.querySelector('.speak');
    this.translateBtn = root.querySelector('.translate');
    this.result = root.querySelector('.result');
    this.resultTag = root.querySelector('.tag');
    this.resultText = root.querySelector('.result-text');

    // These buttons live inside the shadow root, so listen for their clicks
    // here rather than on the document.
    this.trigger.addEventListener('click', () => this.expand());
    this.speakBtn.addEventListener('click', () => this.toggleSpeech());
    this.translateBtn.addEventListener('click', () => this.translate());

    // documentElement, not body — body may not exist yet on some pages, and this
    // keeps us clear of body-level layout rules.
    document.documentElement.append(this.host);
  }

  // --------------------------------------------------- reading the selection

  /** @returns {{text: string, rect: DOMRect} | null} */
  readSelection() {
    const el = document.activeElement;

    // Gotcha: window.getSelection() returns nothing for text selected inside an
    // <input> or <textarea>. Those keep their own selection offsets.
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      const { selectionStart: start, selectionEnd: end, value } = el;
      if (start == null || end == null || end <= start) return null;
      const text = value.slice(start, end).trim();
      // No per-character rect available here, so anchor to the field itself.
      return text ? { text, rect: el.getBoundingClientRect() } : null;
    }

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    const text = sel.toString().trim();
    if (!text) return null;

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;

    return { text, rect };
  }

  // ------------------------------------------------------------- positioning

  /** Position whichever element is currently visible against this.anchor. */
  place() {
    if (!this.anchor) return;

    const el = this.state === 'expanded' ? this.card : this.trigger;
    const { offsetWidth: w, offsetHeight: h } = el;

    let top = this.anchor.top - h - this.gap;
    let side = 'top';

    if (top < 4) {                        // no room above? flip below the selection
      top = this.anchor.bottom + this.gap;
      side = 'bottom';
    }

    // Centre on the selection, then clamp so it can't hang off screen.
    const left = Math.max(4, Math.min(
      this.anchor.left + this.anchor.width / 2 - w / 2,
      window.innerWidth - w - 4,
    ));

    this.wrap.dataset.side = side;
    this.host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  // -------------------------------------------------------- state transitions

  /** Selection exists: show the collapsed icon button. */
  showTrigger({ text, rect }) {
    this.mount();

    this.quote.textContent = text;
    this.clearResult();          // a new selection invalidates the old translation

    this.text = text;
    this.anchor = rect;
    this.state = 'collapsed';
    this.wrap.dataset.state = 'collapsed';

    // Speech carries on after the bubble is dismissed, so the button may be out
    // of date by the time we show it again.
    this.syncSpeechButton();

    // Make it visible before measuring — offsetWidth is 0 on a display:none node.
    this.host.style.display = 'block';
    this.place();
  }

  /** Button clicked: swap to the card. */
  expand() {
    if (this.state === 'hidden') return;
    this.state = 'expanded';
    this.wrap.dataset.state = 'expanded';
    this.place();     // re-measure: the card is much bigger than the button
  }

  hide() {
    this.state = 'hidden';
    if (this.host) this.host.style.display = 'none';
  }

  // ------------------------------------------------------------ read aloud
  //
  // speechSynthesis is a plain web API, so this works straight from a content
  // script — no permission, no manifest entry, no service worker. The catch is
  // that it belongs to the page: navigating away cuts it off mid-sentence, and
  // a page that calls speechSynthesis.cancel() itself will stop us too.

  toggleSpeech() {
    speechSynthesis.speaking ? this.stopSpeech() : this.speak();
  }

  speak() {
    if (!this.text) return;

    // Always cancel first. Calling speak() twice queues a second utterance
    // rather than replacing the first, so without this you'd hear both.
    speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(this.text);

    // Fires when it finishes normally, and when cancel() stops it early.
    utterance.onend = () => this.syncSpeechButton();
    utterance.onerror = () => this.syncSpeechButton();

    speechSynthesis.speak(utterance);
    this.syncSpeechButton();
  }

  stopSpeech() {
    speechSynthesis.cancel();
    this.syncSpeechButton();
  }

  /** Point the button at reality rather than tracking state ourselves. */
  syncSpeechButton() {
    if (!this.speakBtn) return;
    const speaking = speechSynthesis.speaking;
    const label = speaking ? 'Stop' : 'Read aloud';

    this.speakBtn.dataset.on = String(speaking);
    // Icon-only button, so the label lives in the tooltip and for screen readers.
    this.speakBtn.setAttribute('aria-label', label);
    this.speakBtn.title = label;
  }

  // -------------------------------------------------------------- translate
  //
  // Chrome's built-in Translator API (Chrome 138+). The model runs on-device, so
  // there's no API key and no network call — but the language pack downloads on
  // first use, and creating a translator requires a recent user gesture, which
  // the button click provides. It can't run in a service worker, so this has to
  // live here in the content script.

  async translate() {
    if (!this.text) return;

    if (!('Translator' in self)) {
      this.showResult('Needs Chrome 138 or newer for built-in translation.', { error: true });
      return;
    }

    this.translateBtn.dataset.busy = 'true';
    this.showResult('Translating…');

    try {
      const source = await this.detectLanguage(this.text);
      const target = this.pickTargetLanguage(source);

      const pair = { sourceLanguage: source, targetLanguage: target };
      if (await Translator.availability(pair) === 'unavailable') {
        this.showResult(`Can't translate ${source} → ${target}.`, { error: true });
        return;
      }

      const translator = await Translator.create({
        ...pair,
        // Fires only when the language pack has to be fetched. Can take a while
        // the first time, so say something rather than looking frozen.
        monitor: (m) => m.addEventListener('downloadprogress', (e) => {
          this.showResult(`Downloading language pack… ${Math.round(e.loaded * 100)}%`);
        }),
      });

      const output = await translator.translate(this.text);
      translator.destroy?.();

      this.showResult(output, { tag: `${source} → ${target}` });
    } catch (err) {
      this.showResult(err?.message || 'Translation failed.', { error: true });
    } finally {
      this.translateBtn.dataset.busy = 'false';
    }
  }

  /** Best guess at what language the selection is in. Falls back to English. */
  async detectLanguage(text) {
    if (!('LanguageDetector' in self)) return 'en';
    try {
      const detector = await LanguageDetector.create();
      const [best] = await detector.detect(text);
      detector.destroy?.();
      return best?.detectedLanguage || 'en';
    } catch {
      return 'en';
    }
  }

  /**
   * Translate into the browser's own language — unless the text is already in
   * it, in which case go to Spanish so the button always does something visible.
   */
  pickTargetLanguage(source) {
    const ui = (chrome.i18n?.getUILanguage?.() || navigator.language || 'en').split('-')[0];
    if (source !== ui) return ui;
    return source === 'es' ? 'en' : 'es';
  }

  // ------------------------------------------------------------ result panel

  showResult(text, { error = false, tag = '' } = {}) {
    if (!this.result) return;

    this.resultText.textContent = text;
    this.result.dataset.error = String(error);
    this.resultTag.textContent = tag;
    this.resultTag.hidden = !tag;
    this.result.hidden = false;

    // The card just changed height, so it needs repositioning against the text.
    this.place();
  }

  clearResult() {
    if (!this.result) return;
    this.result.hidden = true;
    this.resultTag.hidden = true;
    this.resultText.textContent = '';
    this.result.dataset.error = 'false';
  }

  /** Re-read the selection and show or hide accordingly. */
  update() {
    // A click on our UI clears the page's text selection as a side effect.
    // Without this guard the mouseup that follows would find no selection and
    // hide everything the instant you touched it.
    console.log("Check open state: ", this.holdOpen);
    // I
    if (this.holdOpen) {
      this.holdOpen = false;
      return;
    }
    const sel = this.readSelection();
    sel ? this.showTrigger(sel) : this.hide();
  }

  // ------------------------------------------------------------ event handlers
  //
  // These are arrow-function class fields, not regular methods, and that is
  // deliberate. A regular method passed to addEventListener loses its `this` —
  // the browser calls it with `this` set to the element that fired the event, so
  // `this.state` would be undefined. An arrow function captures `this` from the
  // instance at construction time, so it stays bound no matter who calls it.

  /** Selection isn't final until after mouseup is processed, so defer a tick. */
  handleMouseUp = () => {
    setTimeout(() => this.update(), 0);
  };

  /** Click away to dismiss — but not when the click is on our own UI. */
  handleMouseDown = (e) => {
    // composedPath() sees through the shadow boundary; contains() would not.
    if (this.host && e.composedPath().includes(this.host)) {
      // preventDefault stops the browser collapsing the text selection, which
      // is what keeps the bubble anchored while you interact with it.
      e.preventDefault();
      this.holdOpen = true;
      return;
    }
    this.hide();
  };

  /** Keyboard selection: shift+arrows, ctrl/cmd+A. */
  handleKeyUp = (e) => {
    if (e.key === 'Shift' || e.key.startsWith('Arrow') || e.key === 'a' || e.key === 'A') {
      setTimeout(() => this.update(), 0);
    }
  };

  handleKeyDown = (e) => {
    // Escape is the way out of both: it dismisses the bubble and, since speech
    // outlives the bubble, silences it too.
    if (e.key === 'Escape') {
      this.hide();
      this.stopSpeech();
    }
  };

  /**
   * The rect we positioned against is viewport-relative, so it goes stale on
   * scroll. Re-measure on the next frame instead of leaving the UI stranded.
   */
  handleReposition = () => {
    if (this.frameQueued || this.state === 'hidden') return;
    this.frameQueued = true;
    requestAnimationFrame(() => {
      this.frameQueued = false;
      const sel = this.readSelection();
      if (sel) this.anchor = sel.rect;  // keep the last anchor if selection is gone
      this.place();
    });
  };
}


// FLOW
//  For the mouse stuff. This is how it works 
// whenever we press down on the mouse, we set the holdOpen to true if host exists
// On mouse release, we check if holdOpen is true, if it is, we set it to false and return.