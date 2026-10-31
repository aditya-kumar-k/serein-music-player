package com.sereinmusicplayer.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Size;
import androidx.core.content.ContextCompat;

/**
 * Foreground service for background playback. The audio itself is played by the WebView (Howler);
 * this service only shows the media notification / lock-screen controls and forwards button presses
 * back to the page through {@link #listener}.
 */
public class AudioPlayerService extends Service {
    public static final String CHANNEL_ID = "music_player_playback_channel";
    public static final int NOTIFICATION_ID = 1001;

    public static final String ACTION_UPDATE = "ACTION_UPDATE";
    public static final String ACTION_STOP = "ACTION_STOP";
    private static final String ACTION_BTN_PREV = "com.sereinmusicplayer.app.PREV";
    private static final String ACTION_BTN_TOGGLE = "com.sereinmusicplayer.app.TOGGLE";
    private static final String ACTION_BTN_NEXT = "com.sereinmusicplayer.app.NEXT";

    public interface Listener { void onAction(String action, long positionMs); }
    public static volatile Listener listener;
    private static volatile AudioPlayerService instance;

    private PowerManager.WakeLock wakeLock;
    private MediaSession session;
    private final Handler main = new Handler(Looper.getMainLooper());

    private String title = "Playing", artist = "", album = "", artUri = "";
    private boolean playing = false, foreground = false;
    private long positionMs = 0, durationMs = 0;
    private Bitmap art;
    private String loadedArtUri = "";

    // ── entry points used by the plugin ─────────────────────────
    public static void update(Context ctx, String title, String artist, String album, boolean playing,
                              long positionMs, long durationMs, String artUri) {
        AudioPlayerService s = instance;
        if (s != null) {
            s.main.post(() -> s.apply(title, artist, album, playing, positionMs, durationMs, artUri));
            return;
        }
        if (!playing) return;                    // nothing to show for a paused/stopped player that isn't running
        Intent i = new Intent(ctx, AudioPlayerService.class).setAction(ACTION_UPDATE)
            .putExtra("title", title).putExtra("artist", artist).putExtra("album", album)
            .putExtra("playing", true).putExtra("pos", positionMs).putExtra("dur", durationMs)
            .putExtra("art", artUri);
        ContextCompat.startForegroundService(ctx, i);
    }

    public static boolean isRunning() { return instance != null; }

    public static void stop() {
        AudioPlayerService s = instance;
        if (s != null) s.main.post(s::shutdown);
    }

    // ── lifecycle ───────────────────────────────────────────────
    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createNotificationChannel();
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MusicPlayer:WakeLock");
            wakeLock.setReferenceCounted(false);
        }
        session = new MediaSession(this, "SereinMusicPlayer");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay()            { dispatch("play", 0); }
            @Override public void onPause()           { dispatch("pause", 0); }
            @Override public void onSkipToNext()      { dispatch("next", 0); }
            @Override public void onSkipToPrevious()  { dispatch("prev", 0); }
            @Override public void onStop()            { dispatch("stop", 0); }
            @Override public void onSeekTo(long pos)  { dispatch("seek", pos); }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        String action = intent.getAction();
        if (ACTION_UPDATE.equals(action)) {
            apply(intent.getStringExtra("title"), intent.getStringExtra("artist"), intent.getStringExtra("album"),
                  intent.getBooleanExtra("playing", true), intent.getLongExtra("pos", 0), intent.getLongExtra("dur", 0),
                  intent.getStringExtra("art"));
        } else if (ACTION_STOP.equals(action)) {
            shutdown();
        } else if (ACTION_BTN_PREV.equals(action)) {
            dispatch("prev", 0);
        } else if (ACTION_BTN_NEXT.equals(action)) {
            dispatch("next", 0);
        } else if (ACTION_BTN_TOGGLE.equals(action)) {
            dispatch(playing ? "pause" : "play", 0);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        shutdown();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        if (wakeLock != null && wakeLock.isHeld()) { try { wakeLock.release(); } catch (Exception ignored) {} }
        if (session != null) { session.setActive(false); session.release(); session = null; }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ── state → notification + media session ────────────────────
    private void apply(String t, String a, String al, boolean isPlaying, long pos, long dur, String artUriNew) {
        if (t != null && !t.isEmpty()) title = t;
        artist = a == null ? "" : a;
        album = al == null ? "" : al;
        playing = isPlaying;
        positionMs = Math.max(0, pos);
        durationMs = Math.max(0, dur);
        if (artUriNew != null && !artUriNew.equals(artUri)) {
            artUri = artUriNew;
            art = null;
            loadArtAsync(artUriNew);
        }
        render();
    }

    private void loadArtAsync(final String uriStr) {
        if (uriStr.isEmpty()) return;
        new Thread(() -> {
            Bitmap bmp = null;
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    bmp = getContentResolver().loadThumbnail(Uri.parse(uriStr), new Size(512, 512), null);
                }
            } catch (Exception ignored) {}
            final Bitmap result = bmp;
            main.post(() -> {
                if (!uriStr.equals(artUri)) return;     // song changed meanwhile
                art = result;
                loadedArtUri = uriStr;
                render();
            });
        }).start();
    }

    private void render() {
        if (session == null) return;

        MediaMetadata.Builder md = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        if (art != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(md.build());

        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
            | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP;
        session.setPlaybackState(new PlaybackState.Builder()
            .setActions(actions)
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, positionMs, playing ? 1f : 0f)
            .build());

        SereinWidget.update(this, title, artist, playing, true, art);

        Notification n = buildNotification();
        NotificationManager nm = getSystemService(NotificationManager.class);

        // Once started, stay a foreground service until shutdown: Android refuses startForeground() while the
        // app is in the background (lock screen, screen off), so pausing must never drop out of foreground.
        if (!foreground) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, n, 0);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            foreground = true;
        } else if (nm != null) {
            nm.notify(NOTIFICATION_ID, n);
        }

        if (playing) {
            if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(12 * 60 * 60 * 1000L);
        } else if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) {}
        }
    }

    private Notification buildNotification() {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);

        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);

        b.setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(title)
            .setContentText(artist.isEmpty() ? album : artist)
            .setSubText(artist.isEmpty() ? null : album)
            .setContentIntent(contentIntent)
            .setOngoing(playing)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(Notification.CATEGORY_TRANSPORT);
        if (art != null) b.setLargeIcon(art);

        b.addAction(action(android.R.drawable.ic_media_previous, "Previous", ACTION_BTN_PREV, 1));
        b.addAction(action(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                           playing ? "Pause" : "Play", ACTION_BTN_TOGGLE, 2));
        b.addAction(action(android.R.drawable.ic_media_next, "Next", ACTION_BTN_NEXT, 3));

        b.setStyle(new Notification.MediaStyle()
            .setMediaSession(session.getSessionToken())
            .setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    private Notification.Action action(int iconRes, String label, String intentAction, int requestCode) {
        Intent i = new Intent(this, AudioPlayerService.class).setAction(intentAction);
        PendingIntent pi = PendingIntent.getService(this, requestCode, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Action.Builder(Icon.createWithResource(this, iconRes), label, pi).build();
    }

    private void dispatch(String action, long pos) {
        Listener l = listener;
        if (l != null) l.onAction(action, pos);
    }

    private void shutdown() {
        playing = false;
        if (wakeLock != null && wakeLock.isHeld()) { try { wakeLock.release(); } catch (Exception ignored) {} }
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        foreground = false;
        SereinWidget.update(this, title, artist, false, false, null);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(NOTIFICATION_ID);
        stopSelf();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Now playing controls");
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }
}
