// UI TEMPLATE — markup and styles for the selection bubble.
//
// The manifest lists this file BEFORE bubble.js and content.js, and every file in
// that array runs in the same global scope, in order. So they can just use
// UI_HTML — there is no import, and no `export` here.
//
// (Declarative content scripts can't be ES modules, which is why it works this
// way rather than with `import { UI_HTML } from './ui.js'`.)
//
// Two states:
//   collapsed — a small icon button, shown as soon as text is selected
//   expanded  — the full card, shown after that button is clicked
//
const UI_CSS = `
  :host { all: initial; }

  .wrap { position: relative; }

  /* --- collapsed: the trigger button ------------------------------- */
  .trigger {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: linear-gradient(135deg, #6366f1 0%, #a855f7 55%, #ec4899 100%);
    color: #fff;
    cursor: pointer;
    box-shadow: 0 6px 18px rgba(99, 102, 241, .45), 0 1px 3px rgba(0, 0, 0, .3);
    animation: rise .16s cubic-bezier(.2, .9, .3, 1.4);
    transition: transform .13s ease, box-shadow .13s ease;
  }
  .trigger:hover {
    transform: translateY(-1px) scale(1.1);
    box-shadow: 0 9px 24px rgba(99, 102, 241, .6), 0 1px 3px rgba(0, 0, 0, .3);
  }
  .trigger:active { transform: scale(.94); }
  .trigger svg { display: block; filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .25)); }

  /* --- expanded: the card ------------------------------------------ */
  .card {
    position: relative;
    box-sizing: border-box;
    width: max-content;
    min-width: 210px;
    max-width: 320px;
    padding: 11px 14px 13px;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, .09);
    background: rgba(20, 22, 33, .9);
    -webkit-backdrop-filter: blur(14px) saturate(1.4);
    backdrop-filter: blur(14px) saturate(1.4);
    color: #eef1f8;
    font: 400 12.5px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    box-shadow: 0 14px 38px rgba(0, 0, 0, .42), 0 2px 8px rgba(0, 0, 0, .26);
    text-align: left;
    animation: rise .16s cubic-bezier(.2, .9, .3, 1.4);
    /* Dragging across the card must not start a new selection. */
    user-select: none;
    -webkit-user-select: none;
  }
  /* A gradient hairline along the top edge — the one decorative flourish. */
  .card::before {
    content: '';
    position: absolute;
    top: 0; left: 14px; right: 14px;
    height: 1px;
    background: linear-gradient(90deg,
      transparent, rgba(168, 85, 247, .9), rgba(99, 102, 241, .9), transparent);
  }

  /* --- action buttons, top right ----------------------------------- */
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 5px;
    margin-bottom: 9px;
  }
  .act {
    display: grid;
    place-items: center;
    width: 25px;
    height: 25px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 8px;
    background: rgba(255, 255, 255, .04);
    color: #98a1b6;
    cursor: pointer;
    transition: background .12s ease, color .12s ease, border-color .12s ease, transform .12s ease;
  }
  .act:hover {
    background: rgba(255, 255, 255, .12);
    border-color: rgba(255, 255, 255, .22);
    color: #fff;
    transform: translateY(-1px);
  }
  .act:active { transform: translateY(0) scale(.94); }
  .act svg { display: block; }

  /* Shared "this button is active" look. */
  .act[data-on="true"] {
    color: #fff;
    border-color: transparent;
    background: linear-gradient(135deg, rgba(99, 102, 241, .95), rgba(168, 85, 247, .95));
  }
  .act[data-busy="true"] { opacity: .5; pointer-events: none; }
  /* Only one thing speaks at a time, so the other button greys out. */
  .act:disabled { opacity: .3; cursor: default; pointer-events: none; }
  /* Smaller variant, used inside the result panel. */
  .act.sm { width: 22px; height: 22px; border-radius: 7px; }

  /* Icon swap inside the speak button. */
  .speak .icon-stop { display: none; }
  .speak[data-on="true"] .icon-play { display: none; }
  .speak[data-on="true"] .icon-stop { display: block; }

  /* --- content ------------------------------------------------------ */
  .quote {
    color: #e6eaf4;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* --- language picker ---------------------------------------------- */
  .langs {
    margin-top: 10px;
    padding-top: 9px;
    border-top: 1px solid rgba(255, 255, 255, .08);
  }
  .langs[hidden] { display: none; }
  .langs-label {
    display: block;
    margin-bottom: 6px;
    color: #8f98ad;
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: .07em;
    text-transform: uppercase;
  }
  .lang-row { display: flex; gap: 5px; }
  .lang {
    padding: 4px 10px;
    border: 1px solid rgba(255, 255, 255, .14);
    border-radius: 20px;
    background: rgba(255, 255, 255, .04);
    color: #cfd6e6;
    font: 500 11px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    cursor: pointer;
    transition: background .12s ease, color .12s ease, border-color .12s ease, transform .12s ease;
  }
  .lang:hover {
    background: rgba(255, 255, 255, .12);
    border-color: rgba(255, 255, 255, .3);
    color: #fff;
    transform: translateY(-1px);
  }
  .lang:active { transform: translateY(0) scale(.96); }
  .lang[hidden] { display: none; }
  .lang[data-active="true"] {
    border-color: transparent;
    background: linear-gradient(135deg, #6366f1, #a855f7);
    color: #fff;
  }

  .result {
    margin-top: 10px;
    padding-top: 9px;
    border-top: 1px solid rgba(255, 255, 255, .08);
  }
  .result[hidden] { display: none; }
  .result-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 5px;
  }
  .result-head:empty { display: none; }
  .tag {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 20px;
    border: 1px solid rgba(168, 85, 247, .35);
    background: linear-gradient(135deg, rgba(99, 102, 241, .25), rgba(168, 85, 247, .25));
    color: #cbbcff;
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: .07em;
    text-transform: uppercase;
  }
  .tag[hidden] { display: none; }
  .result-text { color: #dbe1ef; }
  .result[data-error="true"] .result-text { color: #ffb0b0; }

  .arrow {
    position: absolute; left: 50%; margin-left: -6px;
    border: 6px solid transparent;
  }

  /* --- state switching --------------------------------------------- */
  .wrap[data-state="collapsed"] .card    { display: none; }
  .wrap[data-state="expanded"]  .trigger { display: none; }
  .wrap[data-side="top"]    .arrow { bottom: -12px; border-top-color: rgba(20, 22, 33, .92); }
  .wrap[data-side="bottom"] .arrow { top: -12px; border-bottom-color: rgba(20, 22, 33, .92); }

  @keyframes rise { from { opacity: 0; transform: translateY(4px) scale(.96); } }
  @media (prefers-reduced-motion: reduce) {
    .trigger, .card { animation: none; }
  }
`;

