import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from './lib/application.js';

const baseDirectory = path.dirname(fileURLToPath(import.meta.url));
const { app } = await createApplication({ baseDirectory });
const port = Number(process.env.PORT || 6501);

app.listen(port, '127.0.0.1', () => {
  console.log(`AIWordTranslateService9527 ver0.1 running at http://localhost:${port}`);
});
