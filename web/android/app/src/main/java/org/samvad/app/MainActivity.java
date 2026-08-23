package org.samvad.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // SamvadBlePeripheralPlugin lives in this app's own source tree (not
        // an npm package), so `cap sync`'s node_modules plugin scan never
        // finds it — it has to be registered by hand.
        registerPlugin(SamvadBlePeripheralPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
