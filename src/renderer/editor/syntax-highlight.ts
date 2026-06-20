function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface HighlightRule {
  className: string;
  regex: RegExp;
}

function highlightWithRules(value: string, rules: HighlightRule[]): string {
  const stickyRules = rules.map((rule) => ({
    className: rule.className,
    regex: new RegExp(rule.regex.source, `${rule.regex.flags.replace(/g/g, '')}y`),
  }));

  let output = '';
  let index = 0;

  while (index < value.length) {
    let matched = false;

    for (const rule of stickyRules) {
      rule.regex.lastIndex = index;
      const match = rule.regex.exec(value);
      if (!match || match.index !== index) {
        continue;
      }

      output += `<span class="syntax-token ${rule.className}">${escapeHtml(match[0])}</span>`;
      index += match[0].length;
      matched = true;
      break;
    }

    if (!matched) {
      output += escapeHtml(value[index] ?? '');
      index += 1;
    }
  }

  return output;
}

const latexRules: HighlightRule[] = [
  { className: 'syntax-token--comment', regex: /%[^\n]*/ },
  { className: 'syntax-token--keyword', regex: /\\[A-Za-z@]+|\\./ },
  { className: 'syntax-token--number', regex: /\b\d+(?:\.\d+)?\b/ },
  { className: 'syntax-token--operator', regex: /[=+\-*/^_&]/ },
  { className: 'syntax-token--delimiter', regex: /[{}[\]()]/ },
];

const mermaidRules: HighlightRule[] = [
  { className: 'syntax-token--comment', regex: /%%[^\n]*/ },
  {
    className: 'syntax-token--keyword',
    regex:
      /\b(?:graph|flowchart|subgraph|end|sequenceDiagram|classDiagram|classDef|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|style|linkStyle|click)\b/,
  },
  { className: 'syntax-token--number', regex: /\b\d+(?:\.\d+)?\b/ },
  { className: 'syntax-token--string', regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/ },
  { className: 'syntax-token--label', regex: /\|[^|\n]*\|/ },
  { className: 'syntax-token--operator', regex: /<-->|-->|---|==>|==|-.->|-\.-|--x|x--|o--|--o/ },
  { className: 'syntax-token--delimiter', regex: /[()[\]{}<>]/ },
];

export function highlightLatex(value: string): string {
  return highlightWithRules(value, latexRules);
}

export function highlightMermaid(value: string): string {
  return highlightWithRules(value, mermaidRules);
}

export function highlightSearchInHtml(
  html: string,
  query: string,
  getPos: () => number,
  pluginState: any,
): string {
  if (!query) return html;

  const pos = getPos();
  const matches = pluginState?.search.matches || [];
  const currentIndex = pluginState?.search.currentIndex ?? -1;

  // Find the list of global matches that belong to this node
  const nodeMatchIndices: number[] = [];
  matches.forEach((m: any, idx: number) => {
    if (m.from === pos) {
      nodeMatchIndices.push(idx);
    }
  });

  // Find which of these matches is the active one
  const activeLocalIdx = nodeMatchIndices.indexOf(currentIndex);

  // Split HTML by tags, keeping the tags in the array
  const parts = html.split(/(<\/?[^>]+>)/g);
  const escapedQuery = query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`(${escapedQuery})`, 'gi');

  let matchCounter = 0;

  return parts
    .map((part) => {
      // If the part is an HTML tag, don't modify it
      if (part.startsWith('<') && part.endsWith('>')) {
        return part;
      }
      
      // Otherwise, it's text content. Replace matches with highlight span.
      return part.replace(regex, (match) => {
        const isCurrent = matchCounter === activeLocalIdx;
        matchCounter++;
        const className = isCurrent ? 'search-highlight-in-editor-current' : 'search-highlight-in-editor';
        return `<mark class="${className}">${match}</mark>`;
      });
    })
    .join('');
}
