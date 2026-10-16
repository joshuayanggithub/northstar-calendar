// Booking-links worker: serves public availability pages backed directly by
// Google Calendar (no database — Google is the state store).
//
// Routes:
//   GET  /:slug            booking page
//   GET  /api/slots?slug=…&from=YYYY-MM-DD   open slots for ~2 weeks
//   POST /api/book         {slug, startIso, name, email, note?}
//   PUT  /api/rules/:slug  (Authorization: Bearer ADMIN_TOKEN) upsert rules
//
// Rules JSON (KV BOOKING_RULES[slug]):
// { "title": "Chat with me", "durationMin": 30, "timezone": "America/New_York",
//   "days": [1,2,3,4,5], "hours": {"start": "10:00", "end": "17:00"},
//   "bufferMin": 15, "minNoticeHours": 3, "maxDaysAhead": 14,
//   "calendarId": "you@example.com", "busyCalendars": ["you@example.com"] }

let cachedToken = null; // { token, exp }

async function accessToken(env) {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN.trim(),
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) throw new Error(`token refresh failed: ${resp.status}`);
  const j = await resp.json();
  cachedToken = { token: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  return cachedToken.token;
}

async function gapi(env, path, init = {}) {
  const token = await accessToken(env);
  const resp = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!resp.ok) throw new Error(`google api ${path}: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

/** Wall-clock parts of a UTC instant in an IANA timezone. */
function tzParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const dows = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    dow: dows[parts.weekday],
  };
}

function computeSlots(rules, busy, fromMs, toMs) {
  const stepMs = rules.durationMin * 60_000;
  const bufferMs = (rules.bufferMin ?? 0) * 60_000;
  const [hs, he] = [rules.hours.start, rules.hours.end].map((t) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  });
  const slots = [];
  // Walk 15-min boundaries; emit slot starts that fit entirely inside hours
  // and don't intersect any (buffered) busy interval.
  for (let t = Math.ceil(fromMs / 900_000) * 900_000; t + stepMs <= toMs; t += 900_000) {
    const start = new Date(t);
    const p = tzParts(start, rules.timezone);
    if (!(rules.days ?? [1, 2, 3, 4, 5]).includes(p.dow)) continue;
    const endOfSlotMin = p.minutes + rules.durationMin;
    if (p.minutes < hs || endOfSlotMin > he) continue;
    const clash = busy.some(
      (b) => t < b.end + bufferMs && t + stepMs > b.start - bufferMs,
    );
    if (!clash) slots.push(t);
  }
  return slots;
}

async function getBusy(env, rules, fromMs, toMs) {
  const body = {
    timeMin: new Date(fromMs).toISOString(),
    timeMax: new Date(toMs).toISOString(),
    items: (rules.busyCalendars ?? [rules.calendarId]).map((id) => ({ id })),
  };
  const j = await gapi(env, "/freeBusy", { method: "POST", body: JSON.stringify(body) });
  const busy = [];
  for (const cal of Object.values(j.calendars ?? {})) {
    for (const b of cal.busy ?? []) {
      busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
    }
  }
  return busy;
}

function slotWindow(rules) {
  const from = Date.now() + (rules.minNoticeHours ?? 0) * 3_600_000;
  const to = Date.now() + (rules.maxDaysAhead ?? 14) * 86_400_000;
  return [from, to];
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/slots" && request.method === "GET") {
        const slug = url.searchParams.get("slug") ?? "";
        const rules = await env.BOOKING_RULES.get(slug, "json");
        if (!rules) return json({ error: "unknown link" }, 404);
        const [from, to] = slotWindow(rules);
        const busy = await getBusy(env, rules, from, to);
        const slots = computeSlots(rules, busy, from, to);
        return json({
          title: rules.title,
          durationMin: rules.durationMin,
          timezone: rules.timezone,
          slots: slots.map((t) => new Date(t).toISOString()),
        });
      }

      if (url.pathname === "/api/book" && request.method === "POST") {
        const { slug, startIso, name, email, note } = await request.json();
        const rules = await env.BOOKING_RULES.get(slug, "json");
        if (!rules) return json({ error: "unknown link" }, 404);
        if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return json({ error: "valid name and email required" }, 400);
        }
        const start = Date.parse(startIso);
        if (!Number.isFinite(start)) return json({ error: "bad start" }, 400);
        const [from, to] = slotWindow(rules);
        if (start < from || start > to) return json({ error: "slot no longer available" }, 409);
        // Re-check freshness against free/busy right before booking.
        const busy = await getBusy(env, rules, start - 3_600_000, start + rules.durationMin * 60_000 + 3_600_000);
        const ok = computeSlots(rules, busy, start, start + rules.durationMin * 60_000).includes(start);
        if (!ok) return json({ error: "slot no longer available" }, 409);

        const end = start + rules.durationMin * 60_000;
        const event = await gapi(
          env,
          `/calendars/${encodeURIComponent(rules.calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
          {
            method: "POST",
            body: JSON.stringify({
              summary: `${rules.title}: ${name}`,
              description: `Booked via booking link.\n\n${note ?? ""}\n\n${name} <${email}>`,
              start: { dateTime: new Date(start).toISOString() },
              end: { dateTime: new Date(end).toISOString() },
              attendees: [{ email, displayName: name }],
              conferenceData: {
                createRequest: {
                  requestId: `book-${slug}-${start}`,
                  conferenceSolutionKey: { type: "hangoutsMeet" },
                },
              },
            }),
          },
        );
        return json({
          ok: true,
          start: new Date(start).toISOString(),
          meet: event.hangoutLink ?? null,
        });
      }

      if (url.pathname.startsWith("/api/rules/") && request.method === "PUT") {
        const auth = request.headers.get("authorization") ?? "";
        if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "unauthorized" }, 401);
        const slug = url.pathname.slice("/api/rules/".length);
        const rules = await request.json();
        if (!rules.durationMin || !rules.calendarId || !rules.timezone || !rules.hours) {
          return json({ error: "durationMin, calendarId, timezone, hours required" }, 400);
        }
        await env.BOOKING_RULES.put(slug, JSON.stringify(rules));
        return json({ ok: true, url: `${url.origin}/${slug}` });
      }

      // booking page
      const slug = url.pathname.slice(1);
      if (slug && !slug.includes("/") && request.method === "GET") {
        const rules = await env.BOOKING_RULES.get(slug, "json");
        if (!rules) return new Response("Not found", { status: 404 });
        return new Response(bookingPage(slug), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};

function bookingPage(slug) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Book time</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1f1f1f;--muted:#6f6e69;--border:rgba(0,0,0,.12);--accent:#4f8cff}
@media(prefers-color-scheme:dark){:root{--bg:#191919;--fg:#e8e8e6;--muted:#9b9a97;--border:rgba(255,255,255,.14)}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:16px}
.wrap{max-width:640px;margin:4vh auto}h1{font-size:20px}.muted{color:var(--muted)}
.day{margin:18px 0 6px;font-weight:600;font-size:13px;border-bottom:1px solid var(--border);padding-bottom:4px}
.slots{display:flex;flex-wrap:wrap;gap:8px}
.slot{border:1px solid var(--border);background:none;color:var(--fg);border-radius:8px;padding:7px 12px;cursor:pointer;font-size:13px}
.slot:hover{border-color:var(--accent);color:var(--accent)}
form{display:none;flex-direction:column;gap:10px;margin-top:20px;max-width:360px}
input,textarea{background:none;border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--fg);font:inherit}
button[type=submit]{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px;font-weight:600;cursor:pointer}
.ok{margin-top:24px;font-size:15px}
a{color:var(--accent)}
</style></head><body><div class="wrap">
<h1 id="title">Book time</h1><p class="muted" id="sub">Loading availability…</p>
<div id="days"></div>
<form id="form">
  <div class="muted" id="picked"></div>
  <input required name="name" placeholder="Your name">
  <input required type="email" name="email" placeholder="Email">
  <textarea name="note" rows="2" placeholder="Anything to add? (optional)"></textarea>
  <button type="submit">Confirm booking</button>
</form>
<div class="ok" id="done" style="display:none"></div>
</div>
<script>
const slug=${JSON.stringify(slug)};let picked=null;
const fmtT=s=>new Date(s).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
const fmtD=s=>new Date(s).toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});
fetch('/api/slots?slug='+encodeURIComponent(slug)).then(r=>r.json()).then(d=>{
  if(d.error){sub.textContent=d.error;return}
  title.textContent=d.title;sub.textContent=d.durationMin+' min · times shown in your local timezone';
  const byDay={};for(const s of d.slots){const k=new Date(s).toDateString();(byDay[k]??=[]).push(s)}
  days.innerHTML='';
  for(const k of Object.keys(byDay)){
    const h=document.createElement('div');h.className='day';h.textContent=fmtD(byDay[k][0]);days.appendChild(h);
    const row=document.createElement('div');row.className='slots';
    for(const s of byDay[k]){const b=document.createElement('button');b.className='slot';b.textContent=fmtT(s);
      b.onclick=()=>{picked=s;document.getElementById('picked').textContent='Booking '+fmtD(s)+' at '+fmtT(s);form.style.display='flex';form.scrollIntoView({behavior:'smooth'})};
      row.appendChild(b)}
    days.appendChild(row)}
  if(!d.slots.length)sub.textContent='No open times in the next two weeks.'});
form.onsubmit=async e=>{e.preventDefault();const f=new FormData(form);
  const r=await fetch('/api/book',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({slug,startIso:picked,name:f.get('name'),email:f.get('email'),note:f.get('note')})});
  const d=await r.json();
  if(d.ok){form.style.display='none';days.style.display='none';
    done.style.display='block';done.innerHTML='✅ Booked for <b>'+fmtD(d.start)+' at '+fmtT(d.start)+'</b>.'+(d.meet?' Meet link: <a href="'+d.meet+'">'+d.meet+'</a>':'')+' A calendar invite is on its way.'}
  else{done.style.display='block';done.textContent='⚠️ '+(d.error??'Booking failed; pick another time.')}};
</script></body></html>`;
}
