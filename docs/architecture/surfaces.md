# Surfaces: where each lane's code goes

The agent surfaces (decision sheets, the inbox and snooze, talking to agents, lineup, peek, point and say) are
built in six lanes that run in parallel. P0 split the shared files into one slot per feature, so **each lane only
edits its own files**. If a lane needs a line in a file outside its own, that is a seams defect: report it, and it is
fixed in the shared file rather than worked around.

Nothing below changes what the person sees until its lane fills it in: every tool is hidden, every key unbound, and
every card kind, sheet page and settings section falls back to today's behaviour or to nothing.

## Each lane's files

| Lane | Tool modules (`src/core/tools/`) | Feature (`src/main/features/`) | Card body and CSS (`src/renderer/cards/`) | Sheet page (`src/renderer/sheet/`) | Settings section | QA (`qa/surfaces/`) |
| --- | --- | --- | --- | --- | --- | --- |
| L1 decide | `decide.ts`, `approve.ts` | `decide.ts` | `decide.ts`, `approve.ts`, `decide.css` | `decide.ts`, `decide.css` | `core/sections/decide.ts` (no page section) | `l1-decide.js` |
| L2 inbox | `card_status.ts` | `inbox.ts` | `round.ts`, `inbox.ts` (pill extras), `round.css` | `round.ts`, `round.css` | `agentsections/snooze.ts`; `core/sections/inbox.ts`, `snooze.ts` | `l2-inbox.js` |
| L3 voice | none | `voice.ts` | `voice.ts`, `voice.css` | none | `agentsections/voice.ts`; `core/sections/voice.ts` | `l3-voice.js` |
| L4 lineup | `lineup.ts` | `lineup.ts` | `lineup.ts`, `lineup.css` | `lineup.ts`, `lineup.css` | none | `l4-lineup.js` |
| L5 peek | `peek.ts` | `peek.ts` | `peek.ts`, `peek.css` | `peek.ts`, `peek.css` | `agentsections/peek.ts`; `core/sections/peek.ts` | `l5-peek.js` |
| L6 point | none | `point.ts` | `point.ts`, `point.css` | none | `agentsections/point.ts`; `core/sections/point.ts` | `l6-point.js` |

Lanes also own the files the cover sheet names for them: L2 the queue's rules in `src/core/cards.ts` and the busy
probe in `src/native/win32.ts`; L3 `src/main/panelink.ts` and `src/core/panewatch.ts`; L6 its native helper folder
and `electron-builder.cjs`. New files a lane needs (a matcher, a view module, tests) go beside its own files.

## The seams

**A tool.** Fill in the definition in `src/core/tools/<tool>.ts`, set `enabled: true`, and register the handler from
the feature: `host.hub.handle('decide', async (session, args, signal) => …)`. The bridge lists the tool from then on.
Raise the card and wait for the person with the hub:

```ts
const id = hub.newId();
const answer = hub.wait<Answer>(id, { session: session.id, kind: 'decide', timeoutMs, signal });
const { card_id } = hub.raise({ id, key: `ask:${id}`, kind: 'decide', data: { questions }, … });
return { ...(await answer), card_id };
```

`hub.settle(id, value)` ends the wait (`keepCard` leaves the card up, for a snoozed question). Timeouts, the agent
cancelling, its connection closing and ✕ end it with `{ answered: false, reason }`. Every card-raising result
carries `card_id`. `hub.onEnded((cardId, how, value) => …)` hears every card end (`answered`, `dismissed`,
`expired`, `cancelled`), for card_status; a wait settled with `keepCard` hasn't ended. `hub.extendStatus(() => ({ focus, waiting }))` adds to the status tool.

**A card kind.** The kinds are declared in `src/core/cards.ts` (`CARD_KINDS`); a card carries its own `data`. The
body is `src/renderer/cards/<kind>.ts` (a `CardBody` drawing title, message and buttons as text nodes, never HTML).
Its own buttons send `{ action: 'kind', name, value }`, which reach `hub.cardKind(kind, { action, reply })` in main;
`reply` also takes the person's words when they hold the key over the card. The card element has `data-kind`.

