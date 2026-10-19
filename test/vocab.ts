// The vocabulary the integration tests and benchmarks use: the shipped defaults plus the terms this app was tuned
// on (fixtures/vocabulary-personal.json), so cases like "uzi" => Doozy keep their coverage.
import fs from 'node:fs';
import path from 'node:path';
import type { VocabTerm } from '../src/core/types';
import { parseVocabularyFile } from '../src/core/vocabulary';

const root = path.resolve(__dirname, '..');
const read = (f: string) => parseVocabularyFile(fs.readFileSync(path.join(root, f), 'utf8')).terms;

export function testVocabulary(): VocabTerm[] {
  return [...read('defaults/vocabulary.json'), ...read('fixtures/vocabulary-personal.json')];
}
