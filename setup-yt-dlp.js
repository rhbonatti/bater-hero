const YTDlpWrap = require('yt-dlp-wrap').default;
const path = require('path');
const fs = require('fs');

async function ensureYtDlp() {
  const platform = process.platform;
  const fileName = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const binaryPath = path.join(__dirname, fileName);

  if (fs.existsSync(binaryPath)) {
    console.log(`yt-dlp já existe em: ${binaryPath}`);
    return;
  }

  console.log(`Baixando yt-dlp para ${platform}...`);
  await YTDlpWrap.downloadFromGithub(binaryPath);
  
  if (platform !== 'win32') {
    fs.chmodSync(binaryPath, '755');
  }
  
  console.log('Download concluído!');
}

ensureYtDlp().catch(err => {
  console.error('Erro ao setup yt-dlp:', err);
  process.exit(1);
});
