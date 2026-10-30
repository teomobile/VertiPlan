import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'it.teomobile.vertiplan',
  appName: 'VertiPlan',
  webDir: 'dist/vertiplan/browser',
  android: {
    // richiesto da @capacitor-community/background-geolocation: senza, Android ferma
    // gli aggiornamenti di posizione dopo ~5 minuti in background
    useLegacyBridge: true,
  },
};

export default config;
