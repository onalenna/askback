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

Secrets (`.env`), WhatsApp login (`auth_info/`), and the local database are not in this repo.
