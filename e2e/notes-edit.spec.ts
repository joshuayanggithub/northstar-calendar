// Margin notes: found by the 2026-10-20 run 5 bug-finder (each failed before its
// fix).
import { expect, test, type Page } from "@playwright/test";

const NOW = "2026-10-14T09:00:00";

async function open(page: Page) {
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 19 * 48));
  await expect(page.locator("[data-testid=margin-notes][data-pending='0']")).toHaveCount(1);
}
const tikTok = (page: Page) => page.getByTestId("margin-note").filter({ hasText: "Forty minutes of scrolling" });

/** record which backend writes the UI makes */
async function spy(page: Page) {
  await page.evaluate(() => {
    const be = (window as any).__mockBackend;
    (window as any).__calls = [];
    for (const name of ["updateEvent", "setEventNote", "updateSeriesMaster", "splitSeries"]) {
      const orig = be[name].bind(be);
      be[name] = (...args: any[]) => { (window as any).__calls.push(name); return orig(...args); };
    }
  });
}
const calls = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__calls);

const RULES = ["RRULE:FREQ=DAILY;UNTIL=20261031T000000Z"];
/** a daily series Oct 12–16, 10–11 AM; `noteOn` days carry a red-pen note */
async function openSeries(page: Page, noteOn: number[] = []) {
  const days = [12, 13, 14, 15, 16];
  const events = days.map((d) => {
    const start = `2026-10-${d}T10:00:00-04:00`;
    return {
      id: `ts_202610${d}T140000Z`, calendar_id: "primary", etag: null, summary: "Team sync",
      description: noteOn.includes(d) ? `[DRILL] occurrence note ${d}` : null,
      location: null, start, end: `2026-10-${d}T11:00:00-04:00`, all_day: false, timezone: "America/New_York",
      status: "confirmed", recurrence: null, recurring_event_id: "ts", conference_url: null, updated: null,
      raw: { masterRecurrence: RULES, originalStartTime: { dateTime: start } },
    };
  });
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events,
  });
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 8 * 48));
}
const rows = (page: Page) => page.evaluate(async () => {
  const be = (window as any).__mockBackend;
  return (await be.listEvents("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"))
    .map((e: any) => ({ start: e.start.slice(0, 10), summary: e.summary, description: e.description, rec: e.recurring_event_id }));
});

