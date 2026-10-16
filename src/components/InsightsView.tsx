// Insights: ten consumable stats, one line each — a number, a delta, one
// sentence. No prose walls. Computed locally from the event store.

import { useEffect, useMemo, useState } from "react";
import { addDays, format, now, startOfDay, weekStart } from "../lib/dates";
import {
  avg,
  bucketDays,
  clockVarianceMin,
  focusScore,
  fmtH,
  routineStat,
  sum,
  topDistraction,
} from "../lib/insights";
import { eventDates } from "../lib/dates";
import { useGoals } from "../lib/goals";
import { readOnlyEvent, type Backend, type Calendar, type CalendarEvent } from "../lib/types";
import { colorOf } from "../lib/useBackend";
import { reconKey, reconOf, reconSince, subscribeRecon } from "../lib/recon";

function Delta({ value, goodWhenDown }: { value: number; goodWhenDown?: boolean }) {
  if (Math.abs(value) < 0.05) return <span className="ins-delta flat">· flat</span>;
  const up = value > 0;
  const good = goodWhenDown ? !up : up;
  return (
    <span className={"ins-delta " + (good ? "good" : "bad")}>
      {up ? "▲" : "▼"} {fmtH(Math.abs(value))} vs last wk
    </span>
  );
}

export function InsightsView(props: {
  backend: Backend | null;
  events: CalendarEvent[];
  calendars: Calendar[];
}) {
  const { calendars } = props;
  // only your calendars count: someone else's events count once copied in
  const events = useMemo(
    () => props.events.filter((e) => !readOnlyEvent(e, calendars)),
    [props.events, calendars],
  );
  const goals = useGoals(props.backend);
  // the day score credits reviewed events: recompute when a review lands
  const [reconTick, setReconTick] = useState(0);
  useEffect(() => subscribeRecon(() => setReconTick((t) => t + 1)), []);

  const model = useMemo(() => {
    const today = startOfDay(now());
    const wkStart = weekStart(now());
    const from = addDays(wkStart, -21); // 4-week window
    const to = addDays(today, 1);
    const days = bucketDays(events, calendars, from, to);
    const idx = (d: Date) => Math.floor((startOfDay(d).getTime() - from.getTime()) / 86400000);

    const thisWk = days.slice(idx(wkStart));
    const lastWk = days.slice(Math.max(0, idx(addDays(wkStart, -7))), idx(wkStart));

    const sleepThis = thisWk.map((d) => d.sleepH).filter((h) => h > 0);
    const sleepLast = lastWk.map((d) => d.sleepH).filter((h) => h > 0);
    const sleepStarts = events
      .filter((e) => !e.all_day && /^(sleep|asleep|in bed)/i.test(e.summary))
      .map((e) => eventDates(e).start)
      .filter((d) => d >= addDays(wkStart, -7));

    const distThis = sum(thisWk.map((d) => d.distractionH));
    const distLast = sum(lastWk.map((d) => d.distractionH));
    const awakeThis = sum(thisWk.map((d) => Math.max(1, 24 - d.sleepH)));

    const prodThis = sum(thisWk.map((d) => d.deepH));
    const prodLast = sum(lastWk.map((d) => d.deepH));

    const nowD = now();
    const since = reconSince();
    const scores = days.slice(-28).map((d) => {
      const f = focusScore({
        day: d.date,
        now: nowD,
        events,
        calendars,
        recon: (e) => reconOf(reconKey(e)),
        reconSince: since,
      });
      return { date: d.date, score: f.hasData ? f.score : null };
    });
    const scoreToday = scores[scores.length - 1]?.score ?? null;
    const scoreAvg = avg(scores.map((s) => s.score).filter((x): x is number => x != null));

    // allocation this week by calendar
    const alloc = new Map<string, number>();
    for (const e of events) {
      if (e.all_day) continue;
      const { start, end } = eventDates(e);
      if (start < wkStart || start >= to) continue;
      const name = calendars.find((c) => c.id === e.calendar_id)?.summary ?? "Other";
      alloc.set(name, (alloc.get(name) ?? 0) + (end.getTime() - start.getTime()) / 3600000);
    }
    const allocTop = [...alloc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const allocTotal = sum([...alloc.values()]);

    const routines = [
      ["Cold shower", /^cold shower/i],
      ["LUNCH", /^lunch/i],
      ["DINNER", /^dinner/i],
      ["Stretching", /^stretch/i],
    ] as const;

    const switches = avg(thisWk.map((d) => d.switches));
    const longest = Math.max(0, ...thisWk.map((d) => d.longestBlockH));
    const multitask = sum(thisWk.map((d) => d.multitaskH));

    // forecast: next 7 days scheduled non-sleep hours vs trailing 4-week avg
    const next7 = events.filter((e) => {
      if (e.all_day) return false;
      const { start } = eventDates(e);
      return start >= today && start < addDays(today, 7) && !/^(sleep|asleep)/i.test(e.summary);
    });
    const next7H = sum(next7.map((e) => {
      const { start, end } = eventDates(e);
      return (end.getTime() - start.getTime()) / 3600000;
    }));
    const past4wH = sum(days.map((d) => d.deepH + d.distractionH + d.otherH));
    const typicalWk = past4wH / 4;
    const exams = events.filter((e) => {
      const { start } = eventDates(e);
      return start >= today && start < addDays(today, 14) && /exam|midterm|quiz/i.test(e.summary);
    }).length;

    return {
      wkStart,
      sleepAvg: avg(sleepThis),
      sleepDelta: avg(sleepThis) - avg(sleepLast),
      bedVar: clockVarianceMin(sleepStarts),
      distThis,
      distDelta: distThis - distLast,
      distPct: awakeThis > 0 ? (distThis / awakeThis) * 100 : 0,
      topDist: topDistraction(
        events.filter((e) => eventDates(e).start >= wkStart),
        calendars,
      ),
      prodThis,
      prodDelta: prodThis - prodLast,
      scores,
      scoreToday,
      scoreAvg,
      allocTop,
      allocTotal,
      routines: routines
        .map(([label, re]) => [label, routineStat(events, re, wkStart, to)] as const)
        .filter(([, s]) => s != null),
      switches,
      longest,
      multitask,
      next7H,
      typicalWk,
      exams,
    };
  }, [events, calendars, reconTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // this day's and this week's goals: the ones a tick can still change
  const goalTasks = goals.file.goals.filter((g) => g.horizon !== "long");
  const goalsDone = goalTasks.filter((g) => goals.isDone(g)).length;

  const reportLines = (): string[] => [
    `Sleep ${fmtH(model.sleepAvg)} avg (${model.sleepDelta >= 0 ? "+" : ""}${fmtH(model.sleepDelta)})`,
    `Distraction ${fmtH(model.distThis)} (${Math.round(model.distPct)}% of awake)${model.topDist ? `, top: ${model.topDist[0]}` : ""}`,
    `Deep work ${fmtH(model.prodThis)} (${model.prodDelta >= 0 ? "+" : ""}${fmtH(model.prodDelta)})`,
    `Avg day score ${Math.round(model.scoreAvg)}/100`,
    goalTasks.length ? `Goals ${goalsDone}/${goalTasks.length} checked` : "",
  ].filter(Boolean);

  return (
    <div className="insightsview" data-testid="insights-view">
      <div className="ins-grid">
        <section className="ins-row" data-testid="ins-sleep">
          <span className="ins-label">Sleep</span>
          <span className="ins-big">{fmtH(model.sleepAvg)}</span>
          <Delta value={model.sleepDelta} />
          <span className="ins-note">bedtime drift ±{Math.round(model.bedVar)}m</span>
        </section>

        <section className="ins-row" data-testid="ins-distraction">
          <span className="ins-label">Distraction</span>
          <span className="ins-big">{fmtH(model.distThis)}</span>
          <Delta value={model.distDelta} goodWhenDown />
          <span className="ins-note">
            {Math.round(model.distPct)}% of awake time
            {model.topDist ? ` · top: ${model.topDist[0]} ${fmtH(model.topDist[1])}` : ""}
          </span>
        </section>

        <section className="ins-row" data-testid="ins-deepwork">
          <span className="ins-label">Deep work</span>
          <span className="ins-big">{fmtH(model.prodThis)}</span>
          <Delta value={model.prodDelta} />
          <span className="ins-note">longest block {fmtH(model.longest)}</span>
        </section>

        <section className="ins-row ins-score" data-testid="ins-score">
          <span className="ins-label">Day score</span>
          <span className="ins-big">{model.scoreToday ?? "–"}</span>
          <span className="ins-note">avg {Math.round(model.scoreAvg)}/100 · last 28 days:</span>
          <span className="ins-heat">
            {model.scores.map((s, i) => (
              <span
                key={i}
                className="ins-cell"
                title={`${format(s.date, "MMM d")}: ${s.score ?? "no data"}`}
                style={{
                  opacity: s.score == null ? 0.12 : 0.25 + (s.score / 100) * 0.75,
                }}
              />
            ))}
          </span>
        </section>

        <section className="ins-row ins-alloc" data-testid="ins-alloc">
          <span className="ins-label">This week went to</span>
          <span className="ins-bar">
            {model.allocTop.map(([name, h]) => (
              <span
                key={name}
                title={`${name}: ${fmtH(h)}`}
                style={{
                  width: `${(h / Math.max(model.allocTotal, 0.1)) * 100}%`,
                  background: colorOf(
                    calendars,
                    calendars.find((c) => c.summary === name)?.id ?? "",
                  ),
                }}
              />
            ))}
          </span>
          <span className="ins-note">
            {model.allocTop
              .slice(0, 3)
              .map(([n, h]) => `${n} ${fmtH(h)}`)
              .join(" · ")}
          </span>
        </section>

        {goalTasks.length > 0 && (
          <section className="ins-row" data-testid="ins-goals">
            <span className="ins-label">Goals</span>
            <span className="ins-big">
              {goalsDone}/{goalTasks.length}
            </span>
            <span className="ins-note">daily and weekly goals ticked</span>
          </section>
        )}

        <section className="ins-row" data-testid="ins-routines">
          <span className="ins-label">Routines</span>
          <span className="ins-note ins-wrap">
            {model.routines.length === 0 && "no routine anchors found this week"}
            {model.routines.map(([label, s]) => (
              <span key={label} className="ins-chip">
                {label} {s!.hit}/{s!.days} within ±30m of {s!.median}
              </span>
            ))}
          </span>
        </section>

        <section className="ins-row" data-testid="ins-fragmentation">
          <span className="ins-label">Focus</span>
          <span className="ins-big">{model.switches.toFixed(1)}</span>
          <span className="ins-note">context switches/day · multitasked {fmtH(model.multitask)} this wk</span>
        </section>

        <section className="ins-row" data-testid="ins-forecast">
          <span className="ins-label">Next 7 days</span>
          <span className="ins-big">{fmtH(model.next7H)}</span>
          <span className="ins-note">
            scheduled vs {fmtH(model.typicalWk)} typical
            {model.exams > 0 ? ` · ⚠ ${model.exams} exam${model.exams > 1 ? "s" : ""} within 14d` : ""}
          </span>
        </section>

        <section className="ins-row ins-report" data-testid="ins-report">
          <span className="ins-label">Week report</span>
          <span className="ins-note ins-wrap">
            {reportLines().join("  ·  ")}
          </span>
        </section>
      </div>
    </div>
  );
}
