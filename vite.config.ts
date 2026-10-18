import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const proxyConfig = {
  '/api/adsb': {
    target: 'https://opendata.adsb.fi/api',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/adsb/, ''),
  },
  '/api/planespotters': {
    target: 'https://api.planespotters.net/pub/photos',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/planespotters/, ''),
    headers: {
      'User-Agent': 'SafeCommAviation/1.0 (+https://safecomm.app; contact@safecomm.app)',
    },
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: proxyConfig,
  },
  preview: {
    proxy: proxyConfig,
  },
});
