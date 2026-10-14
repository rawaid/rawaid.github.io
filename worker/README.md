# Fridge guest book

A Cloudflare Worker that receives guest book entries (a photo and a note) from the fridge,
holds them in a queue, and serves the approved ones. Storage is Workers KV.

## Run it locally

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # local admin key
npm run dev                      # http://localhost:8787
```

In another terminal, serve the site from the repo root with `python3 -m http.server 8000` and open
http://localhost:8000. On localhost the fridge talks to `http://localhost:8787` automatically. If the
worker isn't running, entries just stay in your browser.

The queue is at http://localhost:8787/admin. The local key is the one in `.dev.vars`.

## Deploy

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create GUESTBOOK   # copy the id it prints into wrangler.toml
npx wrangler secret put ADMIN_KEY            # choose a long random key; this unlocks /admin
npx wrangler deploy                          # prints the worker's URL
```

Then paste the worker's URL into `GUESTBOOK_API` near the top of `index.html` and push the site.

## Settings

In `wrangler.toml`:

- `ALLOWED_ORIGINS`: the sites allowed to read and sign the guest book.
- `AUTO_APPROVE`: set to `"true"` to skip the queue and publish every entry immediately.

Optional secret: `npx wrangler secret put DISCORD_WEBHOOK` posts a message to that Discord webhook
whenever a new entry is waiting.

Limits are constants at the top of `src/index.js`: 5 entries per visitor per day, 150 per day overall,
photos up to 300 KB, names up to 24 characters, notes up to 140.

## Moderating

Open `<worker url>/admin`, enter the admin key, and approve or deny what's waiting. Deny deletes the
photo. Approved entries can be removed from the same page.
