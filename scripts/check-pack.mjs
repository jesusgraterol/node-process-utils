/*
 * Fails unless the packed tarball holds exactly the build output and the package metadata files.
 * It runs npm through the current Node.js binary, without a shell, so it works on every platform;
 * run it with `npm run check:pack` after `npm run build`.
 */
import { execFileSync } from 'node:child_process';

// the files every tarball ships next to the build output
const METADATA_FILES = ['LICENSE', 'README.md', 'package.json'];

// the build entry points that must be present
const REQUIRED_FILES = ['dist/index.js', 'dist/index.d.ts'];

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error('Run this script through npm, for example with `npm run check:pack`.');
}

const output = execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
  encoding: 'utf-8',
});
const paths = JSON.parse(output)[0].files.map((file) => file.path);

const unexpected = paths.filter(
  (path) => !(METADATA_FILES.includes(path) || path.startsWith('dist/')) || path.includes('.test-'),
);
const missing = REQUIRED_FILES.filter((path) => !paths.includes(path));

if (unexpected.length > 0 || missing.length > 0) {
  throw new Error(
    `The packed files are wrong. Unexpected: ${JSON.stringify(unexpected)}. Missing: ${JSON.stringify(missing)}.`,
  );
}
process.stdout.write(`The tarball holds the expected ${paths.length} files.\n`);
