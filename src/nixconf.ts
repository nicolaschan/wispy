const BEGIN = '# >>> wispy >>>';
const END = '# <<< wispy <<<';
const BLOCK_RE = /# >>> wispy >>>[\s\S]*?# <<< wispy <<<\n?/g;

export function applyWispyBlock(existing: string, blockBody: string): string {
  const cleaned = removeWispyBlock(existing);
  const prefix = cleaned.length > 0 && !cleaned.endsWith('\n') ? cleaned + '\n' : cleaned;
  return `${prefix}${BEGIN}\n${blockBody}\n${END}\n`;
}

export function removeWispyBlock(existing: string): string {
  return existing.replace(BLOCK_RE, '');
}
