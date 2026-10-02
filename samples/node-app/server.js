const express = require('express');
const app = express();

const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello from Pushr Node App!');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', app: 'node-app' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Node app listening on port ${port}`);
});
