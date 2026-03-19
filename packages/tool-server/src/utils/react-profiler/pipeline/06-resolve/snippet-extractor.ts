import { promises as fs } from 'fs';

/**
 * Extract a code snippet: target line ± 1 line of context.
 * Line is 1-based. Clips gracefully at file boundaries.
 */
export async function extractSnippet(file: string, line: number): Promise<string> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }

  const lines = content.split('\n');
  const totalLines = lines.length;

  const start = Math.max(0, line - 2);       // line - 1 in 0-based, minus 1 for context
  const end = Math.min(totalLines, line + 1); // line + 1 in 0-based, plus 1 for context

  return lines.slice(start, end).join('\n');
}
