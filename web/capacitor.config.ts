import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.samvad.app',
  appName: 'SAMVAD',
  webDir: 'dist',
  server: {
    // Default 'https' makes the packaged app load as https://localhost,
    // which then mixed-content-blocks the plain ws:// signaling connection
    // (a real deployment would front the signaling server with wss:// +
    // a real cert; today's LAN dev server doesn't have one). 'localhost'
    // is treated as a secure context regardless of scheme, so getUserMedia
    // still works — this only changes http vs https, not security.
    androidScheme: 'http',
  },
};

export default config;