// ---------------------------------------------------------------- P2: Save after a note edit
// EventPanel.untouched() compares the note to the OPENED snapshot (state.event), but the
// note saved on its own the moment Enter was pressed. So Save thinks the note changed and
// writes the event again (a no-op PATCH, an "Updated …" undo step in front of the note's own).
// got: calls = [setEventNote, updateEvent]; toast "Updated “Distraction: TikTok”"; one ⌘Z undoes
// that no-op and the note stays "changed note" (a second ⌘Z is needed to get the old note back).
test("P2 panel: Save after editing the note writes nothing else, and one ⌘Z undoes the note", async ({ page }) => {
  await open(page);
  await spy(page);
  await page.locator(".chip-timed", { hasText: "TikTok" }).first().click();
  const p = page.getByTestId("event-panel");
  await p.getByTestId("drill-text").click();
  await p.getByTestId("drill-input").fill("changed note");
  await p.getByTestId("drill-input").press("Enter");
  await expect(p.getByTestId("drill-text")).toHaveText("changed note");
  await expect.poll(() => calls(page)).toEqual(["setEventNote"]);
  await p.getByRole("button", { name: /^Save/ }).click();
  await expect(p).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await calls(page), "the note was already saved; Save has nothing to write").toEqual(["setEventNote"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(tikTok(page), "the first ⌘Z after Save brings the previous note back").toHaveCount(1);
});

// Same root cause on a recurring occurrence: Save pops the scope dialog for a note that is
// already stored on this occurrence; "this and following" then SPLITS the series over nothing.
// got: scope-dialog shown; calls = [setEventNote, splitSeries]; rows: Oct 12 under master "ts"
// + a new one-row series (new id) — two series in Google for a no-op. (Picking "this" instead
// writes a no-op updateEvent + "Updated" undo step, as in the test above; on the FIRST
// occurrence "following" becomes updateSeriesMaster: "Updated all “Team sync” events".)
test("P2 panel: a note added on an occurrence, then Save: no scope question, no series split", async ({ page }) => {
  await openSeries(page);
  await spy(page);
  await page.locator(".chip-timed", { hasText: "Team sync" }).nth(1).click(); // Oct 13, ended (not the first: "following" splits)
  const p = page.getByTestId("event-panel");
  await p.getByTestId("drill-add").click();
  await p.getByTestId("drill-input").fill("occurrence note");
  await p.getByTestId("drill-input").press("Enter");
  await expect(p.getByTestId("drill-text")).toHaveText("occurrence note");
  await expect.poll(() => calls(page)).toEqual(["setEventNote"]);
  await p.getByRole("button", { name: /^Save/ }).click();
  await page.waitForTimeout(400);
  const dialog = page.getByTestId("scope-dialog");
  const asked = await dialog.count();
  if (asked) await dialog.getByTestId("scope-following").click(); // what a user who "changed nothing" may well pick
  await page.waitForTimeout(400);
  const r = await rows(page);
  const got = { asked, calls: await calls(page), rows: r.map((x: any) => [x.start, x.rec, x.description]) };
  expect(asked, `nothing but the (already saved) note changed: no scope question; got ${JSON.stringify(got)}`).toBe(0);
  expect(got.calls).toEqual(["setEventNote"]);
  expect(new Set(r.map((x: any) => x.rec ?? x.summary)).size, "still one series").toBe(1);
});

// ---------------------------------------------------------------- P2: note line after a Google web edit
// Google web re-saves a description as HTML. splitDrill (src/lib/drill.ts:16-19) only turns
// <br> and CLOSING </p> </div> into line breaks, and never decodes entities, so a note that
// comes back as "<p>[DRILL] …</p>" / "<span>[DRILL] …</span>" is not found at all (the marker
// then leaks into the editor's description), and "Q&amp;A" reads as "Q&amp;A" in the margin.
// got: 0 margin notes, panel description "Agenda\n[DRILL] Forty minutes…"; margin text
// "Don&#39;t scroll &amp; don&#39;t post".
async function setDesc(page: Page, description: string) {
  await page.evaluate(async (description) => {
    const be = (window as any).__mockBackend;
    const ev = (await be.listEvents("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).find((e: any) => /TikTok/.test(e.summary));
    await be.updateEvent(ev.id, { ...ev, description }, ev.calendar_id);
  }, description);
}
test("P2 notes: a note wrapped in <p>/<span> by Google web is still a note, and entities read as text", async ({ page }) => {
  await open(page);
  await setDesc(page, "<p>Agenda</p><p>[DRILL] Forty minutes of scrolling. Phone stays in the other room.</p>");
  await expect(tikTok(page), "<p>-wrapped note line").toHaveCount(1);
  await page.locator(".chip-timed", { hasText: "TikTok" }).first().click();
  await expect(page.getByTestId("event-panel").locator(".panel-desc")).not.toHaveValue(/\[DRILL\]/);
  await page.keyboard.press("Escape");
  await setDesc(page, "Agenda<br><br><span>[DRILL] Forty minutes of scrolling. Phone stays in the other room.</span>");
  await expect(tikTok(page), "<span>-wrapped note line").toHaveCount(1);
  await setDesc(page, "Agenda<br><br>[DRILL] Don&#39;t scroll &amp; don&#39;t post");
  await expect(page.getByTestId("margin-note")).toHaveText("Don't scroll & don't post");
});

// ---------------------------------------------------------------- P3: split loses the note's hand-placed spot
// "This and following" keeps the note on the occurrence (new row, new id) but the note pin
// (lib/notePins, keyed by event id) is not carried to the new id (App.tsx ~1361-1374 carries
// recon only; aliasRestored carries pins for undo-restores). The note jumps back to the placer.
// got: after the split the note is not .pinned and sits ~45px/32px from where it was put.
test("P3 series: 'this and following' keeps the note where it was placed by hand", async ({ page }) => {
  await openSeries(page, [14]);
  await expect(page.locator("[data-testid=margin-notes][data-pending='0']")).toHaveCount(1);
  const note = page.getByTestId("margin-note");
  await expect(note).toHaveCount(1);
  const b = (await note.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 6);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 40, b.y + 6 + 60, { steps: 8 });
  await page.mouse.up();
  await expect(note).toHaveClass(/pinned/);
  const placed = (await note.boundingBox())!;
  await page.locator(".chip-timed", { hasText: "Team sync" }).nth(2).click(); // Oct 14, the noted one
  const p = page.getByTestId("event-panel");
  await expect(p.getByTestId("drill-text")).toHaveText("occurrence note 14");
  await p.locator(".panel-title").fill("Team sync v2");
  await p.getByRole("button", { name: /^Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect(page.getByTestId("toast")).toContainText("and following");
  await expect(page.locator("[data-testid=margin-notes][data-pending='0']")).toHaveCount(1);
  const after = page.getByTestId("margin-note").filter({ hasText: "occurrence note 14" });
  await expect(after, "the note went with the occurrence").toHaveCount(1);
  await expect(after, "and so did its hand-placed spot").toHaveClass(/pinned/);
  const nb = (await after.boundingBox())!;
  expect(Math.abs(nb.x - placed.x)).toBeLessThan(3);
  expect(Math.abs(nb.y - placed.y)).toBeLessThan(3);
});

test("notes: a Google-HTML description with a note shows its body without a leading blank line", async ({ page }) => {
  await open(page);
  await setDesc(page, "<p>Agenda line</p><p><span>[DRILL] Ship &amp; &quot;test&quot;</span></p>");
  await expect(page.getByTestId("margin-note")).toHaveText('Ship & "test"');
  await page.locator(".chip-timed", { hasText: "TikTok" }).first().click();
  await expect(page.getByTestId("event-panel").locator(".panel-desc")).toHaveValue("Agenda line"); // got: "\nAgenda line"
});
