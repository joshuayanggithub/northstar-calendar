# Focus score

The day-header badge and the Insights "Day score". Code: `focusScore()` in
`src/lib/insights.ts`; tests: `e2e/focus.spec.ts` (unit + gaming attempts);
real-data calibration: `e2e/focus.calibrate.spec.ts` (opt-in, private data).

## What it is for

The goals this app is built around move through long, hard, uninterrupted
thinking: studying, research, writing. The score asks one question per day: **how much real deep work
happened, and how well was the brain set up for it?** It is deliberately
pessimistic. A good day is ~60–70, 100 is rare, and no score can be
pushed up by logging things differently.

## Definitions

- **Deep work** is time on exactly three calendars: **Homework**,
  **Learning and Research**, **Enrichment** (matched by name, trimmed,
  case-insensitive). Class, Career, meetings and errands are not deep
  work, however useful they are.
- **Distraction** is the Distractions calendar, or any event titled
  "Distraction…".
- **Sleep** is measured sleep: "Asleep…" entries from the sleep tracker,
  or else non-recurring sleep events. A recurring "Sleep" block is a plan,
  not a measurement. "In bed" time is not sleep. The night that counts is
  the one ending on the morning of the scored day.
- **Interruption** is any other non-sleep event that overlaps a deep block,
  confirmed or not: class, a call, a meal, a distraction, or a second deep
  block booked on top.

## Formula

```
score = 100 · Work^0.5 · Restraint^0.3 · Recovery^0.3      (0 if there is no deep work)
```

It's multiplicative on purpose: one factor can't make up for another. A
day of deep work after a 4-hour night is not a great day, and perfect
sleep with no deep work scores 0. Work carries the largest exponent
because it is the thing being measured. The other two are the conditions
for it.

### Work (0–1): credited deep work

1. **Only reviewed time counts.** A past deep block is worth nothing
   until it is confirmed "happened" in reconciliation (it's "unconfirmed"
   in the popover). A block left to age out of the 48h review queue
   without confirmation counts half. Blocks from before reconciliation
   existed count in full. A canceled block counts nothing. A block still
   running counts nothing until it ends.
2. **Only the clean part counts.** Each block is cut by every interruption.
   Every stretch after an interruption loses **15 min** of re-immersion,
   and a stretch shorter than **25 min** after that counts nothing.
3. **Diminishing returns per sitting.** A sitting is a deep event plus any
   deep events less than 15 min from it. Within a sitting, the first 90
   clean minutes count fully, the next 90 count half, and nothing after
   that counts. A sitting claimed longer than 4h is treated as a
   placeholder, not focus, and decays as (240/span)².
