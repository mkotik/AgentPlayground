# rag-chat

Minimal full-stack chat app using OpenRouter on the server through LangChain.

## Structure

- `client`: React + TypeScript + Vite app
- `server`: Node REST API that forwards chat requests to OpenRouter with LangChain

## Run

In one terminal:

```bash
cd server
npm install
OPENROUTER_API_KEY=your_key_here npm run dev
```

In another terminal:

```bash
cd client
npm install
npm run dev
```

Open the Vite URL, usually `http://localhost:5173`. Enter a prompt in the text area and the client will send the full transcript to `POST /api/chat`.

## Environment

- `OPENROUTER_API_KEY` is required.
- `OPENROUTER_MODEL` is optional. Default: `openai/gpt-4o-mini`
- `OPENROUTER_APP_URL` is optional and forwarded as `HTTP-Referer`.
- `OPENROUTER_APP_NAME` is optional and forwarded as `X-Title`.

The browser sends the full chat transcript to `POST /api/chat`, and the server returns the assistant reply.
