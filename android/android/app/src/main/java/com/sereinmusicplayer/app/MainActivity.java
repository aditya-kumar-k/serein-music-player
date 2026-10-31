package com.sereinmusicplayer.app;

import android.content.Intent;
import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MediaStorePlugin.class);
        super.onCreate(savedInstanceState);

        // Back sends the app to the background instead of closing it, so music keeps playing
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                moveTaskToBack(true);
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == MediaStorePlugin.REQ_DELETE_AUDIO) {
            PluginHandle handle = getBridge().getPlugin("MediaStorePlugin");
            if (handle != null && handle.getInstance() instanceof MediaStorePlugin) {
                ((MediaStorePlugin) handle.getInstance()).handleDeleteResult(resultCode);
            }
        }
    }
}
