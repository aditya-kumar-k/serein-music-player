// Offline romanization of Indic scripts into plain English letters
const Sanscript = require('@indic-transliteration/sanscript');

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
const T_VOW  = { 'அ':'a','ஆ':'aa','இ':'i','ஈ':'ee','உ':'u','ஊ':'oo','எ':'e','ஏ':'ae','ஐ':'ai','ஒ':'o','ஓ':'o','ஔ':'au' };
const T_SIGN = { 'ா':'aa','ி':'i','ீ':'ee','ு':'u','ூ':'oo','ெ':'e','ே':'ae','ை':'ai','ொ':'o','ோ':'o','ௌ':'au' };
const T_NASAL = new Set(['ங','ஞ','ண','ந','ம','ன']);
// stop → [initial, geminate, after-nasal, between-vowels, with-pulli]
const T_STOP = {
  'க':['k','k','g','g','k'], 'ச':['s','ch','j','s','ch'], 'ட':['t','tt','d','d','t'],
  'த':['th','th','dh','dh','th'], 'ப':['p','p','b','b','p'], 'ற':['r','tr','dr','r','t'],
};

function tamilWord(w) {
  const units = [];
  const cs = [...w];
  for (let i = 0; i < cs.length; i++) {
    const ch = cs[i];
    if (T_CONS[ch]) {
      let cons = ch, latin = T_CONS[ch];
      if (ch === 'க' && cs[i+1] === '்' && cs[i+2] === 'ஷ') { cons = 'ksh'; latin = 'ksh'; i += 2; }
      const nx = cs[i+1];
      let v = 'a';
      if (T_SIGN[nx]) { v = T_SIGN[nx]; i++; }
      else if (nx === '்') { v = null; i++; }
      units.push({ cons, latin, v });
    } else if (T_VOW[ch]) units.push({ cons: null, v: T_VOW[ch] });
    else if (ch === 'ஃ') units.push({ cons: null, latin: 'h', v: '' });
  }
  const cs2 = units.map(u => u.cons);
  let out = '';
  units.forEach((u, k) => {
    if (u.cons === null) { out += (u.latin || '') + u.v; return; }
    const prev = units[k - 1];
    let c = u.latin;
    if (u.cons === 'ங' && u.v === null && T_STOP[cs2[k+1]]) c = 'n';
    const stop = T_STOP[u.cons];
    if (stop) {
      let idx;
      if (u.v === null) idx = 4;
      else if (!prev) idx = 0;
      else if (prev.v === null) idx = prev.cons === u.cons ? 1 : (T_NASAL.has(prev.cons) ? 2 : 0);
      else idx = 3;
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
      let src = run.replace(/[‌‍]/g, '').replace(/[\u093C\u09BC\u0A3C\u0ABC]/g, '');   // drop nukta dots: फ़ → फ
      if (name === 'malayalam') {
        src = src.replace(/്$/, 'ു')   // word-final half-u: കണ്ണോട് → kannodu
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

module.exports = { romanize, hasIndic: t => /[ऀ-෿]/.test(t || '') };
