// Offline romanization of Indic scripts into plain English letters
(function(root) {
  const Sanscript = (typeof window !== 'undefined' && window.Sanscript)
    ? window.Sanscript
    : (typeof require !== 'undefined' ? require('@indic-transliteration/sanscript') : {});

  const SCRIPTS = [
    { name: 'devanagari', re: /[ऀ-ॿ]+/g },
    { name: 'bengali',    re: /[ঀ-৿]+/g },
    { name: 'gurmukhi',   re: /[਀-੿]+/g },
    { name: 'gujarati',   re: /[઀-૿]+/g },
    { name: 'tamil',      re: /[஀-௿]+/g },
    { name: 'telugu',     re: /[ఀ-౿]+/g },
    { name: 'kannada',    re: /[ಀ-೿]+/g },
    { name: 'malayalam',  re: /[ഀ-ൿ]+/g },
  ];

  const SIMPLE = {
    'ā': 'aa', 'ī': 'ee', 'ū': 'oo', 'ē': 'e', 'ō': 'o', 'æ': 'e',
    'ṭ': 't', 'ḍ': 'd', 'ṇ': 'n', 'ṅ': 'n', 'ñ': 'n', 'ś': 'sh', 'ṣ': 'sh',
    'ṃ': 'm', 'ṁ': 'm', 'ḥ': 'h', 'ṛ': 'ri', 'ṝ': 'ri', 'ḷ': 'l', 'ḻ': 'zh',
    'ṟ': 'r', 'ṉ': 'n', 'ẏ': 'y', "'": '', '’': '', '~': '', '`': '',
  };

  function simplify(s) {
    return s
      .replace(/[^\x00-\x7F]/g, c => (c in SIMPLE ? SIMPLE[c] : c.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))
      .replace(/[~`]/g, '');
  }

  // Hindi/Devanagari: drop the silent inherent "a" (kamala → kamla, dil, not dila)
  function schwa(word) {
    return word
      .replace(/(?<=[aāiīuūeo][^aāiīuūeo\s]h?)a(?=[^aāiīuūeo\s]h?[aāiīuūeo])/g, '')
      .replace(/(?<=[^aāiīuūeo\s\d])a$/, '');
  }

  // ── Tamil: custom romanizer (the generic scheme can't voice stops: க → k/g) ──
  const T_CONS = { 'க':'k','ங':'ng','ச':'ch','ஞ':'nj','ட':'t','ண':'n','த':'th','ந':'n','ப':'p','ம':'m','ய':'y','ர':'r','ல':'l','வ':'v','ழ':'zh','ள':'l','ற':'r','ன':'n','ஜ':'j','ஷ':'sh','ஸ':'s','ஹ':'h','ஶ':'sh' };
  const T_VOWS = { 'ா':'aa','ி':'i','ீ':'ee','ு':'u','ூ':'oo','ெ':'e','ே':'e','ை':'ai','ொ':'o','ோ':'o','ௌ':'au' };
  const T_INDP = { 'அ':'a','ஆ':'aa','இ':'i','ஈ':'ee','உ':'u','ஊ':'oo','எ':'e','ஏ':'e','ஐ':'ai','ஒ':'o','ஓ':'o','ஔ':'au' };

  function parseTamil(run) {
    const units = [];
    for (let i = 0; i < run.length; ) {
      const ch = run[i];
      if (ch in T_INDP) { units.push({ c: null, v: T_INDP[ch] }); i++; continue; }
      if (ch in T_CONS) {
        let v = 'a', skip = 1;
        const n1 = run[i + 1];
        if (n1 === '்') { v = null; skip = 2; }
        else if (n1 in T_VOWS) { v = T_VOWS[n1]; skip = 2; }
        units.push({ c: T_CONS[ch], v });
        i += skip;
        continue;
      }
      units.push({ c: ch, v: null }); i++;
    }
    return units;
  }

  function tamilWord(run) {
    const units = parseTamil(run);
    const stop = { k:'g', ch:'s', t:'d', th:'d', p:'b' };
    const nasals = new Set(['ng', 'nj', 'n', 'm']);
    let out = '';
    units.forEach((u, idx) => {
      if (u.c === null) { out += u.v || ''; return; }
      let c = u.c;
      const prev = idx > 0 ? units[idx - 1] : null;
      if (c in stop) {
        if (idx === 0) c = u.c;
        else if (prev && prev.v === null && prev.c === c) c = u.c;
        else if (prev && prev.v === null && nasals.has(prev.c)) c = stop[c];
        else if (prev && prev.v !== null) {
          if (c === 'ch') c = 's';
          else if (c === 'k') c = 'h';
          else c = stop[c];
        }
      }
      if (c === 't' && prev && prev.v === null && prev.c === 't') {
        c = 'tt';
      }
      if (c === 'r' && prev && prev.v === null && prev.c === 'r') {
        c = stop[idx];
      }
      out += c + (u.v === null ? '' : u.v);
    });
    return out;
  }

  function romanize(text) {
    if (!text || !/[ऀ-෿]/.test(text)) return text;
    let out = text;
    for (const { name, re } of SCRIPTS) {
      out = out.replace(re, run => {
        if (name === 'tamil') return tamilWord(run);
        let src = run.replace(/[‌‍]/g, '');
        if (name === 'malayalam') {
          src = src.replace(/്$/, 'ു')   // word-final half-u: கண்ணோடு → kannodu
            .replace(/ൺ/g, 'ണ്').replace(/ൻ/g, 'ന്').replace(/ർ/g, 'ര്')
            .replace(/ൽ/g, 'ല്').replace(/ൾ/g, 'ള്').replace(/ൿ/g, 'ക്');
        }
        let iast = Sanscript.t(src, name, 'iast')
          .replace(/m̐/g, 'ṃ')
          .replace(/ch/g, '\u0001').replace(/c/g, 'ch').replace(/\u0001/g, 'chh');
        if (name === 'malayalam') iast = iast.replace(/ṇṭ/g, 'nd').replace(/ṅk/g, 'nk');
        if (name !== 'malayalam') iast = iast.replace(/[ṃṁ]([pbm])/g, 'm$1').replace(/[ṃṁ]/g, 'n');
        if (name === 'devanagari' || name === 'bengali' || name === 'gurmukhi' || name === 'gujarati') {
          iast = schwa(iast);
        }
        return simplify(iast);
      });
    }
    return out;
  }

  const hasIndic = t => /[ऀ-෿]/.test(t || '');

  const Translit = { romanize, hasIndic };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Translit;
  }
  if (typeof root !== 'undefined') {
    root.Translit = Translit;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
