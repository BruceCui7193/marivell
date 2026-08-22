export function buildFormulaDenseMarkdown(sectionCount = 900): string {
  const lines: string[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    lines.push(
      `## Section ${index}\n\nParagraph ${index} has inline math $x_{${index}}^2$ ` +
        `and enough filler text to keep this document scrollable and formula-heavy: ${index} ${index} ${index}.\n`,
    );
  }
  return lines.join('\n');
}