// What you see the moment text is selected.
const COLLAPSED_HTML = `
  <button class="trigger" type="button" aria-label="Hello Foster">
    <!-- Inline SVG: no extra file, so nothing to add to web_accessible_resources -->
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M12 2.5l1.7 4.8 4.8 1.7-4.8 1.7L12 15.5l-1.7-4.8L5.5 9l4.8-1.7L12 2.5z"/>
      <path d="M18.5 14l.85 2.4 2.4.85-2.4.85-.85 2.4-.85-2.4-2.4-.85 2.4-.85.85-2.4z" opacity=".65"/>
    </svg>
  </button>
`;

// What replaces it once that button is clicked.
const EXPANDED_HTML = `
  <div class="card">
    <div class="actions">
      <button class="act speak" type="button" data-on="false"
              aria-label="Read aloud" title="Read aloud">
        <svg class="icon-play" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
          <path d="M4 9.5v5h3.2L12 18.6V5.4L7.2 9.5H4z"/>
          <path d="M15.2 8.3a4.3 4.3 0 010 7.4v-1.6a2.9 2.9 0 000-4.2V8.3z"/>
          <path d="M15.2 5.1a7.5 7.5 0 010 13.8v-1.6a6 6 0 000-10.6V5.1z" opacity=".6"/>
        </svg>
        <svg class="icon-stop" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="2"/>
        </svg>
      </button>

      <button class="act translate" type="button" data-busy="false"
              aria-label="Translate" title="Translate">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/>
          <path d="M3 12h18"/>
          <path d="M12 3c2.4 2.7 2.4 15.3 0 18-2.4-2.7-2.4-15.3 0-18z"/>
        </svg>
      </button>
    </div>

    <div class="quote"></div>

    <div class="langs" hidden>
      <span class="langs-label">Translate to</span>
      <div class="lang-row">
        <button class="lang" type="button" data-lang="en" data-active="false">English</button>
        <button class="lang" type="button" data-lang="fr" data-active="false">Français</button>
        <button class="lang" type="button" data-lang="es" data-active="false">Español</button>
      </div>
    </div>

    <div class="result" hidden data-error="false">
      <div class="result-head">
        <span class="tag" hidden></span>
        <button class="act sm speak speak-result" type="button" data-on="false" hidden
                aria-label="Read translation" title="Read translation">
          <svg class="icon-play" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
            <path d="M4 9.5v5h3.2L12 18.6V5.4L7.2 9.5H4z"/>
            <path d="M15.2 8.3a4.3 4.3 0 010 7.4v-1.6a2.9 2.9 0 000-4.2V8.3z"/>
            <path d="M15.2 5.1a7.5 7.5 0 010 13.8v-1.6a6 6 0 000-10.6V5.1z" opacity=".6"/>
          </svg>
          <svg class="icon-stop" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
          </svg>
        </button>
      </div>
      <div class="result-text"></div>
    </div>

    <div class="arrow"></div>
  </div>
`;

// Both states live in the shadow root at once; a data-state attribute on .wrap
// decides which one is visible. See the state-switching rules in UI_CSS.
const UI_HTML = `
  <style>${UI_CSS}</style>
  <div class="wrap" data-state="collapsed" data-side="top">
    ${COLLAPSED_HTML}
    ${EXPANDED_HTML}
  </div>
`;
