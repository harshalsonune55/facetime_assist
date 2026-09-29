/* A small markdown renderer. Deliberately tiny: the overlay only ever shows
   headings, lists, quotes, code and inline emphasis, and shipping a parser
   the size of the app itself would be silly. */
(function () {
  'use strict';

  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const LANGUAGE_NAMES = {
    bash: 'Bash',
    c: 'C',
    cpp: 'C++',
    css: 'CSS',
    go: 'Go',
    html: 'HTML',
    java: 'Java',
    javascript: 'JavaScript',
    js: 'JavaScript',
    json: 'JSON',
    jsx: 'JSX',
    markdown: 'Markdown',
    md: 'Markdown',
    php: 'PHP',
    plaintext: 'Plain text',
    py: 'Python',
    python: 'Python',
    rb: 'Ruby',
    ruby: 'Ruby',
    rust: 'Rust',
    sh: 'Shell',
    shell: 'Shell',
    sql: 'SQL',
    swift: 'Swift',
    ts: 'TypeScript',
    tsx: 'TSX',
    typescript: 'TypeScript',
    xml: 'XML',
    yaml: 'YAML',
    yml: 'YAML',
  };

  function codeBlock(source, language) {
    const lang = String(language || '').toLowerCase();
    const label = LANGUAGE_NAMES[lang] || lang || 'Code';
    return (
      `<div class="code-block" data-hit data-language="${escapeHtml(lang)}">` +
      `<div class="code-meta"><span class="code-language">${escapeHtml(label)}</span>` +
      `<button class="copy" data-copy type="button" aria-label="Copy code">Copy</button></div>` +
      `<pre><code>${escapeHtml(source)}</code></pre></div>`
    );
  }

  function inline(text) {
    let out = escapeHtml(text);
    // Pull inline code out first, so emphasis markers inside it stay literal.
    const codes = [];
    out = out.replace(/`([^`]+)`/g, (_m, c) => {
      codes.push(c);
      return `\u0001${codes.length - 1}\u0001`;
    });
    out = out
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-link>$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
    return out.replace(/\u0001(\d+)\u0001/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  }

  function render(src) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    const html = [];
    let list = null; // 'ul' | 'ol'
    let para = [];

    const closeList = () => {
      if (list) {
        html.push(`</${list}>`);
        list = null;
      }
    };
    const closePara = () => {
      if (para.length) {
        html.push(`<p>${inline(para.join(' '))}</p>`);
        para = [];
      }
    };
    const flush = () => {
      closePara();
      closeList();
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const fence = line.match(/^\s*```([\w#+.-]+)?\s*$/);
      if (fence) {
        flush();
        const lang = fence[1] || '';
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        html.push(codeBlock(body.join('\n'), lang));
        continue;
      }

      if (!line.trim()) {
        flush();
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        flush();
        const level = Math.min(heading[1].length + 2, 6);
        html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }

      if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
        flush();
        html.push('<hr>');
        continue;
      }

      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flush();
        html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
        continue;
      }

      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        closePara();
        const kind = bullet ? 'ul' : 'ol';
        if (list !== kind) {
          closeList();
          html.push(`<${kind}>`);
          list = kind;
        }
        html.push(`<li>${inline((bullet || numbered)[1])}</li>`);
        continue;
      }

      closeList();
      para.push(line.trim());
    }

    flush();
    return html.join('');
  }

  window.renderMarkdown = render;
})();
