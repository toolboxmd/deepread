# Deep Read

Type a topic and read one long, continuous article about it. The text is
written as you read: a little ahead of you, never faster than a fast reader
can read.

Live at <https://deepread.toolbox.md>.

## Run locally

```sh
npm install
./dev
```

Open <http://localhost:4317>. `./dev` runs the Worker with `wrangler dev`. The
OpenRouter key is read from OpenBao on `rocky` (`shared/openrouter/agents`)
and passed only through the environment, unless `OPENROUTER_API_KEY` is set.

## How it works

- `src/worker.js` is a stateless Cloudflare Worker. The page sends the topic,
  the article so far and a word target; the Worker adds the OpenRouter key, the
  system prompt (`prompt.md`) and the model (`x-ai/grok-4.7`, low effort),
  and streams the next chunk. It rebuilds the same history every time so the
  prompt cache keeps matching.
- `public/` is the page. It measures how many words fit on the reader's
  screen, asks for about 1.5 screens at a time when less than one screen is
  left unread, and caps downward scrolling at 700 words per minute. Reading
  settings (text size, Paper/White/Black) sit behind the **Aa** button.
- Spending is bounded by the production key's own OpenRouter limit. Each chunk
  writes one log line (article id, chunk number, words, cost, cached tokens)
  to Cloudflare Workers Logs; nothing personal is recorded.

## Deploy

The production key lives in OpenBao at
`projects/deepread/production/openrouter` and is stored as the Worker secret
`OPENROUTER_API_KEY`. Deploy with `npx wrangler deploy` using the Cloudflare
operator credential from OpenBao.
