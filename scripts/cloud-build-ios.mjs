#!/usr/bin/env node

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO = 'zhaowendao2005/lattice-archive-v2';
const WORKFLOW = 'build-ios.yml';
const LOG_DIR = path.resolve(process.cwd(), 'logs');
const OUTPUT_DIR = path.resolve(process.cwd(), 'dist-ios');

function runCmd(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', ...options }).trim();
  } catch (err) {
    if (options.ignoreError) return null;
    throw err;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('\n🚀 ==========================================');
  console.log('   Lattice Archive: iOS 云端编译与签名流水线');
  console.log('   ==========================================\n');

  // 1. 检查目录
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 2. 检查 Git 分支与状态
  const currentBranch = runCmd('git rev-parse --abbrev-ref HEAD') || 'main';
  const gitStatus = runCmd('git status --porcelain');

  if (gitStatus) {
    console.log('⚠️  检测到本地有未提交的更改:');
    console.log(gitStatus);
    console.log('\n📦 正在自动保存本地更改并推送到远端仓库以供云端构建...');
    try {
      execSync('git add -A', { stdio: 'inherit' });
      execSync('git commit -m "chore(build): prepare cloud ios build trigger"', { stdio: 'inherit' });
      execSync(`git push origin ${currentBranch}`, { stdio: 'inherit' });
      console.log('✅ 代码已成功推送到 origin/' + currentBranch + '\n');
    } catch (e) {
      console.error('❌ Git push 失败，请确保本地修改已解决冲突后重试。', e.message);
      process.exit(1);
    }
  } else {
    // 检查是否有未 push 的 commit
    const unpushed = runCmd(`git log origin/${currentBranch}..HEAD --oneline`, { ignoreError: true });
    if (unpushed) {
      console.log('📦 发现本地有未推送的提交，正在推送到远端...');
      execSync(`git push origin ${currentBranch}`, { stdio: 'inherit' });
    }
  }

  // 3. 手动触发 GitHub Actions 工作流
  console.log(`📡 正在向 GitHub 发送触发请求 (Workflow: ${WORKFLOW}, Ref: ${currentBranch})...`);
  try {
    execSync(`gh workflow run ${WORKFLOW} --ref ${currentBranch} -R ${REPO}`, { stdio: 'inherit' });
  } catch (err) {
    console.error('❌ 触发工作流失败，请检查网络或 gh 授权状态。');
    process.exit(1);
  }

  console.log('⏳ 等待 GitHub Actions 队列分配任务...');
  await sleep(4000);

  // 4. 获取最新的 run ID
  let runId = null;
  let runUrl = null;
  for (let i = 0; i < 15; i++) {
    const listRaw = runCmd(`gh run list --workflow=${WORKFLOW} -R ${REPO} --limit 1 --json databaseId,status,url,createdAt`, { ignoreError: true });
    if (listRaw) {
      try {
        const [latest] = JSON.parse(listRaw);
        if (latest && (latest.status === 'queued' || latest.status === 'in_progress' || latest.status === 'completed')) {
          runId = latest.databaseId;
          runUrl = latest.url;
          break;
        }
      } catch {}
    }
    await sleep(2000);
  }

  if (!runId) {
    console.error('❌ 未能在超时时间内获取到触发的构建任务 ID，请在 GitHub Actions 页面查看。');
    process.exit(1);
  }

  console.log(`\n🔗 成功捕获运行实例: #${runId}`);
  console.log(`🌐 网页端仪表盘: ${runUrl}\n`);
  console.log('--------------------------------------------------');
  console.log('📺 开始实时监听构建进度 (macOS Runner 执行中)...');
  console.log('--------------------------------------------------\n');

  // 5. 使用 gh run watch 实时交互式显示构建各阶段状态
  const watchProcess = spawn('gh', ['run', 'watch', runId.toString(), '-R', REPO], {
    stdio: 'inherit',
    shell: true,
  });

  await new Promise((resolve) => {
    watchProcess.on('close', resolve);
  });

  console.log('\n--------------------------------------------------');
  console.log('📥 构建阶段结束，正在提取完整执行日志并归档...');

  // 6. 提取完整日志并保存到本地文件
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFilename = `ios-build-${runId}-${timestamp}.log`;
  const logFilePath = path.join(LOG_DIR, logFilename);
  const latestLogPath = path.join(LOG_DIR, 'latest-ios-build.log');

  let fullLog = '';
  try {
    fullLog = runCmd(`gh run view ${runId} --log -R ${REPO}`, { maxBuffer: 1024 * 1024 * 100 });
    fs.writeFileSync(logFilePath, fullLog, 'utf-8');
    fs.writeFileSync(latestLogPath, fullLog, 'utf-8');
    console.log(`📄 完整调试日志已成功保存到: ${logFilePath}`);
  } catch (err) {
    console.warn('⚠️ 读取全量日志时遇到轻微问题，正在尝试抓取失败步骤日志...');
  }

  // 7. 检查构建最终状态
  const runInfoRaw = runCmd(`gh run view ${runId} --json conclusion,status -R ${REPO}`, { ignoreError: true });
  let conclusion = 'unknown';
  if (runInfoRaw) {
    try {
      conclusion = JSON.parse(runInfoRaw).conclusion;
    } catch {}
  }

  if (conclusion === 'success') {
    console.log('\n🎉 ==============================================');
    console.log('   🎉 编译与代码签名成功！正在下载 IPA 产物...');
    console.log('   ==============================================\n');

    try {
      execSync(`gh run download ${runId} -n lattice-archive-ipa --dir "${OUTPUT_DIR}" -R ${REPO}`, { stdio: 'inherit' });
      console.log(`\n💾 IPA 安装包已成功下载至本地目录:`);
      console.log(`   📂 ${OUTPUT_DIR}\n`);
      const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.ipa'));
      if (files.length > 0) {
        files.forEach(f => console.log(`   👉 ${path.join(OUTPUT_DIR, f)}`));
      }
    } catch (e) {
      console.error('⚠️ 下载产物失败，请直接访问下方链接手动下载:', runUrl);
    }
  } else {
    console.log('\n💥 ==============================================');
    console.log(`   ❌ 构建失败 (状态: ${conclusion})`);
    console.log('   ==============================================\n');

    try {
      console.log('🔍 [关键报错与堆栈信息摘录]:\n');
      const failedLog = runCmd(`gh run view ${runId} --log-failed -R ${REPO}`, { ignoreError: true });
      if (failedLog) {
        console.log(failedLog);
      } else {
        console.log('未能提取到单独的 failed step 日志，请查阅完整日志文件。');
      }
    } catch {}

    console.log(`\n👉 详细排查建议:`);
    console.log(`1. 查看本地日志完整堆栈: ${logFilePath}`);
    console.log(`2. 访问 GitHub Actions 控制台: ${runUrl}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
