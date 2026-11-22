/* global console, process */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '..');
const distAssets = path.join(webRoot, 'dist', 'assets');

console.log('[VERIFY-ISOLATION] Running fail-closed production bundle isolation check...');

if (!fs.existsSync(distAssets)) {
  console.error(`[FAIL] Production build directory does not exist: ${distAssets}`);
  console.error('Run "npm run build" first before running isolation verification.');
  process.exit(1);
}

const files = fs.readdirSync(distAssets);
if (files.length === 0) {
  console.error(`[FAIL] Production build directory is empty: ${distAssets}`);
  process.exit(1);
}

// 1. Assert no WASM binaries in client dist/assets
const wasmFiles = files.filter((f) => f.endsWith('.wasm'));
if (wasmFiles.length > 0) {
  console.error(`[FAIL] Unexpected WASM binary found in production client bundle:`, wasmFiles);
  process.exit(1);
}

// 2. Assert no laboratory routes or components in client JS bundles
const jsFiles = files.filter((f) => f.endsWith('.js'));
if (jsFiles.length === 0) {
  console.error(`[FAIL] No JS bundle chunks found in ${distAssets}`);
  process.exit(1);
}

let foundForbiddenPattern = false;
for (const file of jsFiles) {
  const filePath = path.join(distAssets, file);
  const content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes('dev/voice-lab')) {
    console.error(`[FAIL] Route "dev/voice-lab" leaked into production bundle chunk: ${file}`);
    foundForbiddenPattern = true;
  }
  if (content.includes('VoiceLabPage')) {
    console.error(`[FAIL] Component "VoiceLabPage" leaked into production bundle chunk: ${file}`);
    foundForbiddenPattern = true;
  }
}

if (foundForbiddenPattern) {
  process.exit(1);
}

// 3. Assert existing /interview workflow is preserved and uncoupled from voice lab
const interviewPath = path.join(webRoot, 'src', 'pages', 'InterviewPage.tsx');
if (!fs.existsSync(interviewPath)) {
  console.error(`[FAIL] Expected InterviewPage.tsx at ${interviewPath}`);
  process.exit(1);
}
const interviewSource = fs.readFileSync(interviewPath, 'utf-8');
if (interviewSource.includes('dev/voice-lab') || interviewSource.includes('VoiceLabPage')) {
  console.error(`[FAIL] InterviewPage.tsx references voice-lab modules`);
  process.exit(1);
}

console.log(`[PASS] Production bundle isolation verified. Checked ${files.length} assets in dist/assets.`);
process.exit(0);
