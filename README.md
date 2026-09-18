# askBack

WhatsApp assistant that answers in private chats and in groups you turn on. It uses uploaded files, the chat, and OpenAI. Replies match the language you used. Voice notes get a voice-note reply.

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
