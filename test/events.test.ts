import { describe, expect, it, vi } from "vitest";
import {
  createEventWriter,
  findAnomalies,
  reportSection,
  validateEvent,
  EventError,
  EVENT_KINDS,
} from "../src/events";
import type { TenderEvent } from "../src/events";

const DAY = "2026-10-19";
const at = (h: number) => `${DAY}T${String(h).padStart(2, "0")}:00:00Z`;

const happy = (): TenderEvent[] => [
  { kind: "listing", job_id: "j1", at: at(1) },
  { kind: "airlock", job_id: "j1", at: at(2), decision: "admit" },
  { kind: "bid", job_id: "j1", at: at(3) },
  { kind: "selection", job_id: "j1", at: at(4) },
  { kind: "award", job_id: "j1", at: at(5) },
  { kind: "delivery", job_id: "j1", at: at(6) },
  { kind: "review", job_id: "j1", at: at(7), verdict: "accepted" },
  { kind: "payment", job_id: "j1", at: at(8), amount_usdc: 54 },
];

describe("validateEvent", () => {
  it("accepts a well formed event", () => {
    expect(validateEvent({ kind: "bid", job_id: "j1", at: at(2) }).kind).toBe("bid");
  });

  it("refuses an unknown kind", () => {
    expect(() => validateEvent({ kind: "invoiced", job_id: "j", at: at(1) })).toThrow(/unknown kind/);
  });

  it("refuses a missing job id", () => {
    expect(() => validateEvent({ kind: "bid", job_id: "  ", at: at(1) })).toThrow(/job_id/);
  });

  it("refuses a bad timestamp", () => {
    expect(() => validateEvent({ kind: "bid", job_id: "j", at: "yesterday" })).toThrow(/ISO/);
  });

  it("refuses a negative amount", () => {
    expect(() => validateEvent({ kind: "payment", job_id: "j", at: at(1), amount_usdc: -1 })).toThrow(/amount/);
  });

  it("refuses a payment with no amount", () => {
    expect(() => validateEvent({ kind: "payment", job_id: "j", at: at(1) })).toThrow(/amount_usdc/);
  });

  it("refuses a non object", () => {
    expect(() => validateEvent(null)).toThrow(EventError);
  });
});

describe("createEventWriter", () => {
  it("appends validated events to the sink as JSONL", () => {
    const lines: string[] = [];
    const w = createEventWriter({ sink: (l) => lines.push(l) });
    for (const e of happy()) w.emit(e);
    expect(lines).toHaveLength(8);
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(w.events()).toHaveLength(8);
  });

  it("never rewrites an earlier line", () => {
    const lines: string[] = [];
    const w = createEventWriter({ sink: (l) => lines.push(l) });
    w.emit(happy()[0]);
    const first = lines[0];
    w.emit(happy()[1]);
    expect(lines[0]).toBe(first);
  });

  it("refuses to go back in time", () => {
    const w = createEventWriter({ sink: () => {} });
    w.emit({ kind: "bid", job_id: "j", at: at(5) });
    expect(() => w.emit({ kind: "bid", job_id: "j", at: at(4) })).toThrow(/time order/);
  });

  it("does not touch the sink when validation fails", () => {
    const sink = vi.fn();
    const w = createEventWriter({ sink });
    expect(() => w.emit({ kind: "nope" } as unknown as TenderEvent)).toThrow(EventError);
    expect(sink).not.toHaveBeenCalled();
  });

  it("returns copies so the store cannot be mutated from outside", () => {
    const w = createEventWriter({ sink: () => {} });
    w.emit(happy()[0]);
    const copy = w.events();
    copy.push(happy()[1]);
    expect(w.events()).toHaveLength(1);
  });
});

