import { spawnSync } from 'node:child_process';

const supplied = process.argv.slice(2);
const args = ['-m', 'unittest', 'discover', ...(supplied.length > 0
  ? supplied
  : ['-s', 'tools/platform/oracle/upstream-watch/tests', '-p', 'test_*.py'])];
const candidates = process.platform === 'win32'
  ? [['py', ['-3', ...args]], ['python', args]]
  : [['python3', args], ['python', args]];

for (const [executable, commandArgs] of candidates) {
  const result = spawnSync(executable, commandArgs, { stdio: 'inherit', shell: false });
  if (result.error?.code === 'ENOENT') continue;
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
  process.exit();
}

process.stderr.write('Python 3 executable not found; install Python 3.13 or expose py/python3 on PATH.\n');
process.exitCode = 1;
