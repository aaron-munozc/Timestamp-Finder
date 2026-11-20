import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  vite: () => ({
    plugins: [tailwindcss()],
    build: {
        sourcemap: false,
    },
  }),
  modules: ['@wxt-dev/module-react'],
  manifest: {
      name: 'YouTube Comment Timestamp Finder',
      short_name: 'YT Timestamps',
      description:
        'Find, group, and jump to comment timestamps on YouTube videos and Shorts with configurable duplicate tolerance.',
      version: '1.0.0',

      // Only what your README specifies: local extension storage + YouTube domains
      permissions: ['storage'],
      host_permissions: [
        '*://*.youtube.com/*',
        '*://youtu.be/*',
      ],

      // Must be PNGs in public/ (e.g. public/icon/16.png, etc.) — SVG is not supported by browsers here
      icons: {
        16: 'icons/16.png',
        32: 'icons/32.png',
        48: 'icons/48.png',
        96: 'icons/96.png',
        128: 'icons/128.png',
      },

      // Required if you publish to Firefox Add-ons (AMO)
      browser_specific_settings: {
        gecko: {
          id: 'yt-comment-timestamp-finder@something.extension',
          strict_min_version: '121.0',
        },
      },
    },
});
