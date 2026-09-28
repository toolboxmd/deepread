# Deep Read

Type a topic and read one long, continuous article about it. The text is
written as you read: roughly two screens ahead of you, never faster than a fast
reader can read.

This is a local prototype. It answers two questions: does a live,
reading-paced article feel good, and which design fits it.

## Run

```sh
./dev
```

Open <http://localhost:4317>. The key is read from OpenBao on `rocky`
(`shared/openrouter/agents`) unless `OPENROUTER_API_KEY` is set.

Settings, all optional environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEEPREAD_MODEL` | `x-ai/grok-4.7` | OpenRouter model ID |
| `DEEPREAD_EFFORT` | `medium` | Reasoning effort |
| `DEEPREAD_MAX_WPM` | `700` | Fastest reading pace allowed, words per minute |
| `PORT` | `4317` | Local port |

## Design variants

Add `?variant=A`, `B`, or `C` to the URL, or use the pink bar at the bottom
(arrow keys also work): A is Book, B is Night, C is Margin.

## How it works

- `server.mjs` holds the key and each article's conversation, streams chunks
  from OpenRouter, and refuses a new chunk when the reader is ahead of the
  reading budget. The page cannot send its own prompts.
- `public/app.js` requests the next chunk when less than about one screen of
  unread text remains, and stops downward scrolling from outrunning the
  reading pace.
- `prompt.md` is the system prompt.
