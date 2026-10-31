const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = __dirname;
const apkPath = path.join(rootDir, 'serein-music-player.apk');
const keystorePath = path.join(rootDir, 'signing', 'serein-release.jks');
const signerJar = path.join(rootDir, 'signing', 'uber-apk-signer.jar');
const javaBin = process.env.JAVA_BIN || 'java';
const KS_PASS = process.env.SEREIN_KS_PASS;
if (!KS_PASS) { console.error('Set SEREIN_KS_PASS to the keystore password'); process.exit(1); }

function run(cmd, cwd = rootDir) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

console.log('--- 1. Building web assets ---');
run('node build-mobile.js');

console.log('--- 2. Syncing Capacitor Android ---');
run('npx cap sync android');

console.log('--- 3. Injecting updated web assets into APK ---');
const mainAssetsDir = path.join(rootDir, 'android', 'app', 'src', 'main');
run(`zip -u "${apkPath}" assets/public/* assets/public/vendor/*`, mainAssetsDir);

console.log('--- 4. Zipaligning and signing APK ---');
run(`"${javaBin}" -jar "${signerJar}" -a "${apkPath}" --ks "${keystorePath}" --ksAlias serein --ksPass ${KS_PASS} --ksKeyPass ${KS_PASS} --allowResign --overwrite`);

// Also sync debug copy
const debugApk = path.join(rootDir, 'music-player.apk');
fs.copyFileSync(apkPath, debugApk);
const releaseOut = path.join(rootDir, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (fs.existsSync(path.dirname(releaseOut))) fs.copyFileSync(apkPath, releaseOut);

if (process.argv.includes('--install')) {
  console.log('--- 5. Installing to connected device via ADB ---');
  run(`adb install -r --no-incremental "${apkPath}"`);
  console.log('--- 6. Restarting app on device ---');
  try {
    run('adb shell am force-stop com.sereinmusicplayer.app');
    run('adb shell am start -n com.sereinmusicplayer.app/.MainActivity');
  } catch (err) {
    console.warn('Could not launch app via adb:', err.message);
  }
}

console.log('✓ Build & package complete!');
