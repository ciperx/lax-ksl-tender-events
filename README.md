# lax-ksl-tender-events

An append only event writer for the tender steps, plus a daily Markdown report section.

`emit(event)` appends one validated event as a JSONL line.
`reportSection(events, day)` returns the Markdown section for one day.

## Install

```bash
npm install
npm test
npm run build
```

## Use

```ts
import { createEventWriter, reportSection } from "lax-ksl-tender-events";

const lines: string[] = [];
const writer = createEventWriter({ sink: (line) => lines.push(line) });

writer.emit({ kind: "listing", job_id: "j1", at: "2026-10-19T01:00:00Z" });
writer.emit({ kind: "airlock", job_id: "j1", at: "2026-10-19T02:00:00Z", decision: "admit" });
writer.emit({ kind: "bid", job_id: "j1", at: "2026-10-19T03:00:00Z" });

const md = reportSection(writer.events(), "2026-10-19");
```

## The eight steps

`listing`, `airlock`, `bid`, `selection`, `award`, `delivery`, `review`, `payment`.

## Guarantees

- **Append only.** The sink is called once per accepted event and earlier lines are never rewritten. Tested by capturing the first line, emitting a second event and comparing the first line byte for byte.
- **Validated before it is written.** A bad event throws `EventError` and leaves the sink untouched, verified with a spy that must not be called.
- **Time order.** An event older than the last accepted one is refused, so the stream is a true log rather than a bag.
- **Anomalies are found by state, not by position alone.** A bid with no admitted airlock decision, a selection with no bid, a delivery with no award, and a payment with no accepted review. A refused airlock is not permission, and a rejected review is not permission, both tested.
- **Jobs stay separate.** An anomaly on one job never bleeds into another, tested by mixing a clean job stream with a broken one.
- **The store hands out copies**, so a caller cannot mutate history.
- **The report is deterministic.** Same events, same Markdown, tested by comparing two runs.
- **Midnight is not an anomaly.** The daily section validates against the whole stream and then reports only the anomalies that happened on that day, so a job that is awarded before midnight and delivered after it is not reported as corrupt. Tested in both directions.

## Report shape

```
## Tender report for 2026-10-19

Events on the day: 8

- listing: 1
- airlock: 1
- bid: 1
- selection: 1
- award: 1
- delivery: 1
- review: 1
- payment: 1

Total paid: 54 USDC

Anomalies: none
```

## Tests

27 tests in `test/events.test.ts`: validation refusals, append behaviour, no sink call on failure, time order, copy semantics, four anomaly classes with their near misses, cross job isolation, and report counting, totals, day filtering, anomaly listing, determinism and the malformed day refusal.

Mutation checked before pushing: disabling the airlock check fails 3 tests (the refused airlock case and both midnight cases), then restoring it returns to green.

## Licence

MIT.
