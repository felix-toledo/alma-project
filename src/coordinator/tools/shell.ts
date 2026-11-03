import { spawn } from 'node:child_process'
import * as z from 'zod/v4'
import { resolveInWorkspace } from './paths'
import { defineTool, truncateMiddle } from './types'

const MAX_OUTPUT_CHARS = 200_000

/** Keys Alma itself reads from the environment: a command the model runs has no business seeing them. */
const APP_SECRET_ENV = new Set(['ANTHROPIC_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'AI_GATEWAY_API_KEY', 'META_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'TELEGRAM_BOT_TOKEN'])

/** The environment for a model-run command: the user's own, minus Alma's provider keys. */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !APP_SECRET_ENV.has(name.toUpperCase())))
  return { ...clean, CI: '1', NO_COLOR: '1' }
}

function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command] }
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-lc', command] }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      process.kill(pid, 'SIGKILL')
    }
  }
}

export const runCommandTool = defineTool({
  name: 'run_command',
  description:
    process.platform === 'win32'
      ? 'Ejecuta un comando de PowerShell en la carpeta de trabajo y devuelve su salida y código de salida. Usalo para builds, tests, git y scripts. No uses comandos interactivos.'
      : 'Ejecuta un comando de shell (bash) en la carpeta de trabajo y devuelve su salida y código de salida. Usalo para builds, tests, git y scripts. No uses comandos interactivos.',
  risk: 'exec',
  schema: z.object({
    command: z.string().min(1).describe('Comando a ejecutar'),
    timeout_seconds: z.number().int().min(1).max(600).optional().describe('Límite de tiempo (por defecto 120)')
  }),
  run({ command, timeout_seconds = 120 }, ctx) {
    const cwd = resolveInWorkspace(ctx.workspace, '.')
    const { file, args } = shellCommand(command)
    return new Promise((resolve) => {
      const child = spawn(file, args, {
        cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: commandEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      let reason = ''
      const append = (chunk: Buffer): void => {
        output += chunk.toString('utf8')
        // Keep memory bounded on runaway output; truncateMiddle trims the final result.
        if (output.length > MAX_OUTPUT_CHARS * 2) output = output.slice(0, MAX_OUTPUT_CHARS) + output.slice(-MAX_OUTPUT_CHARS)
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)

      const stop = (why: string): void => {
        reason = why
        if (child.pid) killTree(child.pid)
      }
      const timer = setTimeout(() => stop(`tiempo agotado tras ${timeout_seconds}s`), timeout_seconds * 1000)
      const onAbort = (): void => stop('cancelado por el usuario')
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      const finish = (summary: string): void => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        resolve(truncateMiddle(`${summary}\n${output.trim() || '(sin salida)'}`))
      }
      child.on('error', (error) => finish(`No se pudo ejecutar el comando: ${error.message}`))
      child.on('close', (code) => finish(reason ? `Proceso detenido: ${reason}.` : `Código de salida: ${code}`))
    })
  }
})
