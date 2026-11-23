'use strict';
// Odczyt tekstu z PDF-u aktu prawnego na komputerze (pdf.js, bez sieci).
// Potrzebny dla ChatGPT (Codex CLI) i Google Gemini (Antigravity CLI): te programy działają bez dostępu
// do plików, więc treść aktu dostają jako tekst w zapytaniu. Claude Code czyta PDF sam (narzędzie Read).

const path = require('path');
const { pathToFileURL } = require('url');

const MAX_CHARS = 70000; // tyle samo, ile silnik bierze z tekstu aktu w HTML (src/sources/eli.js)

let lib = null;
// W spakowanej aplikacji pdf.js leży poza archiwum asar (asarUnpack w package.json).
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function base() { return unpacked(path.dirname(require.resolve('pdfjs-dist/package.json'))); }

async function load() {
  if (!lib) lib = await import(pathToFileURL(path.join(base(), 'legacy', 'build', 'pdf.mjs')).href);
  return lib;
}

/** Zwraca { text, pages, truncated } albo rzuca błąd (np. uszkodzony PDF). */
async function pdfToText(base64, { maxChars = MAX_CHARS } = {}) {
  const pdfjs = await load();
  const dir = base();
  const data = new Uint8Array(Buffer.from(String(base64 || ''), 'base64'));
  const task = pdfjs.getDocument({
    data,
    cMapUrl: path.join(dir, 'cmaps') + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(dir, 'standard_fonts') + path.sep,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  let text = '';
  try {
    for (let i = 1; i <= doc.numPages && text.length <= maxChars; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      text += tc.items.map((x) => (x.str || '') + (x.hasEOL ? '\n' : '')).join('') + '\n\n';
      page.cleanup();
    }
  } finally {
    await Promise.resolve(task.destroy()).catch(() => {});
  }
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = text.length > maxChars;
  return { text: truncated ? text.slice(0, maxChars) : text, pages: doc.numPages, truncated };
}

module.exports = { pdfToText, MAX_CHARS };
