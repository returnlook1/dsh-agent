/**
 * 发布前的运行时配置检查：用 DSH 自己的 `--dump-config` 组合 profile，
 * 确认三个 Agent Studio 插件确实出现在配置树里（而不是"只写了文件"）。
 *
 * 该检查不启动模型、不联网、不创建会话；子进程 stdout/stderr 用普通文件描述符
 * 捕获（本机沙箱禁止 piped stdio，这是产品无关的环境限制）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { Logger } from '../logger.js'
import type { GatewayConfig } from '../config.js'
import type { MaterializedRuntime } from './RuntimeMaterializer.js'

export interface ProfileValidationResult {
  ok: boolean
  error?: string
  output?: string
}

export interface ProfileValidator {
  validate(materialized: MaterializedRuntime): Promise<ProfileValidationResult>
}

const REQUIRED_PLUGIN_IDS = ['agent-studio-policy', 'agent-studio-tools', 'agent-studio-audit']

export class DshProfileValidator implements ProfileValidator {
  constructor(
    private readonly config: GatewayConfig,
    private readonly logger: Logger,
  ) {}

  async validate(materialized: MaterializedRuntime): Promise<ProfileValidationResult> {
    const logDir = path.join(materialized.workspaceDir, '.studio', 'publish-check')
    fs.mkdirSync(logDir, { recursive: true })
    const stdoutPath = path.join(logDir, 'dump-config.stdout.log')
    const stderrPath = path.join(logDir, 'dump-config.stderr.log')

    let outFd: number | undefined
    let errFd: number | undefined
    try {
      outFd = fs.openSync(stdoutPath, 'w')
      errFd = fs.openSync(stderrPath, 'w')
      // 环境从零构造：绝不继承开发者个人的 DSH_HOME / DSH_PROFILE（安全红线）。
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '',
        PATHEXT: process.env.PATHEXT ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? '',
        WINDIR: process.env.WINDIR ?? '',
        COMSPEC: process.env.COMSPEC ?? '',
        TEMP: path.join(materialized.homeDir, 'tmp'),
        TMP: path.join(materialized.homeDir, 'tmp'),
        DSH_HOME: materialized.homeDir,
        DSH_TELEMETRY_DISABLED: '1',
      }
      for (const key of Object.keys(env)) {
        if (env[key] === '') delete env[key]
      }
      const result = spawnSync(
        process.execPath,
        [this.config.dshBin, '--profile', materialized.profileName, '--dump-config'],
        {
          cwd: materialized.workspaceDir,
          env,
          stdio: ['ignore', outFd, errFd],
          timeout: 30_000,
          windowsHide: true,
        },
      )
      const stdout = fs.readFileSync(stdoutPath, 'utf8')
      const stderr = fs.readFileSync(stderrPath, 'utf8')
      if (result.error !== undefined) {
        return { ok: false, error: `无法执行 --dump-config: ${result.error.message}`, output: stderr }
      }
      if (result.status !== 0) {
        return {
          ok: false,
          error: `--dump-config 退出码 ${String(result.status)}: ${stderr.slice(0, 2000)}`,
          output: stdout,
        }
      }
      const missing = REQUIRED_PLUGIN_IDS.filter((id) => !stdout.includes(id))
      if (missing.length > 0) {
        return {
          ok: false,
          error: `--dump-config 未包含必需插件: ${missing.join(', ')}`,
          output: stdout,
        }
      }
      if (!stdout.includes('system-prompt')) {
        return { ok: false, error: '--dump-config 未包含 system-prompt 行', output: stdout }
      }
      return { ok: true, output: stdout.slice(0, 2000) }
    } catch (error) {
      this.logger.warn('profile validation failed', { runtimeId: materialized.runtimeId, error })
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (outFd !== undefined) {
        try {
          fs.closeSync(outFd)
        } catch {
          // ignore
        }
      }
      if (errFd !== undefined) {
        try {
          fs.closeSync(errFd)
        } catch {
          // ignore
        }
      }
    }
  }
}
