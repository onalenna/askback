# askBack

WhatsApp assistant that answers in private chats and in groups you turn on. It uses uploaded files, the chat, and OpenAI. Replies match the language you used. Voice notes get a voice-note reply.

## Features

- **Answers from your files and chat** — upload PDFs, Office docs, images, audio, or WhatsApp exports; askBack answers questions from them.
- **Meeting and call summaries** — upload a recording and askBack turns it into Key points, Decisions, and Action items. Ask *"what did I miss in the last meeting?"* to get the summary. (Toggle: Meeting summaries.)
- **Catch me up** — ask *"catch me up"*, *"what did I miss since Monday"*, or *"what happened in the last 2 days"* and get a short recap of the group over that window.
- **Already-answered note** — when a question was answered before, askBack reuses that answer and notes when it came up, cutting repeat questions. (Toggle: Already-answered note.)
- **Source note** — answers built from a file end with a short *"Source: <file>"* line so people know where it came from. (Toggle: Show sources.)
- **Daily briefing** — an optional 05:00 CAT recap of yesterday plus today's deadlines.
- **Deadline reminders** — pings the group 30 minutes before a deadline or scheduled item.
- **Voice + many languages** — replies in the language you used; voice notes get a spoken reply.

New here as a developer? Read [CONTRIBUTING.md](CONTRIBUTING.md) for the module layout and how to add a feature.

## Run

```bash
npm install
cp .env.example .env   # add your keys
npm start
```

1. Scan the QR code (WhatsApp → Linked Devices).
2. Open http://localhost:3000
3. Upload files on Knowledge and turn on groups you want it to answer in.

## Put the admin online (revisionafrica.com/undpbot)

The WhatsApp bot and the admin panel are the same Node process. It has to keep running on a machine that stays on (a VPS is best). Then the website proxies `/undpbot` to it.

In `.env` on that machine:

```
HOST=127.0.0.1
PORT=3000
BASE_PATH=/undpbot
PUBLIC_ADMIN=1
ADMIN_USER=askback
ADMIN_PASSWORD=choose-a-strong-password
```

Nginx on the host that serves revisionafrica.com (see `deploy/nginx-undpbot.conf`):

```
location /undpbot/ {
  proxy_pass http://127.0.0.1:3000/undpbot/;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  client_max_body_size 80m;
}
```

Keep Node running with systemd (`deploy/askback.service`), then open https://revisionafrica.com/undpbot/ and sign in with `ADMIN_USER` / `ADMIN_PASSWORD`.

Local use stays at http://localhost:3000 with no login. Do not set `BASE_PATH` on your laptop.

Secrets (`.env`), WhatsApp login (`auth_info/`), and the local database are not in this repo.
