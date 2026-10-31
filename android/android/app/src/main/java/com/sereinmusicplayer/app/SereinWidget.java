package com.sereinmusicplayer.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.widget.RemoteViews;

/** Home-screen widget: current song with previous / play-pause / next. Buttons talk to the playback
 *  service while it runs; when it doesn't, every tap just opens the app. */
public class SereinWidget extends AppWidgetProvider {
    private static final String PREFS = "serein_widget";
    private static Bitmap lastArt;

    public static void update(Context ctx, String title, String artist, boolean playing, boolean active, Bitmap art) {
        ctx = ctx.getApplicationContext();
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("title", title == null ? "" : title).putString("artist", artist == null ? "" : artist)
            .putBoolean("playing", playing).putBoolean("active", active).apply();
        lastArt = (active && art != null) ? Bitmap.createScaledBitmap(art, 160, 160, true) : null;
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, SereinWidget.class));
        for (int id : ids) mgr.updateAppWidget(id, build(ctx));
    }

    private static RemoteViews build(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean active = sp.getBoolean("active", false) && AudioPlayerService.isRunning();
        boolean playing = active && sp.getBoolean("playing", false);
        String title = sp.getString("title", "");
        String artist = sp.getString("artist", "");

        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_player);
        v.setTextViewText(R.id.w_title, active && !title.isEmpty() ? title : "Serein");
        v.setTextViewText(R.id.w_artist, active ? artist : "Tap to play music");
        v.setImageViewResource(R.id.w_play, playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play);
        if (active && lastArt != null) v.setImageViewBitmap(R.id.w_art, lastArt);
        else v.setImageViewResource(R.id.w_art, R.mipmap.ic_launcher);

        Intent open = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(ctx, 10, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        v.setOnClickPendingIntent(R.id.w_root, openPi);
        v.setOnClickPendingIntent(R.id.w_art, openPi);
        v.setOnClickPendingIntent(R.id.w_text, openPi);
        v.setOnClickPendingIntent(R.id.w_prev, btn(ctx, active, "com.sereinmusicplayer.app.PREV", 11, openPi));
        v.setOnClickPendingIntent(R.id.w_play, btn(ctx, active, "com.sereinmusicplayer.app.TOGGLE", 12, openPi));
        v.setOnClickPendingIntent(R.id.w_next, btn(ctx, active, "com.sereinmusicplayer.app.NEXT", 13, openPi));
        return v;
    }

    private static PendingIntent btn(Context ctx, boolean active, String action, int code, PendingIntent fallback) {
        if (!active) return fallback;
        Intent i = new Intent(ctx, AudioPlayerService.class).setAction(action);
        return PendingIntent.getService(ctx, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) mgr.updateAppWidget(id, build(ctx));
    }
}
