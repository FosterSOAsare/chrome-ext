// SELECTION BUBBLE — all the behaviour, as one class.
//
// Same trick as ui.js: the manifest injects this file before content.js, and all
// content-script files in a frame share one global scope. So `class
// SelectionBubble` declared here is visible to content.js without any import.
//
// Nothing runs when this file loads. It only *defines* the class — content.js
// decides when to create one and start it.

// The languages offered in the picker. Keys are BCP 47 codes, which is what the
// Translator API expects; the values are only used in messages.
const LANGUAGES = { en: 'English', fr: 'French', es: 'Spanish' };

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
    this.sourceLang = null;   // detected language of this.text, cached per selection
    this.langPromise = null;  // in-flight detection, so concurrent callers share one
    this.targetLang = null;   // language the current translation is in
    this.speakingFor = null;  // 'source' | 'result' | null — which button is talking
    this.speechToken = 0;     // bumped per utterance, to ignore stale onend events
    this.speechRate = 1;      // from chrome.storage.sync, set by the popup
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

    // Nudge the browser into loading the voice list now. The first getVoices()
    // call returns an empty array and populates asynchronously, so asking early
    // means a voice is available by the time anyone presses speak.
    speechSynthesis.getVoices();

    // chrome.storage is one of the few extension APIs a content script gets
    // directly — no message to the service worker needed.
    chrome.storage.sync.get({ speechRate: 1 })
      .then(({ speechRate }) => { this.speechRate = speechRate; });

    // Keep it live: changing the slider in the popup updates every open tab,
    // rather than only taking effect on the next page load.
    chrome.storage.onChanged.addListener(this.handleStorageChange);
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
    chrome.storage.onChanged.removeListener(this.handleStorageChange);
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
    this.speakBtn = root.querySelector('.actions .speak');
    this.resultSpeakBtn = root.querySelector('.speak-result');
    this.translateBtn = root.querySelector('.translate');
    this.langs = root.querySelector('.langs');
    this.langsLabel = root.querySelector('.langs-label');
    this.result = root.querySelector('.result');
    this.resultTag = root.querySelector('.tag');
    this.resultText = root.querySelector('.result-text');

    // These buttons live inside the shadow root, so listen for their clicks
    // here rather than on the document.
    this.trigger.addEventListener('click', () => this.expand());
    this.speakBtn.addEventListener('click', () => this.toggleSpeech('source'));
    this.resultSpeakBtn.addEventListener('click', () => this.toggleSpeech('result'));
    this.translateBtn.addEventListener('click', () => this.toggleLangPicker());

    // One listener on the row instead of three on the buttons — the click
    // bubbles up from whichever pill was pressed and we read its data-lang.
    this.langs.addEventListener('click', (e) => {
      const pill = e.target.closest('.lang');
      if (pill) this.translateTo(pill.dataset.lang);
    });

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
    this.syncSpeechButtons();

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

    // Start detecting in the background. Both the speak button and the language
    // picker want this, and doing it now means neither has to wait later —
    // which also keeps the speak click inside its user-activation window.
    this.ensureSourceLanguage();
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

  /** @param {'source'|'result'} which  the original selection, or the translation */
  toggleSpeech(which) {
    // Pressing the button that's already talking stops it. Pressing the other
    // one can't happen — it's disabled while the first is going.
    if (this.speakingFor === which) {
      this.stopSpeech();
      return;
    }
    this.speak(which);
  }

  async speak(which) {
    const text = which === 'result' ? this.resultText.textContent : this.text;
    if (!text) return;

    // The translation's language is known outright. The original's has to be
    // detected — usually already done by expand(), so this resolves instantly.
    const lang = which === 'result'
      ? this.targetLang
      : await this.ensureSourceLanguage();

    // Always cancel first. Calling speak() twice queues a second utterance
    // rather than replacing the first, so without this you'd hear both.
    speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = this.speechRate;

    // Without this a French selection gets read out by an English voice, which
    // is unintelligible. Setting `lang` asks the browser to match; naming the
    // voice outright is more reliable when we can find one.
    if (lang) {
      utterance.lang = lang;
      const voice = this.pickVoice(lang);
      if (voice) utterance.voice = voice;
    }

    // cancel() above makes the PREVIOUS utterance fire onend, and it can land
    // after this new one has started. The token tells us whether the event
    // belongs to the utterance that's currently playing.
    const token = ++this.speechToken;
    const finish = () => {
      if (token !== this.speechToken) return;   // stale event, ignore it
      this.speakingFor = null;
      this.syncSpeechButtons();
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    this.speakingFor = which;
    speechSynthesis.speak(utterance);
    this.syncSpeechButtons();
  }

  /**
   * First voice whose language matches, comparing only the base code so that
   * 'fr' matches 'fr-FR' and 'fr-CA'.
   *
   * getVoices() is empty until the browser has loaded the list, which is why
   * start() touches it early. If it's still empty we return null and fall back
   * to utterance.lang alone.
   */
  pickVoice(lang) {
    const base = lang.split('-')[0].toLowerCase();
    const voices = speechSynthesis.getVoices();
    return voices.find((v) => v.lang.toLowerCase().startsWith(base)) || null;
  }

  stopSpeech() {
    this.speechToken++;          // invalidate any onend still in flight
    speechSynthesis.cancel();
    this.speakingFor = null;
    this.syncSpeechButtons();
  }

  /** One button shows Stop, the other greys out. Neither, when it's quiet. */
  syncSpeechButtons() {
    const pairs = [
      ['source', this.speakBtn, 'Read aloud'],
      ['result', this.resultSpeakBtn, 'Read translation'],
    ];

    for (const [which, btn, idleLabel] of pairs) {
      if (!btn) continue;

      const active = this.speakingFor === which;
      const label = active ? 'Stop' : idleLabel;

      btn.dataset.on = String(active);
      btn.disabled = this.speakingFor !== null && !active;

      // Icon-only buttons, so the label lives in the tooltip and for screen readers.
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
  }

  // -------------------------------------------------------------- translate
  //
  // Chrome's built-in Translator API (Chrome 138+). The model runs on-device, so
  // there's no API key and no network call — but the language pack downloads on
  // first use, and creating a translator requires a recent user gesture, which
  // the button click provides. It can't run in a service worker, so this has to
  // live here in the content script.

  /** The translate button just opens and closes the language picker. */
  toggleLangPicker() {
    const open = this.langs.hidden;
    this.langs.hidden = !open;
    this.translateBtn.dataset.on = String(open);
    this.place();        // the card just changed height

    // Detection is async and may need to fetch a model, so the picker opens
    // straight away and the options narrow a moment later.
    if (open) this.refreshLangOptions();
  }

  /**
   * Work out what language the selection is in and drop that option from the
   * picker — there's no point offering to translate English into English.
   */
  async refreshLangOptions() {
    this.langsLabel.textContent = 'Detecting language…';

    const source = await this.ensureSourceLanguage();

    // The user may have closed the picker or moved on while we were waiting.
    if (this.langs.hidden) return;

    this.langsLabel.textContent = source
      ? `Translate from ${this.languageName(source)} to`
      : 'Translate to';

    for (const pill of this.langs.querySelectorAll('.lang')) {
      pill.hidden = pill.dataset.lang === source;
    }

    this.place();        // one fewer pill can change the card's width
  }

  /**
   * Detect once per selection, then reuse the answer.
   *
   * The in-flight promise is cached as well as the result, so if the picker and
   * the speak button both ask before the first detection finishes, they share
   * one LanguageDetector rather than racing to build two.
   */
  ensureSourceLanguage() {
    if (this.sourceLang !== null) return Promise.resolve(this.sourceLang);

    if (!this.langPromise) {
      this.langPromise = this.detectLanguage(this.text).then((code) => {
        this.sourceLang = code;
        return code;
      });
    }
    return this.langPromise;
  }

  /** 'fr' -> 'French', in whatever language the user reads. */
  languageName(code) {
    try {
      const names = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
      return names.of(code) || LANGUAGES[code] || code;
    } catch {
      return LANGUAGES[code] || code;
    }
  }

  /** A language pill was clicked. This is where the work happens. */
  async translateTo(target) {
    if (!this.text || !target) return;

    if (!('Translator' in self)) {
      this.showResult('Needs Chrome 138 or newer for built-in translation.', { error: true });
      return;
    }

    this.markActiveLang(target);
    this.translateBtn.dataset.busy = 'true';
    this.showResult('Translating…');

    try {
      // Translator.create() needs an explicit source, so if detection came back
      // empty we have to guess something — English is the safest default.
      const source = (await this.ensureSourceLanguage()) || 'en';

      // The picker hides this case, but detection can be wrong on short text.
      if (source === target) {
        this.showResult(`That already looks like ${this.languageName(target)}.`);
        return;
      }

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

      this.targetLang = target;     // so the result's speak button picks the right voice
      this.showResult(output, { tag: `${source} → ${target}`, speakable: true });
    } catch (err) {
      this.showResult(err?.message || 'Translation failed.', { error: true });
    } finally {
      this.translateBtn.dataset.busy = 'false';
    }
  }

  /**
   * Best guess at what language the selection is in, or '' if we couldn't tell.
   * Empty rather than a guess, so a failed detection doesn't wrongly remove an
   * option from the picker.
   */
  async detectLanguage(text) {
    if (!('LanguageDetector' in self)) return '';
    try {
      const detector = await LanguageDetector.create();
      const [best] = await detector.detect(text);
      detector.destroy?.();
      return best?.detectedLanguage || '';
    } catch {
      return '';
    }
  }

  /** Highlight the pill that's currently selected. */
  markActiveLang(target) {
    for (const pill of this.langs.querySelectorAll('.lang')) {
      pill.dataset.active = String(pill.dataset.lang === target);
    }
  }

  // ------------------------------------------------------------ result panel

  showResult(text, { error = false, tag = '', speakable = false } = {}) {
    if (!this.result) return;

    this.resultText.textContent = text;
    this.result.dataset.error = String(error);
    this.resultTag.textContent = tag;
    this.resultTag.hidden = !tag;
    this.result.hidden = false;

    // Only offer to read out a real translation — not "Translating…" or an error.
    this.resultSpeakBtn.hidden = !speakable;

    // The card just changed height, so it needs repositioning against the text.
    this.place();
  }

  /** Back to a clean card: no translation, picker closed, no pill selected. */
  clearResult() {
    if (!this.result) return;

    this.result.hidden = true;
    this.resultTag.hidden = true;
    this.resultSpeakBtn.hidden = true;
    this.resultText.textContent = '';
    this.result.dataset.error = 'false';
    this.targetLang = null;

    this.langs.hidden = true;
    this.langsLabel.textContent = 'Translate to';
    this.translateBtn.dataset.on = 'false';
    this.translateBtn.dataset.busy = 'false';
    this.markActiveLang(null);

    // New selection, new language — drop the cached detection and put every
    // option back before the next detect narrows them again.
    this.sourceLang = null;
    this.langPromise = null;
    for (const pill of this.langs.querySelectorAll('.lang')) pill.hidden = false;
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

  /** Fires in every tab when the popup writes a new setting. */
  handleStorageChange = (changes, area) => {
    if (area !== 'sync' || !changes.speechRate) return;
    this.speechRate = changes.speechRate.newValue;
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