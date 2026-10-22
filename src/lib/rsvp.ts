import type { CalendarEvent } from "./types";

/** Google's attendee responseStatus values. */
export type Rsvp = "accepted" | "declined" | "tentative" | "needsAction";

export interface Guest {
  email: string;
  name: string | null;
  rsvp: Rsvp;
  organizer: boolean;
  self: boolean;
  optional: boolean;
}

const asRsvp = (s: unknown): Rsvp =>
  s === "accepted" || s === "declined" || s === "tentative" ? s : "needsAction";

/** The people on an event (meeting rooms and other resources left out),
 *  organizer first, then you, then the rest in the order Google lists them. */
export function guestsOf(e: CalendarEvent): Guest[] {
  const list: any[] = Array.isArray(e.raw?.attendees) ? e.raw.attendees : [];
  const guests = list
    .filter((a) => a && typeof a.email === "string" && a.email && !a.resource)
    .map((a) => ({
      email: a.email as string,
      name: typeof a.displayName === "string" && a.displayName ? a.displayName : null,
      rsvp: asRsvp(a.responseStatus),
      organizer: !!a.organizer,
      self: !!a.self,
      optional: !!a.optional,
    }));
  const rank = (g: Guest) => (g.organizer ? 0 : g.self ? 1 : 2);
  return guests.map((g, i) => [g, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([g]) => g);
}

/** Your answer to someone else's invitation; null when it isn't one (no
 *  guests, or you organize it). */
export function myRsvp(e: CalendarEvent): Rsvp | null {
  const me = guestsOf(e).find((g) => g.self);
  // no organizer on record: yours (as restoreInputOf reads it)
  if (!me || me.organizer || !e.raw?.organizer || e.raw.organizer.self) return null;
  return me.rsvp;
}

/** Chip class for an invitation: not answered yet, maybe, or declined. */
export function rsvpClass(e: CalendarEvent): string {
  switch (myRsvp(e)) {
    case "needsAction":
      return " invite-pending";
    case "tentative":
      return " invite-maybe";
    case "declined":
      return " invite-declined";
    default:
      return "";
  }
}

/** "2 yes, 1 no, 2 awaiting" (Google's wording). */
export function rsvpTally(guests: Guest[]): string {
  const n = (r: Rsvp) => guests.filter((g) => g.rsvp === r).length;
  return [
    [n("accepted"), "yes"],
    [n("declined"), "no"],
    [n("tentative"), "maybe"],
    [n("needsAction"), "awaiting"],
  ]
    .filter(([c]) => c)
    .map(([c, w]) => `${c} ${w}`)
    .join(", ");
}

/** A guest list (an event's, or a series master's as Google sends it) with
 *  your answer changed, every other field of every attendee kept; null when
 *  you aren't on it. */
export function withMyRsvp(attendees: unknown, rsvp: Rsvp): Record<string, unknown>[] | null {
  const list: any[] = Array.isArray(attendees) ? attendees : [];
  if (!list.some((a) => a?.self)) return null;
  return list.map((a) => (a?.self ? { ...a, responseStatus: rsvp } : { ...a }));
}

export const RSVP_WORD: Record<Rsvp, string> = { accepted: "Yes", declined: "No", tentative: "Maybe", needsAction: "No answer" };
