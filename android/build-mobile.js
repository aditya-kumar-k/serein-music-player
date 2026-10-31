const fs = require('fs');
const path = require('path');

const srcDir = __dirname;
const destDir = path.join(__dirname, 'www');

// Ensure destination directories exist
if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
const vendorDest = path.join(destDir, 'vendor');
if (!fs.existsSync(vendorDest)) fs.mkdirSync(vendorDest, { recursive: true });

const filesToCopy = [
  'index.html',
  'styles.css',
  'renderer.js',
  'extras.js',
  'library-tools.js',
  'eq.js',
  'ringtone.js',
  'translit.js',
  'platform-adapter.js',
  'mobile-ui.js',
  'icon.png',
  'icon.svg'
];

// Files shared with the Linux app live one level up in the repo root.
const sharedFiles = ['visualizer.js'];
const sharedDir = path.join(__dirname, '..');

console.log('Copying web assets to www/ ...');
for (const file of sharedFiles) {
  const src = path.join(sharedDir, file);
  if (!fs.existsSync(src)) { console.error(`  ✗ Missing shared file: ../${file}`); process.exit(1); }
  fs.copyFileSync(src, path.join(destDir, file));
  console.log(`  ✓ ../${file} (shared)`);
}
for (const file of filesToCopy) {
  const src = path.join(srcDir, file);
  const dest = path.join(destDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  ✓ ${file}`);
  } else {
    console.warn(`  ⚠ Missing: ${file}`);
  }
}

// Copy vendor files
const vendorFiles = ['howler.min.js', 'sanscript.js', 'jsmediatags.min.js'];
for (const file of vendorFiles) {
  const src = path.join(srcDir, 'vendor', file);
  const dest = path.join(vendorDest, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  ✓ vendor/${file}`);
  } else {
    console.warn(`  ⚠ Missing vendor: ${file}`);
  }
}

console.log('Done! Assets ready in www/');
