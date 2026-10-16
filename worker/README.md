# Booking-links worker (Phase 5)

Serverless availability/booking pages on Cloudflare Workers (free tier).
No database: availability comes from Google free/busy, bookings become
Google Calendar events with a Meet link, and they appear in the desktop app
via normal sync.

## One-time deploy (needs your Cloudflare account)

```bash
cd worker
npm i -g wrangler            # or: npm x wrangler@latest …
wrangler login               # opens browser
wrangler kv namespace create BOOKING_RULES
# paste the printed id into wrangler.toml's kv_namespaces id

wrangler secret put GOOGLE_CLIENT_ID      # from ../.oauth.local.json
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_REFRESH_TOKEN < "$HOME/Library/Application Support/com.joshuayang.calendar-app/google_refresh.token"
wrangler secret put ADMIN_TOKEN           # any long random string, e.g. `openssl rand -hex 24`

wrangler deploy
```

## Create a booking link

```bash
curl -X PUT "https://calendar-booking.<your-subdomain>.workers.dev/api/rules/chat" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{
    "title": "Chat with me", "durationMin": 30,
    "timezone": "America/New_York",
    "days": [1,2,3,4,5], "hours": {"start": "10:00", "end": "17:00"},
    "bufferMin": 15, "minNoticeHours": 3, "maxDaysAhead": 14,
    "calendarId": "you@example.com",
    "busyCalendars": ["you@example.com"]
  }'
```

Share `https://calendar-booking.<your-subdomain>.workers.dev/chat`.

## Notes
- Slots endpoint exposes only open times, never event details.
- Booking re-validates against free/busy at submit time (409 if taken).
- `sendUpdates=all` emails the booker a real calendar invite.
- Local test: `wrangler dev` (uses the same secrets via `wrangler secret`),
  or `wrangler dev --local` with `--var` overrides.
