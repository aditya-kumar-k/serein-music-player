package com.sereinmusicplayer.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/** Cuts a part out of any audio file the phone can decode and saves it as an AAC (.m4a) file in
 *  Ringtones / Notifications / Alarms, with optional fade in / out. */
public class AudioCutter {
    private static final long TIMEOUT_US = 10000;
    public static final double MAX_SECONDS = 180;

    public static Uri cut(Context ctx, Uri src, double startS, double endS, double fadeInS, double fadeOutS,
                          String name, String kind) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw new Exception("Needs Android 10 or newer");
        if (endS - startS < 0.5) throw new Exception("Selection is too short");
        if (endS - startS > MAX_SECONDS) throw new Exception("Selection is longer than " + (int) MAX_SECONDS + " seconds");

        // ── 1. decode the wanted part to PCM ──
        MediaExtractor ex = new MediaExtractor();
        MediaCodec dec = null;
        int sr, ch;
        byte[] pcm;
        try {
            ex.setDataSource(ctx, src, null);
            int track = -1; MediaFormat fmt = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String m = f.getString(MediaFormat.KEY_MIME);
                if (m != null && m.startsWith("audio/")) { track = i; fmt = f; break; }
            }
            if (track < 0) throw new Exception("No audio track found");
            ex.selectTrack(track);
            sr = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            ch = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            long startUs = (long) (startS * 1e6), endUs = (long) (endS * 1e6);
            ex.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC);

            dec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME));
            dec.configure(fmt, null, null, 0);
            dec.start();

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inDone = false, outDone = false;
            while (!outDone) {
                if (!inDone) {
                    int i = dec.dequeueInputBuffer(TIMEOUT_US);
                    if (i >= 0) {
                        ByteBuffer b = dec.getInputBuffer(i);
                        int n = ex.readSampleData(b, 0);
                        long t = ex.getSampleTime();
                        if (n < 0 || t > endUs + 300000) {
                            dec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inDone = true;
                        } else {
                            dec.queueInputBuffer(i, 0, n, t, 0);
                            ex.advance();
                        }
                    }
                }
                int o = dec.dequeueOutputBuffer(info, TIMEOUT_US);
                if (o >= 0) {
                    if (info.size > 0) {
                        ByteBuffer ob = dec.getOutputBuffer(o);
                        byte[] chunk = new byte[info.size];
                        ob.position(info.offset);
                        ob.get(chunk, 0, info.size);
                        int bpf = 2 * ch;
                        long frameStart = info.presentationTimeUs * sr / 1000000L;
                        long s0 = startUs * sr / 1000000L, s1 = endUs * sr / 1000000L;
                        long from = Math.max(0, s0 - frameStart);
                        long to = Math.min(chunk.length / bpf, s1 - frameStart);
                        if (to > from) out.write(chunk, (int) from * bpf, (int) (to - from) * bpf);
                    }
                    dec.releaseOutputBuffer(o, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outDone = true;
                } else if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = dec.getOutputFormat();
                    sr = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    ch = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                }
            }
            pcm = out.toByteArray();
        } finally {
            if (dec != null) { try { dec.stop(); } catch (Exception ignored) {} dec.release(); }
            ex.release();
        }
        if (pcm.length == 0) throw new Exception("Nothing could be decoded from that range");

        // ── 2. fades ──
        applyFade(pcm, ch, (int) (fadeInS * sr), true);
        applyFade(pcm, ch, (int) (fadeOutS * sr), false);

        // ── 3. create the MediaStore entry and encode into it ──
        String folder, flag;
        if ("notification".equals(kind)) { folder = "Notifications/"; flag = MediaStore.Audio.Media.IS_NOTIFICATION; }
        else if ("alarm".equals(kind))   { folder = "Alarms/";        flag = MediaStore.Audio.Media.IS_ALARM; }
        else                             { folder = "Ringtones/";     flag = MediaStore.Audio.Media.IS_RINGTONE; }
        String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        if (safe.isEmpty()) safe = "Ringtone";

        ContentResolver cr = ctx.getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.Audio.Media.DISPLAY_NAME, safe + ".m4a");
        v.put(MediaStore.Audio.Media.TITLE, safe);
        v.put(MediaStore.Audio.Media.MIME_TYPE, "audio/mp4");
        v.put(MediaStore.Audio.Media.RELATIVE_PATH, folder);
        v.put(MediaStore.Audio.Media.IS_MUSIC, 0);
        v.put(flag, 1);
        v.put(MediaStore.Audio.Media.IS_PENDING, 1);
        Uri dest = cr.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, v);
        if (dest == null) throw new Exception("Couldn't create the file");

        try (ParcelFileDescriptor pfd = cr.openFileDescriptor(dest, "rw")) {
            encode(pcm, sr, ch, pfd);
        } catch (Exception e) {
            try { cr.delete(dest, null, null); } catch (Exception ignored) {}
            throw e;
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.Audio.Media.IS_PENDING, 0);
        cr.update(dest, done, null, null);
        return dest;
    }

    private static void applyFade(byte[] pcm, int ch, int frames, boolean in) {
        int total = pcm.length / (2 * ch);
        frames = Math.min(frames, total);
        if (frames <= 0) return;
        for (int f = 0; f < frames; f++) {
            float g = (float) f / frames;
            int frame = in ? f : total - 1 - f;
            for (int c = 0; c < ch; c++) {
                int idx = (frame * ch + c) * 2;
                short s = (short) ((pcm[idx] & 0xff) | (pcm[idx + 1] << 8));
                s = (short) (s * g);
                pcm[idx] = (byte) (s & 0xff);
                pcm[idx + 1] = (byte) ((s >> 8) & 0xff);
            }
        }
    }

    private static void encode(byte[] pcm, int sr, int ch, ParcelFileDescriptor pfd) throws Exception {
        MediaFormat of = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sr, ch);
        of.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        of.setInteger(MediaFormat.KEY_BIT_RATE, ch == 1 ? 128000 : 192000);
        of.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 65536);
        MediaCodec enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        enc.configure(of, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        enc.start();
        MediaMuxer mux = new MediaMuxer(pfd.getFileDescriptor(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        int muxTrack = -1; boolean muxStarted = false;
        try {
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            int pos = 0; boolean inDone = false, outDone = false;
            int bpf = 2 * ch;
            while (!outDone) {
                if (!inDone) {
                    int i = enc.dequeueInputBuffer(TIMEOUT_US);
                    if (i >= 0) {
                        ByteBuffer b = enc.getInputBuffer(i);
                        b.clear();
                        int n = Math.min(b.remaining() / bpf * bpf, pcm.length - pos);
                        long pts = (long) (pos / bpf) * 1000000L / sr;
                        if (n <= 0) {
                            enc.queueInputBuffer(i, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inDone = true;
                        } else {
                            b.put(pcm, pos, n);
                            enc.queueInputBuffer(i, 0, n, pts, 0);
                            pos += n;
                        }
                    }
                }
                int o = enc.dequeueOutputBuffer(info, TIMEOUT_US);
                if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    muxTrack = mux.addTrack(enc.getOutputFormat());
                    mux.start(); muxStarted = true;
                } else if (o >= 0) {
                    ByteBuffer ob = enc.getOutputBuffer(o);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0;
                    if (info.size > 0 && muxStarted) {
                        ob.position(info.offset);
                        ob.limit(info.offset + info.size);
                        mux.writeSampleData(muxTrack, ob, info);
                    }
                    enc.releaseOutputBuffer(o, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outDone = true;
                }
            }
        } finally {
            try { enc.stop(); } catch (Exception ignored) {}
            enc.release();
            if (muxStarted) { try { mux.stop(); } catch (Exception ignored) {} }
            mux.release();
        }
    }
}
