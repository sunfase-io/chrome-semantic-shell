import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { defineConfig } from 'wxt';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local') });

// Extension signing keys are public. Keeping the unpacked/release ID stable is required because
// Native Messaging allowlists extension origins by ID.
const STABLE_EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArrtfHInqCGPqhB2Wr+z6mP529Nye6esnyMUN0gHDZ58rrdn7BsLvooGBx2eZETh30Hle0drFiJHOuqYkQ86ACRqf7UTcPzbSybH5vUR3eOhKCa5BVPXHgvRpl0Zcg+E8iBCegwFNWK8T4FaLz6K5iQpgVy4tbdPEDtMOc/VJMTgtmOGpBLn1s2/30AGE5YFr6MDdpsxOASlAo5DCTk0VKha9fNnnFguCD20vZ/bau8qEA3bNtCoHEgyMFD4S9NIIUZ79P9SePPkAKwUdeBiO9xaUaktGAQz1DIQZgv5hegRgDJ2WWPNAE43NwY8gMvu31TBqCnXwxN8pSRtds+vPgwIDAQAB';

export default defineConfig({
  outDir: resolve(dirname(fileURLToPath(import.meta.url)), '../../dist-extension'),
  webExt: { disabled: true },
  manifest: {
    key: process.env.CHROME_EXTENSION_KEY || STABLE_EXTENSION_KEY,
    default_locale: 'zh_CN',
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    permissions: [
      'nativeMessaging',
      'tabs',
      'activeTab',
      'scripting',
      'downloads',
      'webRequest',
      'webNavigation',
      'debugger',
      'offscreen',
      'userScripts',
    ],
    host_permissions: ['<all_urls>'],
  },
  vite: (env) => ({
    plugins: [
      viteStaticCopy({
        targets: [
          { src: 'inject-scripts/*.js', dest: 'inject-scripts' },
          { src: '_locales/**/*', dest: '_locales' },
        ],
        hook: 'writeBundle',
      }) as any,
    ],
    build: {
      target: 'es2015',
      emptyOutDir: true,
      modulePreload: false,
      sourcemap: env.mode !== 'production',
      reportCompressedSize: false,
      minify: 'esbuild',
    },
  }),
});
