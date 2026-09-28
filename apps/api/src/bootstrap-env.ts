import { existsSync } from 'fs';
import { join } from 'path';

// Must be imported before anything reads process.env. Existing env vars take precedence over the file.
const file = join(__dirname, '..', '.env');
if (existsSync(file) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(file);
}
