package io.github.alexknight0.podcastplayer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.os.Bundle;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // The WebView doesn't pause on its own when headphones are unplugged or AirPods
    // disconnect (ACTION_AUDIO_BECOMING_NOISY), so tell the page.
    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (getBridge() != null) {
                getBridge().eval("window.dispatchEvent(new Event('becomingnoisy'))", null);
            }
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before super.onCreate creates the bridge.
        registerPlugin(GoogleSignInPlugin.class);
        super.onCreate(savedInstanceState);
        ContextCompat.registerReceiver(
            this, noisyReceiver,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    public void onDestroy() {
        unregisterReceiver(noisyReceiver);
        super.onDestroy();
    }
}
