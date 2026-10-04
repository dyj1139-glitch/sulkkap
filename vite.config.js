import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  // 배포마다 실제 공개 주소로 OG 이미지 URL을 HTML에 넣습니다.
  // og:url은 고정하지 않습니다. 공유 링크의 ?share= ID를 유지합니다.
  const host = env.PUBLIC_SITE_URL || env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || 'http://localhost:5173';
  const origin = new URL(/^https?:\/\//.test(host) ? host : `https://${host}`).origin;
  return {
    plugins: [react(), { name: 'sulkkap-sharing-metadata', transformIndexHtml: html => html.replaceAll('__PUBLIC_ORIGIN__', origin) }],
    server: { host: '0.0.0.0' },
  };
});
