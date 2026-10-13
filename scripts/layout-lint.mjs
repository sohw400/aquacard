/**
 * Layout checks that run inside the page: text that runs off screen or gets clipped, lines that end on one
 * syllable, words split across lines, labels and values that miss each other's baseline, button labels off
 * centre, boxes with lopsided padding, uneven list spacing, small text and tap targets, and low contrast.
 *
 * The checks look at the top open dialog when there is one, otherwise at the whole screen.
 */
export async function lintLayout(page, { gutter = 16 } = {}) {
  return page.evaluate(inPageLint, { gutter });
}

function inPageLint({ gutter }) {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = innerHeight;
  const issues = [];
  const seen = new Set();
  const styleOf = (element) => getComputedStyle(element);

  function visible(element) {
    if (!element.getClientRects().length) return false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = styleOf(node);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.05) return false;
      if (node.tagName === 'DETAILS' && !node.open && node !== element && !element.closest('summary')) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }
  function describe(element) {
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && parts.length < 4; node = node.parentElement) {
      const test = node.getAttribute('data-testid');
      const classes = [...node.classList].slice(0, 2).join('.');
      parts.unshift(`${node.tagName.toLowerCase()}${test ? `[${test}]` : ''}${classes ? `.${classes}` : ''}`);
      if (test || node.getAttribute('role') === 'dialog') break;
    }
    return parts.join(' > ');
  }
  const snippet = (element) => (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  function report(type, element, detail, severity = 'warn') {
    const key = `${type}|${describe(element)}|${snippet(element)}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ type, severity, where: describe(element), text: snippet(element), detail });
  }

  const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(visible);
  const root = dialogs.at(-1) ?? document.querySelector('.app-shell, .onboarding') ?? document.body;
  const all = [root, ...root.querySelectorAll('*')].filter((element) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'svg', 'path'].includes(element.tagName) && !(element instanceof SVGElement));
  const shown = all.filter(visible);

  // Clipping ancestors (scrollers and overflow hidden) excuse content that runs past the screen inside them.
  function insideHorizontalScroller(element) {
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const overflow = styleOf(node).overflowX;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollWidth > node.clientWidth + 1) return true;
    }
    return false;
  }

  if (document.documentElement.scrollWidth > viewportWidth + 1) issues.push({ type: 'page-overflow-x', severity: 'error', where: 'html', text: '', detail: `${document.documentElement.scrollWidth}px > ${viewportWidth}px` });

  // Text blocks: elements that lay out their own lines (no block children) and hold visible text.
  const inlineDisplay = (display) => display.startsWith('inline') && display !== 'inline-block' && display !== 'inline-flex' && display !== 'inline-grid';
  const textBlocks = shown.filter((element) => {
    if (!/\S/.test(element.textContent ?? '')) return false;
    if (inlineDisplay(styleOf(element).display) && element.parentElement && shown.includes(element.parentElement)) return false;
    for (const child of element.children) {
      if (child.tagName === 'BR' || child instanceof SVGElement) continue;
      if (!inlineDisplay(styleOf(child).display) && visible(child)) return false;
    }
    return [...element.childNodes].some((node) => node.nodeType === 3 && /\S/.test(node.nodeValue)) || [...element.children].some((child) => /\S/.test(child.textContent ?? ''));
  });

  const range = document.createRange();
  function characters(block) {
    const list = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 1) { if (node.tagName === 'BR') list.push({ char: '\n', rect: null }); continue; }
      const parent = node.parentElement;
      if (!parent || !visible(parent)) continue;
      const value = node.nodeValue;
      for (let index = 0; index < value.length && list.length < 600; index += 1) {
        const char = value[index];
        if (/\s/.test(char)) { list.push({ char, rect: null }); continue; }
        range.setStart(node, index); range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        list.push({ char, rect, parent });
      }
    }
    return list;
  }
  const breakable = /[\s,./·\-–—:;)(\]\[}{!?~|@_'"’”]/;
  const wordChar = /[\p{L}\p{N}]/u;

  const blockInfo = new Map();
  for (const block of textBlocks) {
    const style = styleOf(block);
    const fontSize = parseFloat(style.fontSize);
    const chars = characters(block);
    const glyphs = chars.filter((item) => item.rect);
    if (!glyphs.length) continue;
    // Lines: a glyph starts a new line when it sits clearly below the previous one.
    const lines = [];
    let previous = null;
    for (const item of chars) {
      if (!item.rect) { if (lines.length) lines.at(-1).push(item); continue; }
      if (!previous || item.rect.top > previous.rect.top + previous.rect.height * 0.6) lines.push([]);
      lines.at(-1).push(item);
      previous = item;
    }
    const union = glyphs.reduce((box, { rect }) => ({ left: Math.min(box.left, rect.left), right: Math.max(box.right, rect.right), top: Math.min(box.top, rect.top), bottom: Math.max(box.bottom, rect.bottom) }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
    blockInfo.set(block, { lines, union, fontSize, style });

    const code = block.closest('code, pre, textarea, input, .funding-receive-address, .funding-destination, [data-testid="statement-text"]');
    if (lines.length >= 2 && !code) {
      const last = lines.at(-1).filter((item) => item.rect && wordChar.test(item.char));
      const total = glyphs.filter((item) => wordChar.test(item.char)).length;
      if (last.length <= 1 && total > 6) report('orphan', block, `마지막 줄 '${lines.at(-1).map((item) => item.char).join('').trim()}'`, 'error');
      else if (last.length === 2 && total > 10) report('short-last-line', block, `마지막 줄 '${lines.at(-1).map((item) => item.char).join('').trim()}'`);
      // A break between two letters of one word (no space or punctuation at the break).
      for (let index = 1; index < lines.length; index += 1) {
        const before = lines[index - 1].filter((item) => item.rect).at(-1);
        const after = lines[index].find((item) => item.rect);
        const gap = lines[index - 1].at(-1);
        if (before && after && gap?.rect && wordChar.test(before.char) && wordChar.test(after.char) && !breakable.test(before.char)) {
          report('split-word', block, `'${lines[index - 1].map((item) => item.char).join('').trim().slice(-6)}' | '${lines[index].map((item) => item.char).join('').trim().slice(0, 6)}'`, 'error');
          break;
        }
      }
    }
    if (fontSize < 12 && !block.closest('[aria-hidden="true"]')) report('small-text', block, `${fontSize}px`);
    if (union.right > viewportWidth + 0.5 || union.left < -0.5) {
      if (!insideHorizontalScroller(block)) report('offscreen-text', block, `left ${Math.round(union.left)} right ${Math.round(union.right)} / ${viewportWidth}`, 'error');
    } else if (viewportWidth < 700 && (union.left < gutter - 0.5 || union.right > viewportWidth - gutter + 0.5) && !block.closest('.bottom-nav, .toast, .nav-item, .sheet-handle') && !insideHorizontalScroller(block)) {
      report('edge-text', block, `text ${Math.round(union.left)}–${Math.round(union.right)} of ${viewportWidth}`);
    }
    // Clipped: the block or a clipping ancestor cuts the text off.
    for (let node = block; node && node !== root.parentElement; node = node.parentElement) {
      const nodeStyle = styleOf(node);
      if (node !== block && (/auto|scroll/.test(nodeStyle.overflowY) || /auto|scroll/.test(nodeStyle.overflowX))) break;
      if (['hidden', 'clip'].includes(nodeStyle.overflowX) || nodeStyle.textOverflow === 'ellipsis') {
        const box = node.getBoundingClientRect();
        if (union.right > box.right + 1 || union.left < box.left - 1 || node.scrollWidth > node.clientWidth + 1 && node === block) { report(nodeStyle.textOverflow === 'ellipsis' ? 'ellipsis' : 'clipped-text', block, `text ${Math.round(union.left)}–${Math.round(union.right)}, box ${Math.round(box.left)}–${Math.round(box.right)}`, 'error'); break; }
      }
      if (['hidden', 'clip'].includes(nodeStyle.overflowY) && node !== document.body && node !== document.documentElement) {
        const box = node.getBoundingClientRect();
        if (union.bottom > box.bottom + 1 || union.top < box.top - 1) { report('clipped-text', block, `text ${Math.round(union.top)}–${Math.round(union.bottom)}, box ${Math.round(box.top)}–${Math.round(box.bottom)}`, 'error'); break; }
      }
    }
    // Contrast against the first solid background behind the text.
    if (!block.closest(':disabled, [aria-disabled="true"], .disabled')) {
      const color = parseColor(style.color);
      const background = backgroundBehind(block);
      if (color && background) {
        const foreground = blend(color, background);
        const ratio = contrast(foreground, background);
        const weight = Number(style.fontWeight) || 400;
        const large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
        if (ratio < (large ? 3 : 4.5)) report('contrast', block, `${ratio.toFixed(2)}:1 (${style.color} on rgb(${background.slice(0, 3).map(Math.round).join(',')}))`, ratio < 3 ? 'error' : 'warn');
      }
    }
  }

  // Overlap between separate text blocks (one inside the other is fine).
  // The part of the screen a block can show through: every scrolling or clipping ancestor cuts it down.
  function clipOf(element) {
    const box = { left: 0, top: 0, right: viewportWidth, bottom: viewportHeight };
    for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = styleOf(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const rect = node.getBoundingClientRect();
      box.left = Math.max(box.left, rect.left); box.top = Math.max(box.top, rect.top);
      box.right = Math.min(box.right, rect.right); box.bottom = Math.min(box.bottom, rect.bottom);
    }
    return box;
  }
  const shownGlyphs = (element, info) => { const clip = clipOf(element); return info.lines.flat().filter((glyph) => glyph.rect && glyph.rect.bottom > clip.top + 1 && glyph.rect.top < clip.bottom - 1 && glyph.rect.right > clip.left + 1 && glyph.rect.left < clip.right - 1); };
  const stuck = (element) => { for (let node = element; node && node !== document.body; node = node.parentElement) { const position = styleOf(node).position; if (position === 'fixed' || position === 'sticky') return node; } return null; };
  const blocks = [...blockInfo.entries()];
  for (let first = 0; first < blocks.length; first += 1) {
    for (let second = first + 1; second < blocks.length; second += 1) {
      const [a, infoA] = blocks[first]; const [b, infoB] = blocks[second];
      if (a.contains(b) || b.contains(a) || stuck(a) !== stuck(b)) continue;
      const x = Math.min(infoA.union.right, infoB.union.right) - Math.max(infoA.union.left, infoB.union.left);
      const y = Math.min(infoA.union.bottom, infoB.union.bottom) - Math.max(infoA.union.top, infoB.union.top);
      if (x > 2 && y > 2) {
        // Line boxes of two blocks can touch; only report glyphs that actually collide.
        const glyphsB = shownGlyphs(b, infoB);
        const hit = shownGlyphs(a, infoA).some((ga) => glyphsB.some((gb) => Math.min(ga.rect.right, gb.rect.right) - Math.max(ga.rect.left, gb.rect.left) > 1 && Math.min(ga.rect.bottom, gb.rect.bottom) - Math.max(ga.rect.top, gb.rect.top) > 2));
        if (hit) report('text-overlap', a, `겹침: '${snippet(b)}'`, 'error');
      }
    }
  }

  // Labels and values side by side should share a baseline.
  function baselineOf(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!/\S/.test(node.nodeValue) || !node.parentElement || !visible(node.parentElement)) continue;
      const probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline';
      node.parentNode.insertBefore(probe, node);
      const bottom = probe.getBoundingClientRect().bottom;
      probe.remove();
      return bottom;
    }
    return null;
  }
  const decorated = (element) => { const style = styleOf(element); return style.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(style.borderTopWidth) > 0 || element.matches('button, input, select, textarea, img, svg'); };
  for (const row of shown) {
    const style = styleOf(row);
    if (!/flex|grid/.test(style.display) || (style.display.includes('flex') && style.flexDirection.startsWith('column'))) continue;
    if (row.matches('button, label') && row.querySelector('input')) continue;
    const cells = [...row.children].filter((child) => visible(child) && /\S/.test(child.textContent ?? '') && !decorated(child));
    if (cells.length < 2) continue;
    for (let index = 1; index < cells.length; index += 1) {
      const a = cells[index - 1].getBoundingClientRect(); const b = cells[index].getBoundingClientRect();
      if (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) < Math.min(a.height, b.height) * 0.5) continue;
      if (b.left < a.right - 1) continue;
      const singleLine = (cell) => { const lineHeight = parseFloat(styleOf(cell).lineHeight) || parseFloat(styleOf(cell).fontSize) * 1.5; const textRows = [...blockInfo.entries()].filter(([element]) => cell === element || cell.contains(element)).reduce((sum, [, info]) => sum + info.lines.length, 0); return textRows === 1 && cell.getBoundingClientRect().height < lineHeight * 1.9; };
      if (!singleLine(cells[index - 1]) || !singleLine(cells[index])) continue;
      const first = baselineOf(cells[index - 1]); const second = baselineOf(cells[index]);
      if (first !== null && second !== null && Math.abs(first - second) > 2) report('baseline', row, `${snippet(cells[index - 1]).slice(0, 16)} / ${snippet(cells[index]).slice(0, 16)}: ${Math.abs(first - second).toFixed(1)}px`);
    }
  }

  // Buttons: label (text plus icon) centred in the button, and a 44px tap target.
  const interactive = shown.filter((element) => element.matches('button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="switch"], [role="tab"]'));
  for (const control of interactive) {
    const rect = control.getBoundingClientRect();
    const target = control.matches('input[type="checkbox"], input[type="radio"]') ? control.closest('label') ?? control : control;
    const targetRect = target.getBoundingClientRect();
    if ((targetRect.height < 43.5 || targetRect.width < 43.5) && !(control.matches('a') && control.closest('p'))) report('tap-target', target, `${Math.round(targetRect.width)}×${Math.round(targetRect.height)}`);
    if (!control.matches('button, [role="button"], summary') || control.matches('[role="switch"]')) continue;
    const style = styleOf(control);
    const framed = style.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(style.borderTopWidth) > 0;
    if (!framed) continue;
    const contents = [...control.querySelectorAll('*')].filter((child) => visible(child) && (child instanceof SVGSVGElement || child.tagName === 'IMG' || [...child.childNodes].some((node) => node.nodeType === 3 && /\S/.test(node.nodeValue))));
    const ownText = [...control.childNodes].filter((node) => node.nodeType === 3 && /\S/.test(node.nodeValue));
    const boxes = contents.map((child) => {
      if (child instanceof SVGSVGElement || child.tagName === 'IMG') return child.getBoundingClientRect();
      const nodes = [...child.childNodes].filter((node) => node.nodeType === 3 && /\S/.test(node.nodeValue));
      range.setStartBefore(nodes[0]); range.setEndAfter(nodes.at(-1)); return range.getBoundingClientRect();
    });
    for (const node of ownText) { range.selectNodeContents(control); range.setStartBefore(node); range.setEndAfter(node); boxes.push(range.getBoundingClientRect()); }
    const glyphs = boxes.filter((box) => box.width > 0 && box.height > 0);
    if (!glyphs.length) continue;
    const top = Math.min(...glyphs.map((box) => box.top)); const bottom = Math.max(...glyphs.map((box) => box.bottom));
    const left = Math.min(...glyphs.map((box) => box.left)); const right = Math.max(...glyphs.map((box) => box.right));
    const lines = new Set(glyphs.map((box) => Math.round(box.top / 4))).size;
    if (bottom - top < rect.height * 0.8 && lines <= 2) {
      const offsetY = (top + bottom) / 2 - (rect.top + rect.bottom) / 2;
      if (Math.abs(offsetY) > 1.6) report('off-center', control, `세로 ${offsetY.toFixed(1)}px`);
      const centred = style.textAlign === 'center' || style.justifyContent === 'center';
      const offsetX = (left + right) / 2 - (rect.left + rect.right) / 2;
      if (centred && Math.abs(offsetX) > 1.6 && right - left < rect.width * 0.9) report('off-center', control, `가로 ${offsetX.toFixed(1)}px`);
    }
  }

  // Boxes (filled or bordered): content should sit evenly inside.
  const isBox = (element) => {
    if (element.matches('button, input, select, textarea, img, label, summary, [role="switch"], [role="dialog"], .app-shell, main, body')) return false;
    const style = styleOf(element);
    const borders = ['Top', 'Right', 'Bottom', 'Left'].filter((side) => parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none').length;
    const filled = style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== backgroundOfParent(element);
    return (borders >= 3 || filled) && element.getBoundingClientRect().height >= 36 && element.getBoundingClientRect().width >= 80;
  };
  function backgroundOfParent(element) {
    for (let node = element.parentElement; node; node = node.parentElement) {
      const color = styleOf(node).backgroundColor;
      if (color !== 'rgba(0, 0, 0, 0)') return color;
    }
    return 'rgb(255, 255, 255)';
  }
  for (const box of shown.filter(isBox)) {
    const style = styleOf(box);
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') continue;
    const rect = box.getBoundingClientRect();
    const inner = { top: rect.top + parseFloat(style.borderTopWidth), bottom: rect.bottom - parseFloat(style.borderBottomWidth), left: rect.left + parseFloat(style.borderLeftWidth), right: rect.right - parseFloat(style.borderRightWidth) };
    const contents = [...blockInfo.entries()].filter(([element]) => box.contains(element) && element !== box).map(([, info]) => info.union);
    for (const media of box.querySelectorAll('svg, img, input, button, select, textarea')) {
      if (!visible(media)) continue;
      if (media.matches('button') && styleOf(media).backgroundColor === 'rgba(0, 0, 0, 0)' && parseFloat(styleOf(media).borderTopWidth) === 0) continue;
      contents.push(media.getBoundingClientRect());
    }
    if (blockInfo.has(box)) contents.push(blockInfo.get(box).union);
    if (!contents.length) continue;
    const top = Math.min(...contents.map((item) => item.top)) - inner.top;
    const bottom = inner.bottom - Math.max(...contents.map((item) => item.bottom));
    const left = Math.min(...contents.map((item) => item.left)) - inner.left;
    const right = inner.right - Math.max(...contents.map((item) => item.right));
    const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
    if (!clips && (top < -0.5 || left < -0.5 || bottom < -0.5 || right < -0.5)) { report('content-outside-box', box, `위 ${top.toFixed(0)} 아래 ${bottom.toFixed(0)} 왼쪽 ${left.toFixed(0)} 오른쪽 ${right.toFixed(0)}`, 'error'); continue; }
    if (Math.abs(top - bottom) > 6 && rect.height < 160) report('uneven-padding', box, `위 ${top.toFixed(0)}px · 아래 ${bottom.toFixed(0)}px`);
    const padLeft = parseFloat(style.paddingLeft); const padRight = parseFloat(style.paddingRight);
    if (Math.abs(padLeft - padRight) > 6 && padLeft + padRight > 0) report('uneven-padding', box, `CSS 왼쪽 ${padLeft}px · 오른쪽 ${padRight}px`);
  }

  // Neighbouring rows that look alike (same tag and class) should keep one gap between them.
  for (const container of shown) {
    const children = [...container.children].filter(visible);
    if (children.length < 3) continue;
    const signature = (element) => `${element.tagName}.${[...element.classList].filter((name) => !/selected|current|done|active|warning|danger|open|disabled|on$/.test(name)).join('.')}`;
    const gaps = new Map();
    for (let index = 1; index < children.length; index += 1) {
      const key = signature(children[index]);
      if (key !== signature(children[index - 1])) continue;
      const above = children[index - 1].getBoundingClientRect(); const below = children[index].getBoundingClientRect();
      if (below.top < above.bottom - 1) continue;
      gaps.set(key, [...(gaps.get(key) ?? []), below.top - above.bottom]);
    }
    for (const [, values] of gaps) {
      if (values.length < 2) continue;
      const spread = Math.max(...values) - Math.min(...values);
      if (spread > 3) report('uneven-gaps', container, `간격 ${values.map((gap) => gap.toFixed(0)).join(', ')}px`);
    }
  }

  // Content hidden behind the fixed tab bar or a sheet footer.
  const bars = [...document.querySelectorAll('.bottom-nav, .funding-footer, .modal-footer')].filter(visible).map((bar) => ({ bar, rect: bar.getBoundingClientRect() })).filter(({ rect, bar }) => styleOf(bar).position === 'fixed' || styleOf(bar).position === 'sticky');
  const scrollerOf = (element) => { for (let node = element.parentElement; node; node = node.parentElement) { if (node === document.body || node === document.documentElement) return document.scrollingElement; const style = styleOf(node); if (/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node; } return document.scrollingElement; };
  const atEnd = (scroller) => scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
  for (const [block, info] of blockInfo) {
    for (const { bar, rect } of bars) {
      if (bar.contains(block) || stuck(block) || info.union.bottom <= rect.top + 1 || info.union.top >= rect.bottom - 1 || info.union.bottom > viewportHeight || !atEnd(scrollerOf(block))) continue;
      if (Math.min(info.union.right, rect.right) - Math.max(info.union.left, rect.left) > 0) report('under-bar', block, `${describe(bar)} 아래에 가려짐`);
    }
  }

  return { root: describe(root), viewport: [viewportWidth, viewportHeight], issues };

  function parseColor(value) {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  function backgroundBehind(element) {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const style = styleOf(node);
      if (style.backgroundImage !== 'none' && !style.backgroundImage.startsWith('url(')) return null;
      const color = parseColor(style.backgroundColor);
      if (color && color[3] > 0) { layers.push(color); if (color[3] >= 1) break; }
    }
    let result = parseColor(styleOf(document.body).backgroundColor) ?? [255, 255, 255, 1];
    if (result[3] < 1) result = [255, 255, 255, 1];
    for (const layer of layers.reverse()) result = blend(layer, result);
    return result;
  }
  function blend(top, bottom) {
    const alpha = top[3];
    return [0, 1, 2].map((index) => top[index] * alpha + bottom[index] * (1 - alpha)).concat(1);
  }
  function contrast(a, b) {
    const luminance = (color) => {
      const [r, g, bl] = color.slice(0, 3).map((channel) => { const value = channel / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  }
}
