// CONTENT SCRIPT — the entry point.
//
// The manifest injects three files into every page, in this order:
//
//   1. ui.js      defines UI_HTML         — what it looks like
//   2. bubble.js  defines SelectionBubble — how it behaves
//   3. content.js this file               — when it starts
//
// They share one global scope, so UI_HTML and SelectionBubble are already in
// scope here. Declarative content scripts can't be ES modules, so there is no
// import to write.

const bubble = new SelectionBubble(UI_HTML);
bubble.start();

// Handy while developing: open the page's DevTools, switch the console's context
// dropdown from "top" to this extension, then poke at it directly —
// bubble.expand(), bubble.hide(), bubble.state, bubble.stop().
globalThis.__helloFosterBubble = bubble;
