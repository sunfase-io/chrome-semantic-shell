import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const distDir = path.join(__dirname, '..', '..', 'dist');
// 清理上次构建
console.log('清理上次构建...');
try {
  fs.rmSync(distDir, { recursive: true, force: true });
} catch (err) {
  throw new Error(`无法清理构建目录 ${distDir}: ${err instanceof Error ? err.message : err}`);
}

// 创建dist目录
fs.mkdirSync(distDir, { recursive: true });
console.log('dist 目录已创建');

// 编译TypeScript
console.log('编译TypeScript...');
execSync('tsc', { stdio: 'inherit' });

console.log('复制包装脚本...');
const scriptsSourceDir = path.join(__dirname, '.');
const macOsWrapperSourcePath = path.join(scriptsSourceDir, 'run_host.sh');
const windowsWrapperSourcePath = path.join(scriptsSourceDir, 'run_host.bat');

const macOsWrapperDestPath = path.join(distDir, 'run_host.sh');
const windowsWrapperDestPath = path.join(distDir, 'run_host.bat');

try {
  if (fs.existsSync(macOsWrapperSourcePath)) {
    fs.copyFileSync(macOsWrapperSourcePath, macOsWrapperDestPath);
    console.log(`已将 ${macOsWrapperSourcePath} 复制到 ${macOsWrapperDestPath}`);
  } else {
    console.error(`错误: macOS 包装脚本源文件未找到: ${macOsWrapperSourcePath}`);
  }

  if (fs.existsSync(windowsWrapperSourcePath)) {
    fs.copyFileSync(windowsWrapperSourcePath, windowsWrapperDestPath);
    console.log(`已将 ${windowsWrapperSourcePath} 复制到 ${windowsWrapperDestPath}`);
  } else {
    console.error(`错误: Windows 包装脚本源文件未找到: ${windowsWrapperSourcePath}`);
  }
} catch (error) {
  console.error('复制包装脚本时出错:', error);
}

// 为关键JavaScript文件和macOS包装脚本添加可执行权限
console.log('添加可执行权限...');
const filesToMakeExecutable = ['index.js', 'cli.js', 'semantic-cli.js', 'run_host.sh'];

filesToMakeExecutable.forEach((file) => {
  const filePath = path.join(distDir, file); // filePath 现在是目标路径
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, '755');
      console.log(`已为 ${file} 添加可执行权限 (755)`);
    } else {
      console.warn(`警告: ${filePath} 不存在，无法添加可执行权限`);
    }
  } catch (error) {
    console.error(`为 ${file} 添加可执行权限时出错:`, error);
  }
});

// Write node_path.txt immediately after build to ensure Chrome uses the correct Node.js version.
// This is critical for development mode where dist is deleted on each rebuild.
// The file points to the same Node.js used to build/install the CLI.
console.log('写入 node_path.txt...');
const nodePathFile = path.join(distDir, 'node_path.txt');
fs.writeFileSync(nodePathFile, process.execPath, 'utf8');
console.log(`已写入 Node.js 路径: ${process.execPath}`);

console.log('✅ 构建完成');
