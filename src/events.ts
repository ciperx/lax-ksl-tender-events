export const EVENT_KINDS = [
  "listing",
  "airlock",
  "bid",
  "selection",
  "award",
  "delivery",
  "review",
  "payment",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface TenderEvent {
  kind: EventKind;
  job_id: string;
  at: string;
  actor?: string;
  amount_usdc?: number;
  decision?: string;
  verdict?: string;
  [key: string]: unknown;
}

export class EventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventError";
  }
}

const isKind = (value: unknown): value is EventKind =>
  typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value);

const isIsoDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

export function validateEvent(event: unknown): TenderEvent {
  if (!event || typeof event !== "object") throw new EventError("event must be an object");
  const e = event as TenderEvent;
  if (!isKind(e.kind)) throw new EventError(`unknown kind: ${String(e.kind)}`);
  if (typeof e.job_id !== "string" || e.job_id.trim() === "") {
    throw new EventError("job_id is required");
  }
  if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) {
    throw new EventError(`at must be an ISO timestamp, got ${String(e.at)}`);
  }
  if (e.amount_usdc !== undefined) {
    if (typeof e.amount_usdc !== "number" || !Number.isFinite(e.amount_usdc) || e.amount_usdc < 0) {
      throw new EventError("amount_usdc must be a non negative number");
    }
  }
  if (e.kind === "payment" && e.amount_usdc === undefined) {
    throw new EventError("payment requires amount_usdc");
  }
  return e;
}

export interface WriterOptions {
  sink: (line: string) => void;
  now?: () => number;
}

export interface EventWriter {
  emit: (event: TenderEvent) => TenderEvent;
  events: () => TenderEvent[];
}

export function createEventWriter(options: WriterOptions): EventWriter {
  const stored: TenderEvent[] = [];
  let lastAt = -Infinity;

  return {
    emit(event) {
      const valid = validateEvent(event);
      const at = Date.parse(valid.at);
      if (at < lastAt) throw new EventError("events must be appended in time order");
      lastAt = at;
      stored.push(valid);
      options.sink(JSON.stringify(valid) + "\n");
      return valid;
    },
    events: () => stored.map((event) => ({ ...event })),
  };
}

const count = (events: TenderEvent[], kind: EventKind, day: string): number =>
  events.filter((e) => e.kind === kind && e.at.startsWith(day)).length;

interface Anomaly {
  code: string;
  job_id: string;
  detail: string;
  at: string;
}

export function findAnomalies(events: TenderEvent[]): Anomaly[] {
  const out: Anomaly[] = [];
  const airlock = new Set<string>();
  const bid = new Set<string>();
  const award = new Set<string>();
  const accepted = new Set<string>();

  for (const e of events) {
    switch (e.kind) {
      case "airlock":
        if (e.decision === "admit") airlock.add(e.job_id);
        break;
      case "bid":
        if (!airlock.has(e.job_id)) {
          out.push({ code: "bid_without_airlock", job_id: e.job_id, at: e.at, detail: `bid at ${e.at} with no airlock decision before it` });
        }
        bid.add(e.job_id);
        break;
      case "selection":
        if (!bid.has(e.job_id)) {
          out.push({ code: "selection_without_bid", job_id: e.job_id, at: e.at, detail: `selection at ${e.at} with no bid before it` });
        }
        break;
      case "award":
        award.add(e.job_id);
        break;
      case "delivery":
        if (!award.has(e.job_id)) {
          out.push({ code: "delivery_without_award", job_id: e.job_id, at: e.at, detail: `delivery at ${e.at} with no award before it` });
        }
        break;
      case "review":
        if (e.verdict === "accepted") accepted.add(e.job_id);
        break;
      case "payment":
        if (!accepted.has(e.job_id)) {
          out.push({ code: "payment_without_acceptance", job_id: e.job_id, at: e.at, detail: `payment at ${e.at} with no accepted review before it` });
        }
        break;
      default:
        break;
    }
  }
  return out;
}

export function reportSection(events: TenderEvent[], day: string): string {
  if (!isIsoDay(day)) throw new EventError(`day must be YYYY-MM-DD, got ${day}`);
  const onDay = events.filter((e) => e.at.startsWith(day));
  // Validate against the whole stream, then report only the anomalies that
  // happened on the day. Slicing first used to invent anomalies for any job
  // that crossed midnight, because the award landed on the day before.
  const anomalies = findAnomalies(events).filter((a) => a.at.startsWith(day));
  const lines: string[] = [];

  lines.push(`## Tender report for ${day}`, "");
  lines.push(`Events on the day: ${onDay.length}`, "");
  for (const kind of EVENT_KINDS) {
    lines.push(`- ${kind}: ${count(onDay, kind, day)}`);
  }

  const paid = onDay
    .filter((e) => e.kind === "payment")
    .reduce((sum, e) => sum + (e.amount_usdc ?? 0), 0);
  lines.push("", `Total paid: ${paid} USDC`, "");

  if (anomalies.length === 0) {
    lines.push("Anomalies: none");
  } else {
    lines.push(`Anomalies: ${anomalies.length}`);
    for (const a of anomalies) {
      lines.push(`- ${a.code} on job ${a.job_id}: ${a.detail}`);
    }
  }
  return lines.join("\n");
}
