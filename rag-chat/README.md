# rag-chat

Minimal split app for verifying client/server wiring.

## Structure

- `client`: React + TypeScript + Vite app
- `server`: basic Node REST API

## Run

In one terminal:

```bash
cd server
npm install
npm run dev
```

In another terminal:

```bash
cd client
npm install
npm run dev
```

Open the Vite URL, usually `http://localhost:5173`. The page will call `GET /api/health` and render the response from the server.
