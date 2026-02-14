const YTDlpWrap = require('yt-dlp-wrap').default;
const path = require('path');
const fs = require('fs');

async function ensureYtDlp() {
  const binaryPath = path.join(__dirname, 'yt-dlp.exe'); // Windows specific extension for now since user is on Windows
  
  if (fs.existsSync(binaryPath)) {
    console.log(`yt-dlp já existe em: ${binaryPath}`);
    return;
  }

  console.log('Baixando yt-dlp...');
  await YTDlpWrap.downloadFromGithub(binaryPath);
  console.log('Download concluído!');
}

ensureYtDlp().catch(err => {
  console.error('Erro ao setup yt-dlp:', err);
  process.exit(1);
});
