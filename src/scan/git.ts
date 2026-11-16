import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Evidence, GitInfo } from '../types.js';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
    return stdout;
  } catch {
    return undefined;
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return (await git(dir, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true';
}

export async function gitTopLevel(dir: string): Promise<string | undefined> {
  return (await git(dir, ['rev-parse', '--show-toplevel']))?.trim() || undefined;
}

/**
 * Path of `dir` inside its repo ("packages/web/", or "" at the root), as git sees it. Safer than
 * comparing paths ourselves: on Windows git reports C:/… with forward slashes and may resolve
 * short 8.3 names (RUNNER~1) differently from Node.
 */
export async function gitPrefix(dir: string): Promise<string> {
  return ((await git(dir, ['rev-parse', '--show-prefix'])) ?? '').trim();
}

export async function isShallow(dir: string): Promise<boolean> {
  return (await git(dir, ['rev-parse', '--is-shallow-repository']))?.trim() === 'true';
}

/**
 * Detect which AI coding assistant (if any) is credited on a commit.
 * Looks at co-author trailers, "Generated with" footers and bot authors.
 */
export function detectAI(author: string, email: string, body: string): string | undefined {
  const who = `${author} <${email}>`;
  const trailers = body
    .split('\n')
    .filter((l) => /^(co-authored-by|generated-by|assisted-by|ai-assisted|made-with)\s*:/i.test(l.trim()) || /generated with|created with|🤖/i.test(l))
    .join('\n');
  const hay = `${who}\n${trailers}`;
  const rules: [RegExp, string][] = [
    [/claude|anthropic/i, 'Claude'],
    [/copilot/i, 'GitHub Copilot'],
    [/cursor/i, 'Cursor'],
    [/codex|openai|chatgpt/i, 'Codex'],
    [/\baider\b/i, 'Aider'],
    [/devin/i, 'Devin'],
    [/gemini|jules/i, 'Gemini'],
    [/windsurf|codeium/i, 'Windsurf'],
    [/amazon q|codewhisperer/i, 'Amazon Q'],
    [/cline|roo ?code|kilo ?code/i, 'Cline'],
    [/lovable|bolt\.new|v0\.dev|replit agent/i, 'App builder'],
  ];
  for (const [re, name] of rules) if (re.test(hay)) return name;
  if (/^aider:/i.test(body.trim())) return 'Aider';
  return undefined;
}

interface Commit {
  sha: string;
  date: string;
  author: string;
  email: string;
  body: string;
}

function parseLog(out: string | undefined): Commit[] {
  if (!out) return [];
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((r) => {
      const [sha = '', date = '', author = '', email = '', body = ''] = r.split('\x1f');
      return { sha, date, author, email, body };
    });
}

const FMT = '--format=%H%x1f%aI%x1f%an%x1f%ae%x1f%B%x1e';

/**
 * When was the vendor introduced, by whom, with which assistant, and when was the code
 * that uses it last touched.
 */
export async function gitInfoFor(root: string, evidence: Evidence[]): Promise<GitInfo> {
  const info: GitInfo = {};
  const tracked = [...new Set(evidence.filter((e) => e.kind !== 'env-declared').map((e) => e.file))].slice(0, 200);

  // Introduction: earliest commit that added the strongest piece of evidence.
  const anchor =
    evidence.find((e) => e.kind === 'manifest' && !e.dev) ??
    evidence.find((e) => e.kind === 'import' && !e.dev) ??
    evidence.find((e) => e.kind === 'host' || e.kind === 'env-referenced') ??
    evidence[0];
  if (anchor) {
    const needle = anchor.kind === 'manifest' ? `"${anchor.detail}"` : anchor.detail.replace(/ \((script|config)\)$/, '');
    const pathspec = anchor.kind === 'manifest' ? [anchor.file] : tracked.length ? tracked : [anchor.file];
    const isNonJsonManifest = anchor.kind === 'manifest' && !anchor.file.endsWith('.json');
    const commits = parseLog(await git(root, ['log', '--reverse', '--no-merges', FMT, '-S', isNonJsonManifest ? anchor.detail : needle, '--', ...pathspec]));
    const first = commits[0];
    if (first) {
      info.introducedAt = first.date;
      info.introducedBy = first.author;
      info.introducedCommit = first.sha.slice(0, 12);
      info.introducedWithAI = detectAI(first.author, first.email, first.body);
    }
  }

  if (tracked.length) {
    const last = (await git(root, ['log', '-1', '--format=%cI', '--', ...tracked]))?.trim();
    if (last) info.lastTouchedAt = last;
  }
  return info;
}

export interface WorktreeHandle {
  path: string;
  remove(): Promise<void>;
}

/** Check out `ref` into a temporary detached worktree (used by `stackprune check`). */
export async function addWorktree(repo: string, ref: string, path: string): Promise<WorktreeHandle> {
  const out = await git(repo, ['worktree', 'add', '--detach', '--force', path, ref]);
  if (out === undefined) throw new Error(`Could not check out "${ref}". Is it a valid ref, and was the repo fetched with enough history (fetch-depth: 0)?`);
  return {
    path,
    remove: async () => {
      await git(repo, ['worktree', 'remove', '--force', path]);
    },
  };
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string | undefined> {
  return (await git(repo, ['merge-base', a, b]))?.trim() || undefined;
}
