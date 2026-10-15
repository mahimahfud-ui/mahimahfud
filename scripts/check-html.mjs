import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const files = ['public/index.html', 'public/admin.html'];
let failed = false;
for (const file of files) {
  const html = readFileSync(resolve(file), 'utf8');
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(source => source.trim());
  if (!blocks.length) {
    console.error(`No inline JavaScript found in ${file}`);
    failed = true;
    continue;
  }
  blocks.forEach((source, index) => {
    try {
      new Function(source);
      console.log(`OK ${file} inline script ${index + 1}`);
    } catch (error) {
      console.error(`FAIL ${file} inline script ${index + 1}: ${error.message}`);
      failed = true;
    }
  });
}
if (failed) process.exitCode = 1;
