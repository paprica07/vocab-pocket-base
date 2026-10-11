const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../app.config.ts');

try {
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/version:\s*['"](\d+\.\d+\.)(\d+)['"]/, (match, p1, p2) => {
    const newVersion = p1 + (parseInt(p2) + 1);
    console.log('버전을 올려 업데이트합니다:', newVersion);
    return `version: "${newVersion}"`;
  });
  fs.writeFileSync(filePath, content, 'utf8');
} catch (error) {
  console.error('버전 업데이트 중 오류 발생:', error);
  process.exit(1);
}