// Insights: a dashboard over your own calendars. A period (the last 7 days,
// 4 weeks, or this week so far) against the same stretch before it, so a
// Monday morning isn't "down 18h on last week". Headline numbers with their
// daily bars, then the charts that answer where the time went, how you
// slept, when you focus and when you drift. Computed locally.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { addDays, eventDates, format, now, startOfDay, weekStart } from "../lib/dates";
import {
  avg,
  bucketDays,
  classify,
  distractionBySource,
  fmtH,
  focusScore,
  hourLabel,
  hoursByCalendar,
  peakWindow,
  sleepWindows,
  sum,
  weekHourHeat,
  type Review,
} from "../lib/insights";
import { useGoals } from "../lib/goals";
import { usePrefs } from "../lib/settings";
import { readOnlyEvent, type Backend, type Calendar, type CalendarEvent } from "../lib/types";
import { colorOf } from "../lib/useBackend";
import { isCanceled, markOf, reconSince, subscribeRecon } from "../lib/recon";
import { myRsvp } from "../lib/rsvp";

type Period = "7d" | "28d" | "week";
const PERIODS: [Period, string][] = [["7d", "7 days"], ["28d", "4 weeks"], ["week", "This week"]];
const PERIOD_KEY = "insights-period";

/** Clock hour of a day offset (-1.5 = 10:30 PM the evening before). */
const clock = (h: number) => {
  // (% 1440: 11:59.6 PM rounds to midnight, not "12 PM")
  const m = Math.round((((h % 24) + 24) % 24) * 60) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${hh % 12 || 12}${mm ? ":" + String(mm).padStart(2, "0") : ""} ${hh < 12 ? "AM" : "PM"}`;
};
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = avg(xs);
  return Math.sqrt(avg(xs.map((x) => (x - m) ** 2)));
};

function Delta(props: { value: number; base: number; goodWhenDown?: boolean; unit?: "h" | "pts"; vs: string }) {
  const { value, base, goodWhenDown, unit = "h", vs } = props;
  if (Math.abs(value) < (unit === "h" ? 0.05 : 0.5)) return <span className="ins-delta flat">same as {vs}</span>;
  const up = value > 0;
  const good = goodWhenDown ? !up : up;
  const pct = base > 0.01 ? Math.round((Math.abs(value) / base) * 100) : null;
  const pts = Math.round(Math.abs(value));
  const amount = unit === "h" ? fmtH(Math.abs(value)) : `${pts} pt${pts === 1 ? "" : "s"}`;
  return (
    <span className={"ins-delta " + (good ? "good" : "bad")} title={`vs ${vs}`}>
      {up ? "▲" : "▼"} {amount}
      {pct != null && pct < 1000 ? ` (${pct}%)` : ""} <span className="ins-vs">vs {vs}</span>
    </span>
  );
}

/** One bar per day of the period (today's half-done, drawn lighter). */
function MiniBars(props: { values: (number | null)[]; days: Date[]; fmt: (v: number) => string; color: string; max?: number }) {
  const max = props.max ?? Math.max(0.01, ...props.values.map((v) => v ?? 0));
  const last = props.values.length - 1;
  return (
    <div className="ins-mini" aria-hidden="true">
      {props.values.map((v, i) => (
        <span
          key={i}
          className={"ins-mini-bar" + (i === last ? " today" : "") + (v == null ? " none" : "")}
          title={`${format(props.days[i], "EEE MMM d")}: ${v == null ? "no data" : props.fmt(v)}`}
          style={{ height: `${v == null ? 0 : Math.max(4, (v / max) * 100)}%`, background: props.color }}
        />
      ))}
    </div>
  );
}

function Card(props: { id: string; label: string; value: string; sub?: React.ReactNode; delta?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="ins-card ins-kpi" data-testid={props.id}>
      <span className="ins-label">{props.label}</span>
      <span className="ins-big">{props.value}</span>
      {props.delta}
      {props.sub && <span className="ins-note">{props.sub}</span>}
      {props.children}
    </section>
  );
}

function Panel(props: { id: string; title: string; note?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={"ins-card ins-panel" + (props.className ? " " + props.className : "")} data-testid={props.id}>
      <header className="ins-panel-head">
        <h3>{props.title}</h3>
        {props.note && <span className="ins-note">{props.note}</span>}
      </header>
      {props.children}
    </section>
  );
}

export function InsightsView(props: {
  backend: Backend | null;
  events: CalendarEvent[];
  calendars: Calendar[];
}) {
  const { calendars } = props;
  // only your calendars count: someone else's events count once copied in;
  // a declined invitation isn't time spent
  const events = useMemo(
    () => props.events.filter((e) => !readOnlyEvent(e, calendars) && myRsvp(e) !== "declined"),
    [props.events, calendars],
  );
  const goals = useGoals(props.backend);
  // which calendars are deep work (Settings › Insights)
  const prefs = usePrefs();
  // the day score credits reviewed events: recompute when a review lands
  const [reconTick, setReconTick] = useState(0);
  useEffect(() => subscribeRecon(() => setReconTick((t) => t + 1)), []);
  const [period, setPeriodState] = useState<Period>(() => {
    try {
      const p = localStorage.getItem(PERIOD_KEY);
      return p === "28d" || p === "week" ? p : "7d";
    } catch {
      return "7d";
    }
  });
  const setPeriod = (p: Period) => {
    setPeriodState(p);
    try {
      localStorage.setItem(PERIOD_KEY, p);
    } catch {
      /* a per-viewer convenience */
    }
  };

  const m = useMemo(() => {
    const nowD = now();
    const today = startOfDay(nowD);
    const since = reconSince();
    const review = (until: Date): Review => ({ now: until, recon: (e) => markOf(e), reconSince: since });
    const span = period === "28d" ? 28 : 7;
    const from = period === "week" ? weekStart(nowD) : addDays(today, -(span - 1));
    const prevFrom = period === "week" ? addDays(from, -7) : addDays(from, -span);
    // this week so far against last week up to the same moment (on the
    // wall clock: across Nov 1 a 7×24h step was an hour off)
    const prevUntil = period === "week" ? addDays(nowD, -7) : from;
    const cur = bucketDays(events, calendars, from, addDays(today, 1), review(nowD));
    const prev = period === "week"
      ? bucketDays(events, calendars, prevFrom, addDays(startOfDay(prevUntil), 1), review(prevUntil))
      : bucketDays(events, calendars, prevFrom, from, review(nowD));
    const days = cur.map((d) => d.date);
    const vs = period === "28d" ? "prior 4 wks" : period === "week" ? "last wk so far" : "prior 7 days";

    // sleep, by night as the day score reads it: measured sleep only (a
    // recurring Sleep plan or "In bed" isn't, nor a Sleep block canceled
    // ahead of time). The old fallback to calendar-day sleep counted the
    // plan the chart had just said wasn't measured.
    const sleepEvents = events.filter((e) => !isCanceled(e));
    const nights = sleepWindows(sleepEvents, calendars, days);
    const prevNights = sleepWindows(sleepEvents, calendars, prev.map((d) => d.date));
    const nightH = (ns: typeof nights) => ns.filter((x) => x).map((x) => x!.hours);
    const sleepCur = nightH(nights);
    const sleepPrev = nightH(prevNights);
    const bedtimes = nights.filter((x) => x).map((x) => x!.from);

    const scoreOf = (d: Date, until?: Date) => {
      const f = focusScore({ day: d, now: nowD, until, events, calendars, recon: (e) => markOf(e), reconSince: since });
      return f.hasData ? f.score : null;
    };
    const scores = days.map((d) => scoreOf(d));
    // (this week: last week's days only as far as the same moment)
    const prevScores = prev.map((d) => d.date).filter((d) => d < prevUntil)
      .map((d) => scoreOf(d, period === "week" ? prevUntil : undefined));
    const scoreNums = (xs: (number | null)[]) => xs.filter((x): x is number => x != null);
    // the 28-day calendar of scores
    const heatDays = Array.from({ length: 28 }, (_, i) => addDays(today, i - 27));
    const heat = heatDays.map((d) => ({ date: d, score: scoreOf(d) }));

    const deepCur = sum(cur.map((d) => d.deepH));
    const deepPrev = sum(prev.map((d) => d.deepH));
    const distCur = sum(cur.map((d) => d.distractionH));
    const distPrev = sum(prev.map((d) => d.distractionH));
    const awake = sum(cur.map((d, i) => (i === cur.length - 1 ? Math.max(1, (nowD.getTime() - today.getTime()) / 3600000 - d.sleepH) : Math.max(1, 24 - d.sleepH))));

    // where the time went: every calendar, sleep aside (a Sleep calendar's
    // events, or sleep on any other)
    const awakeEvents = events.filter((e) => classify(e, calendars) !== "sleep");
    const byCal = [...hoursByCalendar(awakeEvents, calendars, days, review(nowD)).entries()]
      .map(([id, hs]) => ({ id, name: calendars.find((c) => c.id === id)?.summary ?? "Other", hs, total: sum(hs) }))
      .filter((x) => x.total > 0.01)
      .sort((a, b) => b.total - a.total);
    const TOP = 7;
    const series = byCal.slice(0, TOP);
    if (byCal.length > TOP) {
      const rest = byCal.slice(TOP);
      series.push({ id: "", name: "Other", hs: days.map((_, i) => sum(rest.map((r) => r.hs[i]))), total: sum(rest.map((r) => r.total)) });
    }
    const dayTotals = days.map((_, i) => sum(series.map((s) => s.hs[i])));
    const tracked = sum(dayTotals);

    // when deep work and distraction happen
    const heatFrom = addDays(today, -27);
    const deepHeat = weekHourHeat(events, calendars, heatFrom, nowD, "deep", review(nowD));
    const deepProfile = Array.from({ length: 24 }, (_, h) => sum(deepHeat.map((r) => r[h])));
    const deepPeak = peakWindow(deepProfile, 3);
    const deepByDow = deepHeat.map((r) => sum(r));
    const distHeat = weekHourHeat(events, calendars, from, nowD, "distraction", review(nowD));
    const distProfile = Array.from({ length: 24 }, (_, h) => sum(distHeat.map((r) => r[h])));
    const distPeak = peakWindow(distProfile, 2);
    const sources = distractionBySource(events, calendars, from, nowD, review(nowD));

    // routines: on time (within ±30m of its usual time), off time, or missed
    const routines = ([
      ["Cold shower", /^cold shower/i],
      ["Lunch", /^lunch/i],
      ["Dinner", /^dinner/i],
      ["Stretching", /^stretch/i],
    ] as const).map(([label, re]) => {
      const hits = days.map((d) => {
        const e = events.find((x) => !x.all_day && re.test(x.summary) && startOfDay(eventDates(x).start).getTime() === d.getTime());
        if (!e || markOf(e) === "canceled") return null;
        const s = eventDates(e).start;
        // tonight's 7 PM dinner isn't "on time" at 2 PM
        if (s > nowD) return "later" as const;
        return s.getHours() * 60 + s.getMinutes();
      });
      const mins = hits.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
      if (!mins.length) return null;
      const med = mins[Math.floor(mins.length / 2)];
      return {
        label,
        med,
        hits: hits.map((x) => (x === "later" ? "later" : x == null ? "miss" : Math.abs(x - med) <= 30 ? "on" : "off")),
      };
    }).filter((x) => x != null);

    // the week ahead against a typical day of the last four weeks
    const typical = (() => {
      const past = bucketDays(events, calendars, addDays(today, -28), today, review(nowD));
      return avg(past.map((d) => d.deepH + d.distractionH + d.otherH));
    })();
    const ahead = Array.from({ length: 7 }, (_, i) => addDays(today, i + 1));
    // (bucketed as the typical day is: overlapping blocks are one stretch
    // of time, not their lengths added up)
    const aheadH = bucketDays(events.filter((e) => !isCanceled(e)), calendars, addDays(today, 1), addDays(today, 8))
      .map((b) => b.deepH + b.distractionH + b.otherH);
    const exams = events
      .filter((e) => /\b(exam|midterm|final|quiz)\b/i.test(e.summary) && !isCanceled(e))
      .filter((e) => { const s = eventDates(e).start; return s >= nowD && s < addDays(today, 15); })
      .sort((a, b) => eventDates(a).start.getTime() - eventDates(b).start.getTime());

    // highlights: what the numbers say, in plain words
    const lines: string[] = [];
    if (deepPrev > 0.25 && Math.abs(deepCur - deepPrev) / deepPrev >= 0.15) {
      const pct = Math.round(((deepCur - deepPrev) / deepPrev) * 100);
      lines.push(`Deep work is ${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% on the ${vs.replace(/^prior /, "previous ").replace("last wk so far", "same point last week")} (${fmtH(deepCur)} vs ${fmtH(deepPrev)}).`);
    }
    const bestI = cur.reduce((b, d, i) => (d.deepH > (cur[b]?.deepH ?? 0) ? i : b), 0);
    if (cur[bestI]?.deepH >= 0.5) lines.push(`Best focus day: ${format(cur[bestI].date, "EEE MMM d")}, ${fmtH(cur[bestI].deepH)} of deep work.`);
    if (deepPeak && deepPeak[1] >= 0.3) lines.push(`Your deep work clusters ${hourLabel(deepPeak[0])}–${hourLabel(deepPeak[0] + 3)} (${Math.round(deepPeak[1] * 100)}% of it, last 4 weeks).`);
    const short = sleepCur.filter((h) => h < 7).length;
    if (sleepCur.length >= 3 && short > 0) {
      lines.push(`Under 7h of sleep on ${short} of ${sleepCur.length} nights` + (bedtimes.length >= 3 ? `; bedtime varies ±${Math.round(sd(bedtimes) * 60)}m.` : "."));
    }
    if (distCur >= 0.5 && distPeak) {
      const top = sources[0];
      lines.push(`Distraction peaks ${hourLabel(distPeak[0])}–${hourLabel(distPeak[0] + 2)}` +
        (top && top[1] / distCur >= 0.35 ? `; ${top[0]} is ${Math.round((top[1] / distCur) * 100)}% of it.` : "."));
    }

    // plan kept: of the blocks that ended in the period and were reviewed
    // (Happened / Canceled), the share that happened; sleep aside
    const ended = events.filter((e) => {
      if (e.all_day || classify(e, calendars) === "sleep") return false;
      const { start, end } = eventDates(e);
      return start >= from && end <= nowD;
    });
    const kept = ended.filter((e) => markOf(e) === "done").length;
    const dropped = ended.filter((e) => markOf(e) === "canceled").length;
    const unreviewed = ended.length - kept - dropped;
    const planKept = kept + dropped >= 3 ? kept / (kept + dropped) : null;

    // deep work by weekday (last 4 weeks) and the streak of days with 2h+
    const deepDow = deepByDow;
    const bestDow = deepDow.indexOf(Math.max(...deepDow));
    // (over the last 60 days whatever the period: 7 days capped it at 6)
    const streakDays = bucketDays(events, calendars, addDays(today, -59), addDays(today, 1), review(nowD));
    let streak = 0;
    for (let i = streakDays.length - 1; i >= 0; i--) {
      // today counts only once it has 2h; an empty today doesn't break it
      if (streakDays[i].deepH >= 2) streak++;
      else if (i === streakDays.length - 1) continue;
      else break;
    }
    // deepDow holds 4 weeks: 20 weekdays and 8 weekend days
    const weekdayDeep = sum(deepDow.slice(1, 6)) / 20;
    const weekendDeep = (deepDow[0] + deepDow[6]) / 8;

    // one line per chart: what it says
    const DOWN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const take = {
      time: (() => {
        if (series.length < 2) return "";
        const [a, b] = series;
        const pct = (x: typeof a) => Math.round((x.total / Math.max(0.01, tracked)) * 100);
        const d = series.find((x) => /distraction/i.test(x.name));
        const rank = d ? series.indexOf(d) + 1 : 0;
        return `${a.name} ${pct(a)}%, then ${b.name} ${pct(b)}%` +
          (d && rank <= 3 ? ` · distraction is your #${rank} use of time` : "") + ".";
      })(),
      sleep: (() => {
        if (sleepCur.length < 2) return "";
        const short = sleepCur.filter((h) => h < 7).length;
        // a night is filed under the morning it ends: Fri/Sat nights end Sat/Sun
        const wkEnd = nights.filter((n, i) => n && [6, 0].includes(days[i].getDay())).map((n) => n!.from);
        const wkDay = nights.filter((n, i) => n && ![6, 0].includes(days[i].getDay())).map((n) => n!.from);
        const late = wkEnd.length && wkDay.length && avg(wkEnd) - avg(wkDay) >= 0.75
          ? ` · bedtime ${Math.round((avg(wkEnd) - avg(wkDay)) * 60)}m later on Fri/Sat nights` : "";
        return `${fmtH(avg(sleepCur))} a night · ${short ? `${short} of ${sleepCur.length} nights under 7h` : "every night 7h+"}${late}.`;
      })(),
      focus: (() => {
        if (sum(deepDow) < 1) return "";
        // "mostly" only when one 3h window holds a real share of it
        const when = deepPeak && deepPeak[1] >= 0.3 ? `Mostly ${hourLabel(deepPeak[0])}–${hourLabel(deepPeak[0] + 3)}` : "No clear time of day";
        const morning = sum(deepProfile.slice(0, 11));
        const beforeNoon = morning / Math.max(0.01, sum(deepProfile));
        const days_ = weekendDeep > weekdayDeep * 1.3 ? `; weekends out-work weekdays (${fmtH(weekendDeep)} vs ${fmtH(weekdayDeep)} a day)` :
          weekdayDeep > weekendDeep * 1.3 ? `; weekdays carry it (${fmtH(weekdayDeep)} vs ${fmtH(weekendDeep)} a day)` : "";
        return `${when}${beforeNoon < 0.1 ? ", almost none before 11 AM" : ""}${days_} · best day ${DOWN[bestDow]}.`;
      })(),
      dist: (() => {
        if (!sources.length || distCur < 0.25) return "";
        const top = sources[0];
        const share = Math.round((top[1] / distCur) * 100);
        const evening = sum(distProfile.slice(18)) + sum(distProfile.slice(0, 3));
        const eveningShare = Math.round((evening / Math.max(0.01, distCur)) * 100);
        return `${top[0]} is ${share}% of it` + (eveningShare >= 50 ? `; ${eveningShare}% happens after 6 PM` : "") +
          (distPeak ? ` · peak ${hourLabel(distPeak[0])}–${hourLabel(distPeak[0] + 2)}` : "") + ".";
      })(),
      score: (() => {
        const scored = heat.filter((h) => h.score != null) as { date: Date; score: number }[];
        if (scored.length < 3) return "";
        const best = scored.reduce((b, h) => (h.score > b.score ? h : b));
        const worst = scored.reduce((b, h) => (h.score < b.score ? h : b));
        // (all tied: no best and lowest day, and no weekday "scores highest")
        if (Math.round(best.score) === Math.round(worst.score)) return `Every day scored ${Math.round(best.score)}.`;
        const byDow = [0, 1, 2, 3, 4, 5, 6].map((dw) => {
          const xs = scored.filter((h) => h.date.getDay() === dw).map((h) => h.score);
          return xs.length ? avg(xs) : NaN;
        });
        const known = byDow.filter((x) => Number.isFinite(x));
        const topDow = byDow.indexOf(Math.max(...known));
        const clear = known.length > 1 && Math.max(...known) > Math.min(...known);
        return `Best ${format(best.date, "EEE MMM d")} (${Math.round(best.score)}), lowest ${format(worst.date, "EEE MMM d")} (${Math.round(worst.score)})` +
          (clear ? ` · ${DOWN[topDow]}s score highest` : "") + ".";
      })(),
      ahead: (() => {
        const heavy = ahead.filter((_, i) => aheadH[i] > typical * 1.25);
        const light = ahead.filter((_, i) => aheadH[i] < typical * 0.5);
        const parts = [];
        if (heavy.length) parts.push(`heavy: ${heavy.map((d) => format(d, "EEE")).join(", ")}`);
        if (light.length) parts.push(`room to work: ${light.map((d) => format(d, "EEE")).join(", ")}`);
        if (exams.length) parts.push(`${exams.length} exam${exams.length > 1 ? "s" : ""}/quiz${exams.length > 1 ? "zes" : ""} within 2 weeks`);
        return parts.length ? parts.join(" · ") + "." : "An ordinary week ahead.";
      })(),
    };

    // the longest single deep-work block that happened in the period
    const longestDeep = Math.max(0, ...events
      .filter((e) => !e.all_day && classify(e, calendars) === "deep" && markOf(e) !== "canceled")
      .map((e) => {
        const { start, end } = eventDates(e);
        // (the panel's 4 weeks, as its note says, not the selected period)
        if (start < heatFrom || start >= nowD) return 0;
        return (Math.min(end.getTime(), nowD.getTime()) - start.getTime()) / 3600000;
      }));

    return {
      longestDeep, planKept, kept, dropped, unreviewed, streak, deepDow, take,
      days, vs, cur, nights, sleepCur, sleepPrev, bedtimes, scores, prevScores, scoreNums, heat,
      deepCur, deepPrev, distCur, distPrev, awake, series, dayTotals, tracked,
      deepHeat, deepByDow, deepPeak, distProfile, distPeak, sources, routines,
      typical, ahead, aheadH, exams, lines, from,
    };
  }, [events, calendars, reconTick, period, prefs.deepCalendars]); // eslint-disable-line react-hooks/exhaustive-deps

  // this day's and this week's goals: the ones a tick can still change
  const goalTasks = goals.file.goals.filter((g) => g.horizon !== "long");
  const goalsDone = goalTasks.filter((g) => goals.isDone(g)).length;

  const scoreAvg = avg(m.scoreNums(m.scores));
  const scorePrev = avg(m.scoreNums(m.prevScores));
  const sleepAvg = avg(m.sleepCur);
  const colorOfSeries = (id: string) => (id ? colorOf(calendars, id) : "var(--fg-faint)");
  const deepColor = colorOf(calendars, calendars.find((c) => /^homework$/i.test(c.summary.trim()))?.id ?? "") || "var(--focus)";
  const maxDay = Math.max(0.5, ...m.dayTotals);
  const dense = m.days.length > 10;
  // sleep chart: 8 PM the evening before to noon
  const S0 = -4;
  const S1 = 12;
  const sy = (h: number) => ((Math.min(S1, Math.max(S0, h)) - S0) / (S1 - S0)) * 100;
  const HOURS = [...Array.from({ length: 18 }, (_, i) => i + 6), 0, 1, 2]; // 6 AM → 2 AM
  const deepProfileAll = Array.from({ length: 24 }, (_, h) => sum(m.deepHeat.map((r) => r[h])));
  const deepProfMax = Math.max(0.01, ...deepProfileAll);
  const distMax = Math.max(0.01, ...m.distProfile);
  const srcMax = Math.max(0.01, ...m.sources.map((s) => s[1]));
  const aheadMax = Math.max(m.typical, ...m.aheadH, 1);

  return (
    <div className="insightsview" data-testid="insights-view">
      <div className="ins-wrapper">
        <header className="ins-head">
          <div>
            <h2>Insights</h2>
            <span className="ins-note">
              {format(m.days[0], "MMM d")} – {format(m.days[m.days.length - 1], "MMM d")} · compared with the {m.vs.replace(/^prior/, "previous").replace("last wk so far", "same point last week")}
            </span>
          </div>
          <div className="ins-seg" role="tablist" aria-label="Period">
            {PERIODS.map(([p, label]) => (
              <button key={p} role="tab" aria-selected={period === p} className={period === p ? "on" : ""} onClick={() => setPeriod(p)}>
                {label}
              </button>
            ))}
          </div>
        </header>

        <section className="ins-card ins-highlights" data-testid="ins-report">
          <h3>Highlights</h3>
          {m.lines.length > 0 ? (
            <ul>
              {m.lines.slice(0, 5).map((l) => <li key={l}>{l}</li>)}
            </ul>
          ) : (
            <p className="ins-note">Not much logged in this period yet: the patterns show up as your calendar fills in.</p>
          )}
        </section>

        <div className="ins-kpis">
          <Card
            id="ins-deepwork"
            label="Deep work"
            value={fmtH(m.deepCur)}
            delta={<Delta value={m.deepCur - m.deepPrev} base={m.deepPrev} vs={m.vs} />}
            sub={`${fmtH(m.deepCur / Math.max(1, m.days.length))} a day` + (m.streak >= 2 ? ` · ${m.streak}-day streak of 2h+` : "")}
          >
            <MiniBars values={m.cur.map((d) => d.deepH)} days={m.days} fmt={fmtH} color={deepColor} />
          </Card>
          <Card
            id="ins-sleep"
            label="Sleep"
            value={m.sleepCur.length ? fmtH(sleepAvg) : "–"}
            delta={m.sleepCur.length && m.sleepPrev.length ? <Delta value={sleepAvg - avg(m.sleepPrev)} base={avg(m.sleepPrev)} vs={m.vs} /> : undefined}
            sub={m.bedtimes.length >= 2 ? `a night · bedtime ${clock(avg(m.bedtimes))} ±${Math.round(sd(m.bedtimes) * 60)}m` : "a night"}
          >
            <MiniBars values={m.nights.map((n) => n?.hours ?? null)} days={m.days} fmt={fmtH} color="var(--ins-sleep)" max={10} />
          </Card>
          <Card
            id="ins-distraction"
            label="Distraction"
            value={fmtH(m.distCur)}
            delta={<Delta value={m.distCur - m.distPrev} base={m.distPrev} goodWhenDown vs={m.vs} />}
            sub={`${Math.round((m.distCur / Math.max(1, m.awake)) * 100)}% of awake time` + (m.sources[0] ? ` · top: ${m.sources[0][0]} ${fmtH(m.sources[0][1])}` : "")}
          >
            <MiniBars values={m.cur.map((d) => d.distractionH)} days={m.days} fmt={fmtH} color="var(--ins-bad)" />
          </Card>
          <Card
            id="ins-score"
            label="Day score"
            value={m.scoreNums(m.scores).length ? String(Math.round(scoreAvg)) : "–"}
            delta={m.scoreNums(m.scores).length && m.scoreNums(m.prevScores).length
              ? <Delta value={scoreAvg - scorePrev} base={scorePrev} unit="pts" vs={m.vs} /> : undefined}
            sub="average of 100"
          >
            <MiniBars values={m.scores} days={m.days} fmt={(v) => `${Math.round(v)}`} color="var(--ins-good)" max={100} />
          </Card>
        </div>

        <div className="ins-cols">
          <Panel
            id="ins-alloc"
            className="wide"
            title="Where your time went"
            note={`${fmtH(m.tracked)} on your calendars, sleep aside`}
          >
            {m.series.length === 0 ? (
              <p className="ins-empty">Nothing on your calendars in this period yet.</p>
            ) : (
              <>
                <div className={"ins-stack" + (dense ? " dense" : "")}>
                  {m.days.map((d, i) => (
                    <div key={i} className="ins-stack-col" title={`${format(d, "EEE MMM d")}: ${fmtH(m.dayTotals[i])}`}>
                      <div className="ins-stack-bar" style={{ height: `${(m.dayTotals[i] / maxDay) * 100}%` }}>
                        {m.series.map((s) => s.hs[i] > 0 && (
                          <span key={s.id || "other"} style={{ flexGrow: s.hs[i], background: colorOfSeries(s.id) }} title={`${s.name}: ${fmtH(s.hs[i])}`} />
                        ))}
                      </div>
                      <span className="ins-axis">{dense ? (d.getDay() === 1 ? format(d, "M/d") : "") : format(d, "EEE")}</span>
                    </div>
                  ))}
                </div>
                <div className="ins-share" aria-label="Share of time by calendar">
                  {m.series.map((s) => (
                    <span key={s.id || "other"} style={{ flexGrow: s.total, background: colorOfSeries(s.id) }} title={`${s.name}: ${fmtH(s.total)}`} />
                  ))}
                </div>
                <ul className="ins-legend">
                  {m.series.map((s) => (
                    <li key={s.id || "other"} title={fmtH(s.total)}>
                      <span className="ins-swatch" style={{ background: colorOfSeries(s.id) }} />
                      <span className="ins-legend-name">{s.name}</span>
                      <span className="ins-legend-pct">{Math.round((s.total / Math.max(0.01, m.tracked)) * 100)}%</span>
                    </li>
                  ))}
                </ul>
                {m.take.time && <p className="ins-take">{m.take.time}</p>}
              </>
            )}
          </Panel>

          <Panel
            id="ins-sleep-chart"
            title="Sleep"
            note={m.bedtimes.length ? <>asleep {clock(avg(m.bedtimes))} on average · <span className="ins-key short" /> under 7h</> : undefined}
          >
            {m.nights.every((n) => !n) ? (
              <p className="ins-empty">No measured sleep in this period.</p>
            ) : (
              <div className="ins-sleep">
                <div className="ins-sleep-axis">
                  {[-4, 0, 4, 8, 12].map((h) => (
                    <span key={h} style={{ top: `${sy(h)}%` }}>{h === 0 ? "12 AM" : h === 12 ? "12 PM" : clock(h)}</span>
                  ))}
                </div>
                <div className={"ins-sleep-plot" + (dense ? " dense" : "")}>
                  <div className="ins-sleep-area">
                    {[0, 8].map((h) => <span key={h} className="ins-sleep-grid" style={{ top: `${sy(h)}%` }} />)}
                    {m.nights.map((n, i) => (
                      <div key={i} className="ins-sleep-col" title={n ? `${format(m.days[i], "EEE MMM d")}: ${clock(n.from)} – ${clock(n.to)}, ${fmtH(n.hours)}` : `${format(m.days[i], "EEE MMM d")}: no data`}>
                        {n && (
                          <span
                            className={"ins-sleep-bar" + (n.hours < 7 ? " short" : "")}
                            style={{ top: `${sy(n.from)}%`, height: `${Math.max(1, sy(n.to) - sy(n.from))}%` }}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="ins-sleep-labels">
                    {m.days.map((d, i) => (
                      <span key={i} className="ins-axis">{dense ? (d.getDay() === 1 ? format(d, "M/d") : "") : format(d, "EEE")}</span>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {m.take.sleep && <p className="ins-take">{m.take.sleep}</p>}
          </Panel>

          <Panel id="ins-score-cal" title="Day score" note="last 4 weeks">
            <div className="ins-cal">
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span key={i} className="ins-cal-dow">{d}</span>)}
              {m.heat.map((s, i) => (
                <span
                  key={i}
                  className={"ins-cell" + (s.score == null ? " none" : "")}
                  title={`${format(s.date, "MMM d")}: ${s.score ?? "no data"}`}
                  style={{
                    gridColumn: i === 0 ? s.date.getDay() + 1 : undefined,
                    "--v": s.score == null ? 0 : s.score / 100,
                  } as CSSProperties}
                >
                  {s.date.getDate()}
                </span>
              ))}
            </div>
            <div className="ins-scale"><span>0</span><span className="ins-scale-bar" /><span>100</span></div>
            {m.take.score && <p className="ins-take">{m.take.score}</p>}
          </Panel>

          <Panel id="ins-fragmentation" title="When you focus" note="deep work, last 4 weeks">
            {sum(m.deepDow) < 0.25 ? (
              <p className="ins-empty">No deep work in the last 4 weeks.</p>
            ) : (
              <>
                <div className="ins-hours" aria-label="Deep work by hour of day">
                  {HOURS.map((h) => (
                    <span key={h} className="ins-hours-col" title={`${hourLabel(h)}: ${fmtH(deepProfileAll[h])}`}>
                      <span style={{ height: `${(deepProfileAll[h] / deepProfMax) * 100}%`, background: deepColor }} />
                    </span>
                  ))}
                </div>
                {/* each label over its own column (21 columns: spread evenly,
                    "12 AM" sat over 2 AM) */}
                <div className="ins-hours-axis placed">
                  {[["6 AM", 0], ["12 PM", 6], ["6 PM", 12], ["12 AM", 18]].map(([l, i]) => (
                    <span key={l} style={{ left: `${(((i as number) + 0.5) / HOURS.length) * 100}%` }}>{l}</span>
                  ))}
                </div>
                <div className="ins-dow-bars" aria-label="Deep work by weekday">
                  {m.deepDow.map((v, dw) => (
                    <div key={dw} className="ins-dow-col" title={`${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dw]}: ${fmtH(v / 4)} a day`}>
                      <span className="ins-dow-val">{fmtH(v / 4)}</span>
                      <span className="ins-dow-track"><span style={{ height: `${(v / Math.max(0.01, ...m.deepDow)) * 100}%`, background: deepColor }} /></span>
                      <span className="ins-axis">{["S", "M", "T", "W", "T", "F", "S"][dw]}</span>
                    </div>
                  ))}
                </div>
                <p className="ins-take">{m.take.focus}</p>
                <p className="ins-foot">
                  {avg(m.cur.map((d) => d.switches)).toFixed(1)} context switches a day · longest deep block {fmtH(m.longestDeep)}
                </p>
              </>
            )}
          </Panel>

          <Panel id="ins-distraction-chart" title="Distractions" note="by source, and by hour of day">
            {m.sources.length === 0 ? (
              <p className="ins-empty">No distraction logged in this period.</p>
            ) : (
              <>
                <ul className="ins-hbars">
                  {m.sources.slice(0, 5).map(([src, h]) => (
                    <li key={src}>
                      <span className="ins-hbar-name">{src}</span>
                      <span className="ins-hbar-track"><span style={{ width: `${(h / srcMax) * 100}%` }} /></span>
                      <span className="ins-hbar-val">{fmtH(h)}</span>
                    </li>
                  ))}
                </ul>
                <div className="ins-hours" aria-label="Distraction by hour of day">
                  {m.distProfile.map((v, h) => (
                    <span key={h} className="ins-hours-col" title={`${hourLabel(h)}: ${fmtH(v)}`}>
                      <span style={{ height: `${(v / distMax) * 100}%` }} />
                    </span>
                  ))}
                </div>
                <div className="ins-hours-axis"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>12 AM</span></div>
                {m.take.dist && <p className="ins-take">{m.take.dist}</p>}
              </>
            )}
          </Panel>

          <Panel id="ins-routines" title="Follow-through" note="did the plan happen?">
            <div className="ins-kept">
              <div className="ins-kept-stat" data-testid="ins-plan-kept">
                <span className="ins-big">{m.planKept == null ? "–" : `${Math.round(m.planKept * 100)}%`}</span>
                <span className="ins-note">
                  plan kept{m.planKept == null
                    ? ` · review ${Math.max(0, 3 - m.kept - m.dropped)} more block${3 - m.kept - m.dropped === 1 ? "" : "s"} (R) to see it`
                    : `: ${m.kept} of ${m.kept + m.dropped} reviewed blocks happened`}
                  {m.unreviewed > 0 ? ` · ${m.unreviewed} not reviewed` : ""}
                </span>
              </div>
              {goalTasks.length > 0 && (
                <div className="ins-kept-stat" data-testid="ins-goals">
                  <span className="ins-big">{goalsDone}/{goalTasks.length}</span>
                  <span className="ins-note">daily and weekly goals ticked</span>
                </div>
              )}
            </div>
            {m.routines.length === 0 ? (
              <p className="ins-empty">No routines (cold shower, lunch, dinner, stretching) in this period.</p>
            ) : (
              <ul className="ins-routines">
                {m.routines.map((r) => (
                  <li key={r!.label}>
                    <span className="ins-routine-name">{r!.label}</span>
                    <span className={"ins-dots" + (dense ? " dense" : "")}>
                      {r!.hits.map((h, i) => <span key={i} className={"ins-dot " + h} title={`${format(m.days[i], "EEE MMM d")}: ${h === "on" ? "on time" : h === "off" ? "off its usual time" : h === "later" ? "later today" : "missed"}`} />)}
                    </span>
                    <span className="ins-routine-stat">
                      {r!.hits.filter((h) => h === "on").length}/{r!.hits.filter((h) => h !== "later").length} on time · {clock(r!.med / 60)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel id="ins-forecast" title="Coming up" note={`next 7 days · dashed: a typical day (${fmtH(m.typical)})`}>
            <div className="ins-ahead">
              {m.ahead.map((d, i) => (
                <div key={i} className="ins-ahead-col" title={`${format(d, "EEE MMM d")}: ${fmtH(m.aheadH[i])} scheduled`}>
                  <span className="ins-ahead-val">{fmtH(m.aheadH[i])}</span>
                  <div className="ins-ahead-track">
                    <span className={"ins-ahead-bar" + (m.aheadH[i] > m.typical * 1.25 ? " heavy" : "")} style={{ height: `${(m.aheadH[i] / aheadMax) * 100}%` }} />
                    <span className="ins-ahead-typical" style={{ bottom: `${(m.typical / aheadMax) * 100}%` }} />
                  </div>
                  <span className="ins-axis">{format(d, "EEE")}</span>
                </div>
              ))}
            </div>
            <p className="ins-take">{m.take.ahead}</p>
            {m.exams.length > 0 && (
              <ul className="ins-exams">
                {m.exams.slice(0, 5).map((e) => (
                  <li key={`${e.calendar_id}/${e.id}`}>
                    <span className="ins-exam-date">{format(eventDates(e).start, "EEE MMM d")}</span>
                    <span className="ins-exam-name">{e.summary}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
