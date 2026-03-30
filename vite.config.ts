import { defineConfig, loadEnv } from 'vite';
import { execSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolveDevProxyTarget } from './src/web/devProxyTarget';

function getGitCommitShort(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = resolveDevProxyTarget(env);
  console.log(`[vite] dev proxy target: ${proxyTarget}`);

  const frontendPort = Number.parseInt(env.FRONTEND_PORT || env.VITE_FRONTEND_PORT || '', 10);
  const resolvedFrontendPort = Number.isFinite(frontendPort) && frontendPort > 0 ? frontendPort : 5173;
  const frontendHost = (env.VITE_DEV_HOST || '127.0.0.1').trim() || '127.0.0.1';

  const buildCommit = process.env.VITE_BUILD_COMMIT || getGitCommitShort();
  const buildTime = new Date().toISOString();
  console.log(`[vite] build info: commit=${buildCommit}, time=${buildTime}`);

  return {
    root: 'src/web',
    plugins: [react(), tailwindcss()],
    define: {
      __BUILD_COMMIT__: JSON.stringify(buildCommit),
      __BUILD_TIME__: JSON.stringify(buildTime),
    },
    build: {
      outDir: '../../dist/web',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('@visactor/react-vchart') || id.includes('/@visactor/')) {
              return 'vchart-vendor';
            }
            return undefined;
          },
        },
      },
    },
    server: {
      host: frontendHost,
      port: resolvedFrontendPort,
      proxy: {
        '^/api($|/)': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '^/monitor-proxy($|/)': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '^/v1($|/)': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
