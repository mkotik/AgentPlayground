import express from 'express';

const app = express();
const port = Number(process.env.PORT) || 3001;

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'agent-playground-server',
  });
});

app.get('/api', (_req, res) => {
  res.status(200).json({
    message: 'REST API is running',
  });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
