# Serein Music Player (Android)

This project has been ported from a Linux Electron music player into a cross-platform Android application powered by **Capacitor**, with native Android MediaStore integration, background audio playback, and a mobile-optimized touch interface.

---

## What Was Added & Changed

### 1. Mobile & Touch Responsive Interface
- **Bottom Navigation Tabs**: 
  - 🎵 **Library**: View songs grouped by folder, playlists, favorites, history, and search.
  - 💿 **Player**: Full-screen player with album art glow, track info, seek bar, transport controls, and visualizer.
  - 📜 **Lyrics**: Full-screen lyrics viewer with synchronized scrolling, online fetching, and editing.
  - 🎚️ **Equalizer**: 5-band Web Audio equalizer with presets (Bass boost, Vocal, Rock, Pop, etc.) and preamp.
- **Floating Mini-Player**: When browsing your library or lyrics while a track is loaded/playing, a mini-player bar floats above the bottom navigation bar with play/pause and track controls. Tapping it returns to the full Now Playing screen.
- **Swipe Gestures**: Swipe left or right on the Now Playing screen to skip to the next or previous track.
- **Safe Area Insets**: Full support for Android edge-to-edge displays, notches, and navigation bars.

### 2. Native Android Integration
- **`MediaStorePlugin.java`**:
  - Automatically queries Android's `MediaStore.Audio.Media` to discover all music on your internal storage and SD card.
  - Requests appropriate runtime permissions (`READ_MEDIA_AUDIO` on Android 13+ / `READ_EXTERNAL_STORAGE` on older versions).
  - Extracts title, artist, album, duration, and system album art URIs (`content://media/external/audio/albumart/...`).
- **`AudioPlayerService.java`**:
  - Android Foreground Service with a `PARTIAL_WAKE_LOCK` and ongoing notification.
  - Prevents Android battery optimizations from sleeping or stopping playback when the screen turns off.
  - Integrates with Android's lock screen and Bluetooth controls via the `MediaSession` API.
- **Launcher Icons**: App icons added to Android mipmap resource directories.

### 3. Cross-Platform Bridge (`platform-adapter.js`)
- Replaces Node.js dependencies (`fs`, `path`, `crypto`, `electron`) with browser and Android shims.
- Saves favorites, playlists, history, folders, and lyrics in `localStorage` when running on Android or Web.
- Uses `Capacitor.convertFileSrc(...)` to stream local Android device audio tracks smoothly into Howler.
- Integrates client-side ID3 reading (`jsmediatags`) and Indic transliteration (`sanscript`).
- Dual compatibility: The Linux desktop Electron app still runs with `npm start`!

---

## How to Build and Run on Android

### Option A: Using Android Studio (Recommended)
1. Open **Android Studio**.
2. Click **File -> Open...** and select the [`android/`](file:///mnt/D48433EE8433D1AA/Software/Android%20from%20me/music-player/android) folder inside this directory.
3. Connect your Android phone via USB (with USB Debugging enabled) or start an Android Emulator.
4. Click the green **Run (▶)** button in Android Studio.
5. Android Studio will automatically compile the project, package the APK, install it on your device, and launch the app!

### Option B: Building APK via Command Line
If you have JDK 17+ and the Android SDK installed:
```bash
# 1. Sync web assets
npm run build:mobile

# 2. Build Debug APK
cd android
./gradlew assembleDebug
```
The output APK will be generated at:
`android/app/build/outputs/apk/debug/app-debug.apk`

You can install it directly onto a connected phone with:
```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Project Scripts
- `npm run build:mobile` — Rebuilds web assets in `www/` and syncs them to the Android project (`android/app/src/main/assets/public`).
- `npm run cap:open` — Opens the native project in Android Studio.
- `npm run cap:sync` — Syncs native Capacitor plugins and web files to Android.
- `npm start` — Runs the original desktop Electron app on Linux.
