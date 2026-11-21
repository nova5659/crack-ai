#!/usr/bin/env node
import { getPort, getPublicConfig } from '../src/config.mjs';
import { startServer } from '../src/server.mjs';

const cmd = process.argv[2] || 'server';
const port = getPort();

if (cmd === 'status') {
  const cfg = getPublicConfig();
  console.log(JSON.stringify({ port, ...cfg }, null, 2));
  process.exit(0);
}

if (cmd === 'server') {
  startServer({ port })
    .then(({ network }) => {
      console.log(`✦ CRACK AI 서버가 실행되었습니다.`);
      console.log(`  로컬 접속:  ${network.localUrl}`);
      console.log(`  Wi-Fi 접속: ${network.lanUrl}`);
      console.log(`  Bonjour:   ${network.bonjourUrl}`);
    })
    .catch((err) => {
      console.error('CRACK AI 서버 시작 실패:', err.message);
      process.exit(1);
    });
} else {
  console.log('사용법: node bin/crack-ai.mjs [server|status]');
}
