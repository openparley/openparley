// Licensing boundary: MIT code must never depend on enterprise code in ee/, so the open-source
// packages keep working (and stay MIT) without it. Runs as part of `bun run test`.
import { Glob } from 'bun';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const forbidden = [/from\s+['"][^'"]*\bee\//, /from\s+['"]@openparley\/cloud['"]/, /import\(\s*['"][^'"]*\bee\//];
const problems: string[] = [];

for (const dir of ['packages', 'apps']) {
  for await (const path of new Glob(`${dir}/**/*.{ts,tsx}`).scan({ cwd: root })) {
    if (path.includes('node_modules') || path.includes('/dist/')) continue;
    const lines = (await Bun.file(join(root, path)).text()).split('\n');
    lines.forEach((line, i) => {
      if (forbidden.some((re) => re.test(line))) problems.push(`${path}:${i + 1}  ${line.trim()}`);
    });
  }
}

for await (const path of new Glob('ee/*/package.json').scan({ cwd: root })) {
  const pkg = await Bun.file(join(root, path)).json();
  if (pkg.license !== 'SEE LICENSE IN ../LICENSE' || pkg.private !== true) {
    problems.push(`${relative(root, join(root, path))}: enterprise packages must be private and use "SEE LICENSE IN ../LICENSE"`);
  }
}

if (problems.length) {
  console.error('Licensing boundary violated (MIT code must not use ee/):\n' + problems.join('\n'));
  process.exit(1);
}
console.log('Licensing boundary OK: nothing outside ee/ imports from ee/.');
