/** Env var names declared in a dotenv-style file. Values are never read into the result. */
export function parseEnvNames(text: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  text.split('\n').forEach((raw, i) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*[=:]/.exec(raw);
    if (m?.[1] && !raw.trimStart().startsWith('#')) out.push({ name: m[1], line: i + 1 });
  });
  return out;
}