**Which card a dictation answers.** At each dictation key's key-down, `host.replyTarget(() => …)` is asked first
(the card whose sheet or peek is under the pointer), then the usual rule (the pointer over
the top card, or Reply). The words, after the usual 2 s preview, reach the card's kind handler `reply`.

**The pill's extras.** Beyond the top card and its list, the pill hosts `PillExtra` modules (`src/renderer/cards/
extras.ts`; L2's is `inbox.ts`): `mount(root)` once, `update(view)` on each change, and `cardParts(card, ctx)`
appended to every card's body. `view.extra` carries the queue's own summary (`CardView.extra` in `cards.ts`). An extra
sends its clickable areas as `dictate:extra-rects`, so the click-through pill takes clicks there and stays up.

**The queue's clock.** `CardQueue.deadline(id, startedAt, timeoutMs, now)` decides when a wait runs out; the hub asks
again when that time comes, so moving it out (held time not counting) needs no change in the hub.

**A key.** The agent key (`settings.voice.key`, Ctrl+Win) and the point key (`settings.point.key`, unset) are route
keys: hold to talk, release to send, a tap does nothing. They are bound only once a feature registers the route:
`host.route('agent', { label, began, cancelled, deliver })`. `deliver(text, raw)` gets the cleaned words instead of a
paste; it previews (`host.preview(to, text)`) or reviews them itself and returns what the pill says. The pill shows
`label` while recording and has `data-route` for styling. A route with `takesDictation()` takes the dictation key
while it answers true: the round's route does while a round is open, so the held key answers the round's card.
`host.recording.start(route)` records for a route without its key (QA's `voice down`); Esc cancels it (the route's
`cancelled` fires), as it does a key's recording.

The snooze (`settings.snooze.key`, Ctrl+Alt+Z) and round (`settings.inbox.roundKey`, Ctrl+Alt+Space) shortcuts are
bound only while their feature claims them: `host.shortcut('snooze', { claimed: () => cardUp, pressed })`, and
`host.bindingsChanged()` when the claim changes. Claimed, the key is swallowed; unclaimed, other apps get it.
`host.onKeyDown(t => …)` sees every key-down's time, never the key.

**The sheet.** One focusable, frameless window right above the pill: `host.sheet.open(kind, payload, { focus })`,
`update(payload)`, `close()`, `onClosed((kind, why) => …)`, and `window()` for peek's view. The page is
`src/renderer/sheet/<kind>.ts` (`show(root, payload)`, `hide()`, `key(e)`); Esc closes it unless the page uses Esc.
Sizes are in `src/core/sheetkinds.ts`. A sheet that shows the pill's top card takes the card's place:
`host.agents.coverTop((top) => …)` is asked with the top card on every redraw, and while it answers true the pill
draws no card. Decide uses it: its sheet follows the top card and never shows beside it.

**Settings.** Each feature's fields are a section object (`settings.snooze`, `voice`, `peek`, `point`, `inbox`, `decide`)
defined and checked in `src/core/sections/<section>.ts`; an old profile gets the defaults. Save with
`set({ snooze: { ...st.settings.snooze, minutes } })`. The section on the Agents page is
`src/renderer/agentsections/<section>.ts`, with `keyRecorder`, `card`, `toggle` and friends from `settingsui.ts`. A
feature's own runtime state goes to Settings with `host.state(() => …)` and arrives as `st.surfaces.<feature>`.

**IPC and QA.** `host.ipc.handle(name, fn)` answers `dictate:<feature>:<name>` from the feature's pages. QA control
lines starting `<feature> ` go to `host.qa(fn)`; `sheet <kind> [json]`, `sheet-close`, `sheet-shot <name>` and
`sheet-dump` drive the sheet. Journeys go in `qa/surfaces/<lane>.js`; run them with
`pnpm build && node qa/surfaces-journeys.js L1`. A feature's `beforeReady()` runs before the app is ready, for what
Electron allows only then (a privileged protocol scheme).

**Talking to the orchestrator.** L3 provides `host.provideOrchestrator({ available, send })`
(`src/main/orchestrator.ts`); L6 calls `host.orchestrator().send({ text, via: 'point', asFilePointer })`. Until L3
merges it answers `{ delivered: false, blocked: 'not-set-up' }`.
