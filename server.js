import 'dotenv/config';
import express from 'express';
import handler from './api/research-account.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static('.'));

app.post('/api/research-account', (req, res) => handler(req, res));

app.listen(PORT, () => {
  console.log(`Account Radar running at http://localhost:${PORT}`);
});
