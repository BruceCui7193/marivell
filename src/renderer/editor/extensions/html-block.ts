import { Node } from '@tiptap/core';

declare global {
  // Prevent TypeScript from widening string types
}

export interface HtmlBlockOptions {
  // No options needed for now
}

export const HtmlBlock = Node.create<HtmlBlockOptions>({
  name: 'htmlBlock',

  group: 'block',

  atom: true,

  selectable: true,

  draggable: false,

  addAttributes() {
    return {
      html: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-html') ?? element.innerHTML,
        renderHTML: (attributes) => ({ 'data-html': attributes.html }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-html-block]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const html = String(HTMLAttributes['data-html'] ?? '');
    return [
      'div',
      {
        'data-html-block': '',
        class: 'html-block',
        contenteditable: 'false',
        ...HTMLAttributes,
      },
      // Use inner content via DOM manipulation in nodeView
      html,
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'html-block';
      dom.setAttribute('data-html-block', '');
      dom.contentEditable = 'false';
      dom.innerHTML = node.attrs.html ?? '';

      return {
        dom,
        contentDOM: undefined,
        update(updatedNode) {
          if (updatedNode.attrs.html !== node.attrs.html) {
            dom.innerHTML = updatedNode.attrs.html ?? '';
            return true;
          }
          return false;
        },
      };
    };
  },
});
