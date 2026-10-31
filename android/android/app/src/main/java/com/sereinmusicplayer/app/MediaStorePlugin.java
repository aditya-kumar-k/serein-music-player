package com.sereinmusicplayer.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.BroadcastReceiver;
import android.content.ContentUris;
import android.content.Context;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.content.Intent;
import android.content.IntentSender;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import android.util.Size;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(
    name = "MediaStorePlugin",
    permissions = {
        @Permission(
            alias = "audio",
            strings = {
                Manifest.permission.READ_EXTERNAL_STORAGE
            }
        ),
        @Permission(
            alias = "notifications",
            strings = {
                "android.permission.POST_NOTIFICATIONS"
            }
        ),
        @Permission(
            alias = "mediaAudio",
            strings = {
                "android.permission.READ_MEDIA_AUDIO"
            }
        )
    }
)
public class MediaStorePlugin extends Plugin {

    // Headphones / Bluetooth unplugged or disconnected: tell the page so it can pause
    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                notifyListeners("audioBecomingNoisy", new JSObject());
            }
        }
    };

    @Override
    public void load() {
        // Notification / lock-screen buttons → the page
        AudioPlayerService.listener = (action, positionMs) -> {
            JSObject ev = new JSObject();
            ev.put("action", action);
            ev.put("position", positionMs);
            notifyListeners("mediaAction", ev);
        };
        ContextCompat.registerReceiver(
            getContext(),
            noisyReceiver,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @Override
    protected void handleOnDestroy() {
        AudioPlayerService.listener = null;
        try { getContext().unregisterReceiver(noisyReceiver); } catch (Exception ignored) {}
        super.handleOnDestroy();
    }

    @PluginMethod
    public void scanAudioFiles(PluginCall call) {
        if (!hasAudioPermission()) {
            requestAudioPermission(call);
            return;
        }

        queryMediaStore(call, null);
    }

    @PluginMethod
    public void chooseFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "folderPickerResult");
    }

    @ActivityCallback
    private void folderPickerResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Folder selection was cancelled");
            return;
        }

        Uri treeUri = result.getData().getData();
        if (treeUri == null) {
            call.reject("No folder was selected");
            return;
        }

        try {
            getContext().getContentResolver().takePersistableUriPermission(
                treeUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
        } catch (Exception ignored) {}

        // Resolve folder name from URI (e.g. primary:Music -> Music)
        String folderName = "Music";
        String path = treeUri.getPath();
        if (path != null) {
            int colon = path.lastIndexOf(':');
            if (colon >= 0 && colon < path.length() - 1) {
                folderName = path.substring(colon + 1);
                if (folderName.contains("/")) {
                    folderName = folderName.substring(folderName.lastIndexOf('/') + 1);
                }
            } else {
                folderName = treeUri.getLastPathSegment();
            }
        }
        if (folderName == null || folderName.isEmpty()) {
            folderName = "Selected Music";
        }

        scanDocumentTree(treeUri, folderName, call);
    }

    private void scanDocumentTree(Uri treeUri, String folderName, PluginCall call) {
        new Thread(() -> {
            JSArray songsArray = new JSArray();
            try {
                String treeDocId = DocumentsContract.getTreeDocumentId(treeUri);
                scanDirectory(treeUri, treeDocId, folderName, songsArray, 0);
            } catch (Exception e) {
                // fall through to check songsArray
            }

            if (songsArray.length() == 0) {
                // Fallback to queryMediaStore if direct SAF traversal found nothing
                queryMediaStore(call, folderName);
                return;
            }

            JSObject ret = new JSObject();
            ret.put("folder", folderName);
            ret.put("songs", songsArray);
            ret.put("count", songsArray.length());
            call.resolve(ret);
        }).start();
    }

    private void scanDirectory(Uri treeUri, String parentDocId, String folderName, JSArray songsArray, int depth) {
        if (depth > 5) return;
        ContentResolver resolver = getContext().getContentResolver();
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId);

        String[] projection = new String[] {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE
        };

        try (Cursor cursor = resolver.query(childrenUri, projection, null, null, null)) {
            if (cursor == null) return;
            int idCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            int nameCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
            int mimeCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE);
            int sizeCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE);

            while (cursor.moveToNext()) {
                String docId = cursor.getString(idCol);
                String displayName = cursor.getString(nameCol);
                String mimeType = cursor.getString(mimeCol);
                long size = sizeCol != -1 ? cursor.getLong(sizeCol) : 0;

                if (displayName == null) displayName = "Track";

                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType)) {
                    if (displayName.toLowerCase().contains("whatsapp")) continue;
                    scanDirectory(treeUri, docId, folderName, songsArray, depth + 1);
                } else if (isAudioFile(displayName, mimeType)) {
                    Uri fileUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
                    JSObject song = extractSongMetadata(fileUri, displayName, folderName, size);
                    songsArray.put(song);
                }
            }
        } catch (Exception ignored) {}
    }

    private boolean isAudioFile(String name, String mimeType) {
        if (mimeType != null && mimeType.startsWith("audio/")) return true;
        if (name == null) return false;
        String lower = name.toLowerCase();
        return lower.endsWith(".mp3") || lower.endsWith(".m4a") || lower.endsWith(".flac") ||
               lower.endsWith(".wav") || lower.endsWith(".ogg") || lower.endsWith(".aac") ||
               lower.endsWith(".opus") || lower.endsWith(".wma");
    }

    private JSObject extractSongMetadata(Uri uri, String displayName, String folderName, long size) {
        String title = displayName.replaceFirst("[.][^.]+$", "");
        String artist = "";
        String album = (folderName != null && !folderName.isEmpty()) ? folderName : "Unknown Album";
        int duration = 0;

        try {
            MediaMetadataRetriever mmr = new MediaMetadataRetriever();
            mmr.setDataSource(getContext(), uri);
            String t = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE);
            String a = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST);
            String al = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM);
            String d = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (t != null && !t.trim().isEmpty()) title = t.trim();
            if (a != null && !a.trim().isEmpty()) artist = a.trim();
            if (al != null && !al.trim().isEmpty()) album = al.trim();
            if (d != null) {
                try { duration = (int)(Long.parseLong(d) / 1000); } catch (Exception ignored) {}
            }
            mmr.release();
        } catch (Exception ignored) {}

        JSObject song = new JSObject();
        song.put("id", uri.toString());
        song.put("name", displayName);
        song.put("title", title);
        song.put("artist", artist);
        song.put("album", album);
        song.put("duration", duration);
        song.put("path", uri.toString());
        song.put("contentUri", uri.toString());
        song.put("folder", (folderName != null && !folderName.isEmpty()) ? folderName : "Music");
        song.put("size", size);
        return song;
    }

    @PluginMethod
    public void chooseAudioFiles(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("audio/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "audioFilesPickerResult");
    }

    @ActivityCallback
    private void audioFilesPickerResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("File selection was cancelled");
            return;
        }

        Intent data = result.getData();
        List<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) {
            int count = data.getClipData().getItemCount();
            for (int i = 0; i < count; i++) {
                uris.add(data.getClipData().getItemAt(i).getUri());
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }

        if (uris.isEmpty()) {
            call.reject("No audio files selected");
            return;
        }

        new Thread(() -> {
            JSArray songsArray = new JSArray();
            ContentResolver resolver = getContext().getContentResolver();

            for (Uri uri : uris) {
                try {
                    resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception ignored) {}

                String displayName = "Unknown Track";
                long size = 0;
                try (Cursor c = resolver.query(uri, null, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        int nameCol = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        int sizeCol = c.getColumnIndex(OpenableColumns.SIZE);
                        if (nameCol != -1) displayName = c.getString(nameCol);
                        if (sizeCol != -1) size = c.getLong(sizeCol);
                    }
                } catch (Exception ignored) {}

                JSObject song = extractSongMetadata(uri, displayName, "Imported Music", size);
                songsArray.put(song);
            }

            JSObject ret = new JSObject();
            ret.put("folder", "Imported Music");
            ret.put("songs", songsArray);
            ret.put("count", songsArray.length());
            call.resolve(ret);
        }).start();
    }

    private boolean hasAudioPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return ContextCompat.checkSelfPermission(getContext(), "android.permission.READ_MEDIA_AUDIO") == PackageManager.PERMISSION_GRANTED;
        } else {
            return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
        }
    }

    private void requestAudioPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissionForAlias("mediaAudio", call, "permissionCallback");
        } else {
            requestPermissionForAlias("audio", call, "permissionCallback");
        }
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        if (hasAudioPermission()) {
            queryMediaStore(call, null);
        } else {
            call.reject("Audio permission denied. Please grant music/audio storage permission to scan tracks.");
        }
    }

    private void queryMediaStore(PluginCall call, String specificFolder) {
        new Thread(() -> {
            JSArray songsArray = new JSArray();
            Uri contentUri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
            Uri albumArtBaseUri = Uri.parse("content://media/external/audio/albumart");

            String[] projection = new String[] {
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.DATA,
                MediaStore.Audio.Media.ALBUM_ID,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.DATE_ADDED
            };

            String selection;
            String[] selectionArgs = null;

            if (specificFolder != null && !specificFolder.isEmpty()) {
                selection = "((" + MediaStore.Audio.Media.IS_MUSIC + " != 0) OR (" + MediaStore.Audio.Media.DURATION + " > 5000)) AND " +
                            "(" + MediaStore.Audio.Media.DATA + " LIKE ? OR " + MediaStore.Audio.Media.DATA + " LIKE ?)";
                selectionArgs = new String[] { "%/" + specificFolder + "/%", "%:" + specificFolder + "/%" };
            } else {
                selection = "(" + MediaStore.Audio.Media.IS_MUSIC + " != 0) OR (" + 
                            MediaStore.Audio.Media.DURATION + " > 5000) OR (" +
                            MediaStore.Audio.Media.DATA + " LIKE '%.mp3') OR (" +
                            MediaStore.Audio.Media.DATA + " LIKE '%.m4a') OR (" +
                            MediaStore.Audio.Media.DATA + " LIKE '%.flac')";
            }

            // never scan WhatsApp folders (voice notes, received audio)
            selection = "(" + selection + ") AND " + MediaStore.Audio.Media.DATA + " NOT LIKE '%whatsapp%'";

            String sortOrder = MediaStore.Audio.Media.TITLE + " ASC";

            try (Cursor cursor = getContext().getContentResolver().query(contentUri, projection, selection, selectionArgs, sortOrder)) {
                if (cursor != null) {
                    int idCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID);
                    int titleCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE);
                    int artistCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST);
                    int albumCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);
                    int durationCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
                    int dataCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATA);
                    int albumIdCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM_ID);
                    int nameCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME);
                    int sizeCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE);
                    int addedCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_ADDED);

                    while (cursor.moveToNext()) {
                        long id = cursor.getLong(idCol);
                        String title = cursor.getString(titleCol);
                        String artist = cursor.getString(artistCol);
                        String album = cursor.getString(albumCol);
                        long durationMs = cursor.getLong(durationCol);
                        String path = cursor.getString(dataCol);
                        long albumId = cursor.getLong(albumIdCol);
                        String displayName = cursor.getString(nameCol);
                        long fileSize = cursor.getLong(sizeCol);

                        String contentUriStr = ContentUris.withAppendedId(contentUri, id).toString();
                        if (path == null || path.isEmpty()) {
                            path = contentUriStr;
                        }

                        // Determine friendly folder name
                        String folder = "Music";
                        if (specificFolder != null && !specificFolder.isEmpty()) {
                            folder = specificFolder;
                        } else if (path.startsWith("/")) {
                            try {
                                File file = new File(path);
                                String parent = file.getParent();
                                if (parent != null) {
                                    String dirName = new File(parent).getName();
                                    if (!dirName.isEmpty() && !dirName.equals("0") && !dirName.equalsIgnoreCase("emulated")) {
                                        folder = dirName;
                                    }
                                }
                            } catch (Exception ignored) {}
                        }

                        JSObject song = new JSObject();
                        song.put("id", String.valueOf(id));
                        song.put("name", (displayName != null && !displayName.isEmpty()) ? displayName : (title != null ? title + ".mp3" : "Unknown.mp3"));
                        song.put("title", (title != null && !title.isEmpty()) ? title : (displayName != null ? displayName : "Unknown"));
                        song.put("artist", (artist != null && !artist.equals("<unknown>")) ? artist : "");
                        song.put("album", (album != null && !album.equals("<unknown>")) ? album : "");
                        song.put("duration", durationMs > 0 ? (int)(durationMs / 1000) : 0);
                        song.put("path", path);
                        song.put("contentUri", contentUriStr);
                        song.put("albumArtUri", ContentUris.withAppendedId(albumArtBaseUri, albumId).toString());
                        song.put("folder", folder);
                        song.put("size", fileSize);
                        song.put("dateAdded", cursor.getLong(addedCol));

                        songsArray.put(song);
                    }
                }

                JSObject ret = new JSObject();
                ret.put("songs", songsArray);
                ret.put("count", songsArray.length());
                if (specificFolder != null) {
                    ret.put("folder", specificFolder);
                }
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Error querying audio files: " + e.getMessage(), e);
            }
        }).start();
    }

    private final ExecutorService artExecutor = Executors.newFixedThreadPool(2);

    // WebView can't load content:// URIs, so hand the cover over as a small JPEG data URL
    @PluginMethod
    public void getAlbumArt(PluginCall call) {
        String uriStr = call.getString("uri");
        int size = call.getInt("size", 512);
        if (uriStr == null || uriStr.isEmpty()) {
            call.reject("No uri");
            return;
        }
        artExecutor.execute(() -> {
            Bitmap bmp = null;
            Uri uri = Uri.parse(uriStr);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    bmp = getContext().getContentResolver().loadThumbnail(uri, new Size(size, size), null);
                } catch (Exception ignored) {}
            }
            if (bmp == null) {
                try {
                    MediaMetadataRetriever mmr = new MediaMetadataRetriever();
                    mmr.setDataSource(getContext(), uri);
                    byte[] pic = mmr.getEmbeddedPicture();
                    mmr.release();
                    if (pic != null) {
                        BitmapFactory.Options opts = new BitmapFactory.Options();
                        opts.inSampleSize = 2;
                        bmp = BitmapFactory.decodeByteArray(pic, 0, pic.length, opts);
                    }
                } catch (Exception ignored) {}
            }
            JSObject ret = new JSObject();
            if (bmp != null) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                bmp.compress(Bitmap.CompressFormat.JPEG, 85, out);
                ret.put("data", "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            }
            call.resolve(ret);
        });
    }

    // ── Backup export: let the user pick where to save a text/JSON file ──
    @PluginMethod
    public void saveTextFile(PluginCall call) {
        String name = call.getString("name", "backup.json");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "saveTextFileResult");
    }

    @ActivityCallback
    private void saveTextFileResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("Save was cancelled");
            return;
        }
        Uri uri = result.getData().getData();
        String data = call.getString("data", "");
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) { call.reject("Couldn't open the file"); return; }
            out.write(data.getBytes(StandardCharsets.UTF_8));
            out.flush();
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't save: " + e.getMessage());
        }
    }

    // ── Duplicate finder: delete audio files after the system's own confirmation ──
    private PluginCall pendingDeleteCall;
    public static final int REQ_DELETE_AUDIO = 7301;

    @PluginMethod
    public void deleteAudio(PluginCall call) {
        JSArray arr = call.getArray("uris");
        if (arr == null || arr.length() == 0) { call.reject("Nothing to delete"); return; }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            call.reject("Deleting needs Android 11 or newer");
            return;
        }
        try {
            List<Uri> uris = new ArrayList<>();
            for (int i = 0; i < arr.length(); i++) uris.add(Uri.parse(arr.getString(i)));
            IntentSender sender = MediaStore.createDeleteRequest(getContext().getContentResolver(), uris).getIntentSender();
            pendingDeleteCall = call;
            getActivity().startIntentSenderForResult(sender, REQ_DELETE_AUDIO, null, 0, 0, 0);
        } catch (Exception e) {
            pendingDeleteCall = null;
            call.reject("Couldn't start delete: " + e.getMessage());
        }
    }

    // Called by MainActivity.onActivityResult
    public void handleDeleteResult(int resultCode) {
        PluginCall call = pendingDeleteCall;
        pendingDeleteCall = null;
        if (call == null) return;
        if (resultCode == Activity.RESULT_OK) call.resolve();
        else call.reject("Delete was cancelled");
    }

    // ── Ringtone maker ──
    @PluginMethod
    public void cutAudio(PluginCall call) {
        final String uri = call.getString("uri");
        final double start = call.getDouble("start", 0.0), end = call.getDouble("end", 0.0);
        final double fin = call.getDouble("fadeIn", 0.0), fout = call.getDouble("fadeOut", 0.0);
        final String name = call.getString("name", "Ringtone"), kind = call.getString("kind", "ringtone");
        if (uri == null) { call.reject("No song given"); return; }
        new Thread(() -> {
            try {
                Uri out = AudioCutter.cut(getContext(), Uri.parse(uri), start, end, fin, fout, name, kind);
                JSObject r = new JSObject();
                r.put("uri", out.toString());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        }).start();
    }

    // Makes a saved clip the phone's default ringtone / notification / alarm sound
    @PluginMethod
    public void setSystemSound(PluginCall call) {
        String uri = call.getString("uri"), kind = call.getString("kind", "ringtone");
        if (uri == null) { call.reject("No file given"); return; }
        if (!android.provider.Settings.System.canWrite(getContext())) {
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(i);
            } catch (Exception ignored) {}
            call.reject("NEED_PERMISSION");
            return;
        }
        try {
            int type = "notification".equals(kind) ? android.media.RingtoneManager.TYPE_NOTIFICATION
                : "alarm".equals(kind) ? android.media.RingtoneManager.TYPE_ALARM : android.media.RingtoneManager.TYPE_RINGTONE;
            android.media.RingtoneManager.setActualDefaultRingtoneUri(getContext(), type, Uri.parse(uri));
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't set it: " + e.getMessage());
        }
    }

    // Page → notification: current song + play state (the service shows the controls)
    @PluginMethod
    public void updateMedia(PluginCall call) {
        String title = call.getString("title", "Playing");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        Double pos = call.getDouble("position", 0.0);
        Double dur = call.getDouble("duration", 0.0);
        String art = call.getString("uri", "");
        try {
            AudioPlayerService.update(getContext(), title, artist, album, playing,
                (long) (pos * 1000), (long) (dur * 1000), art);
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't update the notification: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopMedia(PluginCall call) {
        AudioPlayerService.stop();
        call.resolve();
    }

    // Android 13+ needs the user's OK before any notification (including the media controls) is shown
    @PluginMethod
    public void ensureNotificationPermission(PluginCall call) {
        boolean needed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(getContext(), "android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED;
        if (!needed) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionResult");
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", ContextCompat.checkSelfPermission(getContext(), "android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED);
        call.resolve(r);
    }
}