describe("findAnomalies", () => {
  it("finds nothing in a clean stream", () => {
    expect(findAnomalies(happy())).toEqual([]);
  });

  it("flags a bid with no airlock decision", () => {
    const a = findAnomalies([{ kind: "bid", job_id: "j1", at: at(2) }]);
    expect(a.map((x) => x.code)).toEqual(["bid_without_airlock"]);
  });

  it("does not count a refused airlock as permission", () => {
    const a = findAnomalies([
      { kind: "airlock", job_id: "j1", at: at(1), decision: "refuse" },
      { kind: "bid", job_id: "j1", at: at(2) },
    ]);
    expect(a.map((x) => x.code)).toEqual(["bid_without_airlock"]);
  });

  it("flags a payment with no accepted review", () => {
    const a = findAnomalies([
      { kind: "listing", job_id: "j2", at: at(1) },
      { kind: "payment", job_id: "j2", at: at(2), amount_usdc: 10 },
    ]);
    expect(a.map((x) => x.code)).toContain("payment_without_acceptance");
  });

  it("does not accept a rejected review as permission", () => {
    const a = findAnomalies([
      { kind: "review", job_id: "j2", at: at(1), verdict: "rejected" },
      { kind: "payment", job_id: "j2", at: at(2), amount_usdc: 10 },
    ]);
    expect(a.map((x) => x.code)).toEqual(["payment_without_acceptance"]);
  });

  it("flags a selection with no bid and a delivery with no award", () => {
    const a = findAnomalies([
      { kind: "selection", job_id: "j3", at: at(1) },
      { kind: "delivery", job_id: "j3", at: at(2) },
    ]);
    expect(a.map((x) => x.code).sort()).toEqual(["delivery_without_award", "selection_without_bid"]);
  });

  it("keeps jobs separate", () => {
    const a = findAnomalies([
      ...happy(),
      { kind: "bid", job_id: "other", at: at(9) },
    ]);
    expect(a.map((x) => x.code)).toEqual(["bid_without_airlock"]);
  });
});

describe("reportSection", () => {
  it("counts every kind and the money", () => {
    const md = reportSection(happy(), DAY);
    for (const kind of EVENT_KINDS) {
      expect(md).toContain(`- ${kind}: `);
    }
    expect(md).toContain("Events on the day: 8");
    expect(md).toContain("Total paid: 54 USDC");
    expect(md).toContain("Anomalies: none");
    expect(md.startsWith(`## Tender report for ${DAY}`)).toBe(true);
  });

  it("ignores events from another day", () => {
    const md = reportSection([...happy(), { kind: "bid", job_id: "j9", at: "2026-10-20T01:00:00Z" }], DAY);
    expect(md).toContain("Events on the day: 8");
    expect(md).toContain("Anomalies: none");
  });

  it("lists anomalies with the code and the job", () => {
    const md = reportSection([{ kind: "payment", job_id: "j7", at: at(3), amount_usdc: 5 }], DAY);
    expect(md).toContain("Anomalies: 1");
    expect(md).toContain("payment_without_acceptance on job j7");
  });

  it("is deterministic", () => {
    expect(reportSection(happy(), DAY)).toBe(reportSection(happy(), DAY));
  });

  it("refuses a malformed day", () => {
    expect(() => reportSection(happy(), "19-10-2026")).toThrow(/YYYY-MM-DD/);
  });
});

describe("midnight boundary", () => {
  it("does not invent anomalies for a job that crosses midnight", () => {
    const stream: TenderEvent[] = [
      { kind: "listing", job_id: "j1", at: "2026-10-18T20:00:00Z" },
      { kind: "airlock", job_id: "j1", at: "2026-10-18T21:00:00Z", decision: "admit" },
      { kind: "bid", job_id: "j1", at: "2026-10-18T22:00:00Z" },
      { kind: "award", job_id: "j1", at: "2026-10-18T23:00:00Z" },
      { kind: "review", job_id: "j1", at: "2026-10-18T23:30:00Z", verdict: "accepted" },
      { kind: "delivery", job_id: "j1", at: "2026-10-19T00:30:00Z" },
      { kind: "payment", job_id: "j1", at: "2026-10-19T01:00:00Z", amount_usdc: 5 },
    ];
    expect(reportSection(stream, "2026-10-19")).toContain("Anomalies: none");
    expect(reportSection(stream, "2026-10-18")).toContain("Anomalies: none");
  });

  it("still reports a real anomaly that happens on the day", () => {
    const stream: TenderEvent[] = [
      { kind: "payment", job_id: "j9", at: "2026-10-19T02:00:00Z", amount_usdc: 1 },
    ];
    expect(reportSection(stream, "2026-10-19")).toContain("payment_without_acceptance on job j9");
  });

  it("hands out copies that cannot mutate history", () => {
    const w = createEventWriter({ sink: () => {} });
    w.emit({ kind: "bid", job_id: "j1", at: at(1) });
    const copy = w.events();
    copy[0].job_id = "tampered";
    expect(w.events()[0].job_id).toBe("j1");
  });
});
