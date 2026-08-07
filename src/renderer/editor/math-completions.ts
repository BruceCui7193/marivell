export interface MathCompletionItem {
  command: string;
  insert: string;
  label: string;
}

export const MATH_COMPLETIONS: MathCompletionItem[] = [
  { command: 'frac', insert: '\\frac{}{}', label: '\\frac{}{}' },
  { command: 'dfrac', insert: '\\dfrac{}{}', label: '\\dfrac{}{}' },
  { command: 'tfrac', insert: '\\tfrac{}{}', label: '\\tfrac{}{}' },
  { command: 'sqrt', insert: '\\sqrt{}', label: '\\sqrt{}' },
  { command: 'sum', insert: '\\sum_{}^{}', label: '\\sum_{}^{}' },
  { command: 'prod', insert: '\\prod_{}^{}', label: '\\prod_{}^{}' },
  { command: 'int', insert: '\\int_{}^{}', label: '\\int_{}^{}' },
  { command: 'lim', insert: '\\lim_{}', label: '\\lim_{}' },
  { command: 'alpha', insert: '\\alpha', label: '\\alpha' },
  { command: 'beta', insert: '\\beta', label: '\\beta' },
  { command: 'gamma', insert: '\\gamma', label: '\\gamma' },
  { command: 'delta', insert: '\\delta', label: '\\delta' },
  { command: 'epsilon', insert: '\\epsilon', label: '\\epsilon' },
  { command: 'theta', insert: '\\theta', label: '\\theta' },
  { command: 'lambda', insert: '\\lambda', label: '\\lambda' },
  { command: 'mu', insert: '\\mu', label: '\\mu' },
  { command: 'pi', insert: '\\pi', label: '\\pi' },
  { command: 'sigma', insert: '\\sigma', label: '\\sigma' },
  { command: 'phi', insert: '\\phi', label: '\\phi' },
  { command: 'omega', insert: '\\omega', label: '\\omega' },
  { command: 'infty', insert: '\\infty', label: '\\infty' },
  { command: 'times', insert: '\\times', label: '\\times' },
  { command: 'cdot', insert: '\\cdot', label: '\\cdot' },
  { command: 'pm', insert: '\\pm', label: '\\pm' },
  { command: 'leq', insert: '\\leq', label: '\\leq' },
  { command: 'geq', insert: '\\geq', label: '\\geq' },
  { command: 'neq', insert: '\\neq', label: '\\neq' },
  { command: 'approx', insert: '\\approx', label: '\\approx' },
  { command: 'rightarrow', insert: '\\rightarrow', label: '\\rightarrow' },
  { command: 'leftarrow', insert: '\\leftarrow', label: '\\leftarrow' },
  { command: 'left', insert: '\\left(', label: '\\left(' },
  { command: 'right', insert: '\\right)', label: '\\right)' },
  { command: 'text', insert: '\\text{}', label: '\\text{}' },
  { command: 'mathrm', insert: '\\mathrm{}', label: '\\mathrm{}' },
  { command: 'mathbf', insert: '\\mathbf{}', label: '\\mathbf{}' },
  { command: 'mathbb', insert: '\\mathbb{}', label: '\\mathbb{}' },
  { command: 'begin', insert: '\\begin{aligned}', label: '\\begin{aligned}' },
  { command: 'end', insert: '\\end{aligned}', label: '\\end{aligned}' },
];

export function getMathCompletionItems(query: string): MathCompletionItem[] {
  const normalized = query.toLowerCase().replace(/^\\/, '');
  const items = normalized
    ? MATH_COMPLETIONS.filter((item) => item.command.startsWith(normalized))
    : MATH_COMPLETIONS;
  return items.slice(0, 10);
}

export function getMathCompletionCaret(insert: string): number {
  const firstBrace = insert.indexOf('{');
  return firstBrace >= 0 ? firstBrace + 1 : insert.length;
}
