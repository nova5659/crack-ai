#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEMINI_FREE_MODELS, GENERATION_MODES } from '../src/config.mjs';
import { ANIME_CATEGORIES, GENRES, PRESET_CHARACTERS } from '../src/presets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'web', 'data');
const outFile = path.join(outDir, 'catalog.json');

fs.mkdirSync(outDir, { recursive: true });

function toRelativeAsset(p) {
  if (typeof p === 'string' && p.startsWith('/assets/')) {
    return `.${p}`;
  }
  return p;
}

const payload = {
  generatedAt: new Date().toISOString(),
  genres: GENRES,
  animeCategories: ANIME_CATEGORIES,
  models: GEMINI_FREE_MODELS,
  modes: GENERATION_MODES,
  characters: PRESET_CHARACTERS.map((c) => ({
    ...c,
    avatar: toRelativeAsset(c.avatar),
    isBuiltin: true,
  })),
};

fs.writeFileSync(outFile, JSON.stringify(payload), 'utf8');
const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`✅ Built web/data/catalog.json (${payload.characters.length} worlds · ${kb} KB)`);
