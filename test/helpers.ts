import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function tempDir(prefix = 'stackprune-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dev',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'Dev',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: cwd,
    },
  });
}

export function initRepo(root: string): void {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'commit.gpgsign', 'false');
}

export function commit(root: string, message: string, date?: string): void {
  git(root, 'add', '-A');
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dev',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'Dev',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
      HOME: root,
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });
}
