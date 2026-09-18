# The mouse flow, in plain English

What actually happens between you dragging across some text and a bubble showing
up. The code is in [bubble.js](bubble.js) if you want to follow along; this is the
story of it.

---

## The things the bubble remembers

The bubble keeps track of six things about itself:

- **What it's doing right now** — `state` — hidden, showing the little icon
  button, or showing the expanded card. Everything else follows from this.
- **Where the selected text is** — `anchor` — a box describing where the
  highlight sits on screen. Measured from the corner of your visible window, not
  the top of the page, which matters once you start scrolling.
- **Whether you just clicked the bubble itself** — `holdOpen` — a flag that gets
  switched on and then immediately switched off again. It exists to pass a note
  from one moment to the next.
- **Whether a repositioning is already lined up** — `frameQueued` — so that
  scrolling doesn't trigger hundreds of redundant moves.
- **Its own bits of HTML** — `host` (the container that goes in the page), and
  inside it `wrap`, `trigger` (the button), `card`, `meta` and `quote`. These
  don't exist at all until the first time they're needed.
- **The gap** — `gap` — how far above the text to float. Ten pixels.

---

## Dragging across some text

**Before anything happens,** the bubble is doing nothing. It's hidden, it has no
idea where any text is, and — importantly — it hasn't built any HTML yet. It's
just listening.

**You press the mouse button down.** The bubble checks whether you clicked on
itself. On start there is nothing to have clicked on yet, so the answer is no, and it hides.
It was already hidden, so nothing visibly happens. On your second and later
selections, though, this is the step that clears away the previous bubble.

**You drag.** The bubble ignores this entirely. The browser handles highlighting
the text; there's no reason to get involved until you're done.

**You let go.** This is the interesting moment, and the bubble does something
counterintuitive: it does nothing at all, and instead leaves itself a note to come
back in a moment.

The reason is that the browser hasn't quite finished. When you release the mouse,
the browser tells everyone who's listening, *and then* finalises what's actually
selected. So if the bubble looked immediately, it could see the old selection
rather than the new one. This is most obvious when you double-click a word — the
word gets selected slightly after the event is announced, so looking too early
finds nothing and the bubble would never appear.

So it waits for the browser to finish its work, then looks.

**Now it looks at the selection.** It asks the page what's selected, and throws
the answer away unless it passes a few checks: there is actually a selection, it's
not just a blinking cursor, it isn't only whitespace, and it occupies real space
on screen. Text inside a search box or a comment field is a special case — the
browser doesn't report those the normal way, so the bubble asks the field directly
and settles for pointing at the whole field rather than the exact words.

If any check fails, the bubble hides and that's the end of it. Otherwise it gets
back two things: the text itself, and a box saying where it is.

**It builds itself, once.** The very first time there's something to show, the
bubble creates its HTML and drops it into the page. Every time after that it skips
this, because the HTML already exists — it just gets moved and shown again.

What it builds is a container holding both states at once: the little icon button
and the full card, sitting side by side. Only one is ever visible. Switching
between them is a matter of flipping a label on the container, which the CSS reads
to decide which one to show.

The container is deliberately walled off from the page around it. Websites have
their own styling that would otherwise bleed in and wreck the bubble's appearance,
and their own scripts that could otherwise poke at it. Neither can reach inside.

**It fills in the text.** Word count, character count, and the selected text
itself, trimmed down if it's long. This happens even though the card is hidden at
this point. It's cheap, and it means that when you do expand it, there's nothing
left to do.

**It makes itself visible, and only then works out where to go.** The order
matters. Something that isn't being displayed has no size, so asking "how wide are
you?" before showing it gives you zero, and the maths comes out wrong.

**It positions itself.** It measures whichever piece is currently on show — the
little button, at this point — and tries to sit centred just above the highlighted
text. Two adjustments: if there isn't room above (you selected something near the
top of the screen) it flips underneath instead, and turns its little arrow the
other way up. And if centring would push it off the left or right edge, it slides
back inward.

**Done.** The button is floating above your selection, and the bubble now
remembers where the text was, so it can find its way back there later.

---

## Clicking the button

Three separate things happen when you click, and they have to cooperate.

**First, the press.** The bubble notices the click landed on itself rather than on
the page, and does two things. It tells the browser not to do what it normally
would — because what it normally would do is clear your text selection, and the
bubble is anchored to that selection. Then it leaves itself that note: *the next
thing that happens, ignore it.*

**Then, the release.** Ordinarily this is where the bubble re-checks the selection
and hides if there isn't one. But it finds the note, tears it up, and does nothing.

This matters more than it sounds. Without that note, the bubble would check the
selection, find it disturbed by your click, conclude you'd clicked away, and
vanish — right at the moment you were trying to use it. That was a real bug
earlier on: the bubble was impossible to click, because clicking it killed it.

**Finally, the click itself registers.** The bubble switches from the button to
the card, and then repositions. That last bit isn't optional: the card is several
times bigger than the little button, so leaving it where the button was would
plant it badly off-centre.

One loose end that turns out not to matter: the release and the click can arrive
in either order, depending on the browser's mood. Both orders work out the same,
because the release does nothing regardless.

---

## Clicking somewhere else

Two things independently decide to hide the bubble, which is why it disappears
immediately rather than with a lag.

The press notices you clicked the page rather than the bubble, and hides it. Then
the release checks the selection, finds your click cleared it, and hides it again
— which does nothing, because it's already gone.

The bubble keeps its stale memory of where the text used to be. Harmless: it never
uses that memory while it's hidden, and the next selection overwrites it.

---

## Selecting something else

Pressing down to start the new selection hides the old bubble, exactly as
clicking away would. Then releasing runs the normal flow and brings it back in its
collapsed state.

So if you'd expanded the card and then selected different text, you get the small
button again rather than a card full of the previous selection. That's deliberate:
the new selection always starts you over.

---

## Scrolling

The bubble remembers where the text is *relative to your screen*, not relative to
the page. So the moment anything scrolls, that memory is wrong and the bubble is
floating in the wrong place.

Scrolling fires off notifications constantly — many times a second. Reacting to
every single one would be wasteful, so the bubble instead waits for the browser's
next repaint and handles them all at once. Anything that arrives in the meantime
gets folded into that one update.

When it does update, it re-measures where the text is now and moves to match. If
the selection has gone entirely but the bubble is somehow still up, it keeps its
last known position rather than jumping to the corner of the screen.

---

## The four things that make it work

1. **Don't look at the selection the instant the mouse is released.** Let the
   browser finish first. Looking too early sees stale information.
2. **When someone clicks your own bubble, stop the browser doing its usual thing.**
   Otherwise the click clears the very selection the bubble is attached to.
3. **Show it before you measure it.** Hidden things have no size.
4. **Positions measured against the screen go stale when anything scrolls.** Either
   keep them updated or accept the bubble drifting away from the text.