4. **Discounts.** Deep work between midnight and 05:00 counts half. Time
   logged after it happened (the event was created more than 15 min after
   that time, per Google's `created`) counts 60%.
5. **Daily cap: 4h** of credit.
6. `Work = 0.7 · min(1, credit / 210 min) + 0.3 · min(1, best sitting's longest clean stretch / 90 min)`

### Restraint (0–1): distraction and fragmentation

```
Restraint = 1 / (1 + ((distraction + late distraction) / 120 min)^1.5) · 0.95^interruptions
```

- Distraction counts **whether or not it was confirmed**, so not
  reviewing it doesn't hide it. Overlapping distraction entries count
  once (the union of their time).
- **Late distraction** (23:00 to 05:00 the next morning) counts twice.
- 2h of distraction halves Restraint; 4h leaves about a quarter.

### Recovery (0–1): last night's sleep

`Recovery = duration · timing · regularity`:

| | 4h | 5h | 6h | 7h | 7.5–10h | 12h |
|---|---|---|---|---|---|---|
| duration | 0.15 | 0.40 | 0.65 | 0.90 | 1.00 | 0.85 |

| asleep by | 00:30 | 01:30 | 03:00 | 05:00 | 06:00+ |
|---|---|---|---|---|---|
| timing | 1.00 | 0.90 | 0.70 | 0.50 | 0.40 |

| off the past week's median bedtime (needs ≥3 nights) | ≤1h | 2h | 4h+ |
|---|---|---|---|
| regularity | 1.00 | 0.85 | 0.60 |

No sleep tracked: Recovery = **0.6**. Missing data is not treated as good
data.

## Why each piece (research)

| Piece | Basis |
|---|---|
| Deep work as its own category, measured in blocks | Newport, *Deep Work* (2016): value comes from distraction-free concentration, and shallow work, however busy, doesn't substitute. [book notes](https://www.alexhyett.com/book-notes/deep-work/), [review](https://www.redgreencode.com/book-review-deep-work-cal-newport/) |
| ~4h/day cap | Ericsson et al. (1993): elite performers sustain about 4h/day of deliberate practice. Newport adopts the same ceiling. [J. D. Cook summary](https://www.johndcook.com/blog/2013/02/04/four-hours-of-concentration/), [critical read](https://www.lesswrong.com/posts/8EmPhoxgSXGSdq4Cb/epistemic-spot-check-the-role-of-deliberate-practice-in-the) |
| Interruptions cost more than their own length | Mark, Gudith & Klocke (2008): interrupted work resumes after ~23 min on average. [UCI summary](https://www.informatics.uci.edu/forbes-brain-based-tips-for-sharpening-your-focus-gloria-mark-cited). DeMarco & Lister, *Peopleware*: ~15 min of immersion to get back into flow after each interruption. [Ganssle](https://www.ganssle.com/rants/cubiclemadness.htm), [Dr. Dobb's review](https://jacobfilipp.com/DrDobbs/articles/DDJ/1990/9012/9012k/9012k.htm). Hence the 15-min re-immersion and the 25-min minimum stretch. |
| Switching tasks is costly in itself | Rubinstein, Meyer & Evans (2001), task-switching cost. [APA Monitor](https://www.apa.org/monitor/oct01/multitask). Leroy (2009), attention residue: part of attention stays on the previous task (OBHDP 109(2), doi:10.1016/j.obhdp.2009.04.002). Hence the per-interruption Restraint factor on top of the lost time, and a sitting's curve that doesn't reset on a split. |
| Focus = long uninterrupted blocks | Microsoft Viva Insights counts focus time only in 2h uninterrupted blocks. [docs](https://learn.microsoft.com/en-us/viva/insights/tutorials/gm-focus). Rize scores focus quality from session length and context switches. [Rize data](https://rize.io/blog/the-hidden-cost-of-context-switching). Hence the 30% longest-block term. |
| Distraction drags the whole day | RescueTime's Productivity Pulse weights distracting time negatively against productive time. [how it's calculated](https://help.rescuetime.com/article/73-how-is-my-productivity-pulse-calculated). Here it is multiplicative and convex, so a little distraction costs little and a lot costs most of the day. |
| Sleep duration | AASM/SRS consensus (Watson et al. 2015): adults need ≥7h. [consensus](https://www.aasm.org/resources/pdf/adultsleepdurationconsensus.pdf). Van Dongen et al. (2003): two weeks at 6h/night degrades cognition as much as total sleep deprivation, and subjects don't notice. [PubMed](https://pubmed.ncbi.nlm.nih.gov/12683469/), [PDF](https://www.med.upenn.edu/uep/assets/user-content/documents/Van_Dongen_Dinges_Sleep_26_3_2003.pdf). Hence 6h → 0.65, not "close enough". |
| Sleep timing (late nights) | Late chronotype / late sleep timing predicts lower grades and shorter sleep in a university-wide study. [bioRxiv 2021](https://www.biorxiv.org/content/10.1101/2021.08.04.455177.full.pdf). Okano et al. (2019, MIT, Fitbit): later bedtimes and less consistent sleep predicted worse exam scores. [npj Sci. Learn.](https://dspace.mit.edu/handle/1721.1/127257) |
| Sleep regularity | Phillips et al. (2017, Sci. Rep.): irregular sleep–wake patterns predict lower academic performance independent of duration. [MIT DSpace](https://dspace.mit.edu/handle/1721.1/113615), [Brigham press release](https://www.brighamandwomens.org/about-bwh/newsroom/press-releases-detail?id=2742). |
| 90-min full-credit sitting | Practical heuristic: the common 90-min work cycle and Ericsson's practice sessions of about 60–90 min. Evidence for a strict 90-min waking cycle is weak, so after 90 min credit is halved, not cut off. |

## Gaming attempts and what stops them

| Attempt | Result |
|---|---|
| Log many 20-min "deep" blocks | Each stretch under 25 min is worth 0 (test: 12 × 20 min → score 0). |
| Hide a distraction under a deep block | The distraction cuts the block **and** counts as distraction **and** as an interruption. |
| Add a 1-min interruption to reset the 90-min curve | The curve is per sitting, so the interrupted halves stay one sitting and adding an event can only remove credit. A 300-case randomized property test checks that adding any non-deep event never raises the score. |
| Split one long block into adjacent events | Events less than 15 min apart are one sitting, so the score is identical (test). |
| One 14h "deep" placeholder, or 14 hour-long events back to back | The span decays as (240/span)², giving less than 15 min of credit (test). |
| Double-book two deep calendars | They interrupt each other, so the result is ≤ one block (test). |
| Never review deep blocks and wait for them to age out | Aged-out blocks count half; distraction counts unreviewed regardless. |
| Log deep work after the fact | Counts 60% (Google `created`). |
| Skip logging sleep | Untracked sleep counts 0.6, about what a 6h night counts. |
| Plan "Sleep 23:00–08:00" every day | A recurring sleep block is a plan and never counts as measured sleep. |
| Grind 01:00–05:00 | Half credit, and the late bedtime costs tomorrow's Recovery. |

## Calibration

The constants were calibrated on a month of real days (kept out of the
repository), with the opt-in spec:
`CALIBRATE=1 FOCUS_DATA=<dir> npx playwright test focus.calibrate`.
On that month the score ran from 0 to 70 with a median in the mid-30s: the
best days had near-zero distraction, credited deep time was often a third to
a fifth of what was logged (deep blocks overlapping other events was the
largest single loss), and falling asleep after 05:00 capped Recovery near
0.3 even after 6h+ of sleep.

## Limits

- It measures the calendar, not the brain. An honestly logged, confirmed
  block is believed. The structure only makes sure that logging *more*
  or *differently* never helps.
- Parameters are fixed constants (`FOCUS` in insights.ts), not learned.
  Recalibrate with the opt-in spec if the definitions change.
