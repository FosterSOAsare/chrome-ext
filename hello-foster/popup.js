// POPUP — the settings panel behind the toolbar button.
//
// It's a normal web page that exists only while the popup is open, so it keeps
// no state of its own. Everything lives in chrome.storage.sync, which the
// content script reads on the pages you visit.

const DEFAULTS = { speechRate: 1 };

const rate = document.getElementById('rate');
const rateValue = document.getElementById('rateValue');
const preview = document.getElementById('preview');

const format = (n) => `${Number(n).toFixed(2).replace(/0$/, '')}×`;

// Passing an object to get() supplies defaults for anything not stored yet,
// which saves a round of `?? 1` checks everywhere downstream.
chrome.storage.sync.get(DEFAULTS).then(({ speechRate }) => {
  rate.value = speechRate;
  rateValue.textContent = format(speechRate);
});

// 'input' fires continuously as the slider is dragged, so the label tracks the
// thumb. Writing on every pixel would be wasteful, though — sync storage is
// rate-limited to 120 writes a minute — so the save waits for 'change', which
// fires once when you let go.
rate.addEventListener('input', () => {
  rateValue.textContent = format(rate.value);
});

rate.addEventListener('change', () => {
  chrome.storage.sync.set({ speechRate: Number(rate.value) });
});

preview.addEventListener('click', () => {
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(
    'This is how fast the reading voice will be.',
  );
  utterance.rate = Number(rate.value);
  speechSynthesis.speak(utterance);
});

// The popup is destroyed the moment it closes, and any speech it started would
// be cut off with it. Stop deliberately rather than leaving it to chance.
window.addEventListener('pagehide', () => speechSynthesis.cancel());
